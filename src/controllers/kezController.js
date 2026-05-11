const { query } = require("../config/postgres");
const { runMealVision } = require("../services/kez/vision");
const { resolveLabelToFood, overallConfidence } = require("../services/kez/foodResolver");
const { scaleFoodRow, sumMacros, finalizeTotals } = require("../services/kez/macros");
const {
  classifyLoadFromPrescreen,
  computeDailyEER,
  mealFractionForSlot,
  mealTargetBand,
  buildVsTargets,
  ageFromDob,
} = require("../services/kez/targets");
const {
  assembleMealAnalysisSystemPrompt,
  mealAnalysisUserPrompt,
  buildBrainInjection,
  v3CarouselUserPrompt,
} = require("../services/kez/composer");
const { MEAL_ANALYSIS_TASK_SUFFIX } = require("../services/kez/masterPrompt");
const { callLlmText, extractJsonObject } = require("../services/kez/llm");
const {
  validateMealFeedback,
  validateMealAnalysisDraft,
  applyHardStopTemplates,
  stripHealthyUnhealthy,
} = require("../services/kez/validators");
const { scoreMealCandidate, mealExcludedByDislikes } = require("../services/kez/carouselScorer");
const { formatCarouselMacros, kjToKcal } = require("../services/kez/format");
const { resolveMealImageUrlForVision } = require("../services/kez/missionImageUrl");

/** Prepare nested values so Postgres accepts json/jsonb (avoids BigInt / odd pg types breaking JSON binding). */
function valueForPgJson(value, depth = 0) {
  if (depth > 48) return null;
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => valueForPgJson(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = valueForPgJson(value[k], depth + 1);
    }
    return out;
  }
  return String(value);
}

/** String bound as text and cast server-side → avoids driver oddities with composite JSON. */
function jsonbString(value) {
  return JSON.stringify(valueForPgJson(value));
}

function slotCategory(slotLabelOrId) {
  const s = String(slotLabelOrId || "");
  if (/breakfast/i.test(s)) return "Breakfast";
  if (/lunch/i.test(s)) return "Lunch";
  if (/dinner/i.test(s)) return "Dinner";
  if (/training/i.test(s)) return "Training";
  if (/game/i.test(s)) return "Game Day";
  return s || "Meal";
}

function dislikeList(prescreen) {
  const raw = prescreen?.dislike_foods || prescreen?.dislikeFoods || "";
  return String(raw)
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeLoadDay(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s === "lower" || s === "low") return "Lower";
  if (s === "moderate" || s === "medium") return "Moderate";
  if (s === "high") return "High";
  return null;
}

function selectedFoodPreferenceIds(selections) {
  const ids = new Set();
  let source = selections;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      source = null;
    }
  }
  if (!source || typeof source !== "object") return [];
  for (const value of Object.values(source)) {
    const list = Array.isArray(value) ? value : [value];
    for (const raw of list) {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0) ids.add(n);
    }
  }
  return [...ids].slice(0, 40);
}

async function likedFoodsForStudent(studentId) {
  try {
    const { rows } = await query(
      `SELECT selections
       FROM public.student_food_preferences
       WHERE student_id = $1
       LIMIT 1`,
      [studentId],
    );
    const ids = selectedFoodPreferenceIds(rows?.[0]?.selections || {});
    if (!ids.length) return [];

    const { rows: itemRows } = await query(
      `SELECT title
       FROM public.items
       WHERE id = ANY($1::bigint[])
       ORDER BY title ASC`,
      [ids],
    );
    return (itemRows || []).map((r) => String(r.title || "").trim()).filter(Boolean).slice(0, 25);
  } catch (e) {
    console.error("likedFoodsForStudent", e);
    return [];
  }
}

function safeJsonObject(raw) {
  const parsed = JSON.parse(extractJsonObject(raw) || raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function structuredMealPrompt({ firstName, factsJson }) {
  return [
    "Current task: MEAL_PHOTO_ANALYSIS_STRUCTURED",
    `Create the structured analysis first for ${firstName || "the athlete"}.`,
    "Use only the FACTS block. Do not invent numeric values.",
    "Return VALID JSON ONLY with this exact shape:",
    `{"food_group_summary":"string","carbohydrate_assessment":"string","protein_timing_assessment":"string","micronutrient_gap":"string","improvements":["string","string"],"positive":"string"}`,
    "Rules:",
    "- carbohydrate_assessment must assess carb adequacy against load_day_for_this_photo.",
    "- protein_timing_assessment must assess quantity and timing for this specific slot_label.",
    "- micronutrient_gap must flag a likely gap from the image/description, never diagnose.",
    "- improvements must contain 2 or 3 specific actions and use liked_foods when useful.",
    "- positive must be genuine and specific.",
    "",
    "FACTS (do not change numbers):",
    factsJson,
  ].join("\n");
}

function composeMealFeedbackPrompt({ firstName, factsJson, draftJson }) {
  return [
    MEAL_ANALYSIS_TASK_SUFFIX.replace(/\[FirstName\]/g, firstName || "there"),
    "",
    "Use this structured analysis. Include every field in natural coach-style prose, with 2 to 3 specific actions, then end with the positive.",
    "No bullets. Under 150 words. Maximum 3 short paragraphs.",
    "",
    "STRUCTURED ANALYSIS:",
    draftJson,
    "",
    "FACTS (do not change numbers):",
    factsJson,
  ].join("\n");
}

function fallbackMealFeedback(firstName, draft) {
  const improvements = Array.isArray(draft?.improvements) ? draft.improvements.filter(Boolean).slice(0, 3) : [];
  return [
    `Hey ${firstName}. ${draft?.carbohydrate_assessment || "You need a closer carb fuel check against today's training load."} ${draft?.protein_timing_assessment || "You need tighter protein timing for this meal."}`,
    `${draft?.micronutrient_gap || "The likely micronutrient gap is colour from fruit or vegetables."} ${improvements.join(" ")}`,
    `${draft?.positive || "You have given yourself something clear to build on with this meal."}`,
  ].join("\n\n");
}

function mealToCarouselShape(meal, mealFoods, source) {
  const foods = (mealFoods || []).map((f) => ({
    food_name: f.food_name,
    weight_grams: Number(f.weight_g) || 0,
    energy_kj: Number(f.energy_kj) || 0,
    protein_g: Number(f.protein_g) || 0,
    carb_g: Number(f.carb_g) || 0,
    fat_g: Number(f.fat_g) || 0,
  }));
  let energy_kj = Number(meal.energy_kj) || 0;
  let protein_g = Number(meal.protein_g) || 0;
  let carb_g = Number(meal.carb_g) || 0;
  let fat_g = Number(meal.fat_g) || 0;
  if (!energy_kj && foods.length) {
    energy_kj = foods.reduce((s, x) => s + x.energy_kj, 0);
    protein_g = foods.reduce((s, x) => s + x.protein_g, 0);
    carb_g = foods.reduce((s, x) => s + x.carb_g, 0);
    fat_g = foods.reduce((s, x) => s + x.fat_g, 0);
  }
  return {
    id: meal.id,
    title: meal.title,
    description: meal.description || "",
    blueprintNote: meal.blueprint_note || "",
    image_prompt: meal.image_prompt || "",
    image_url: meal.image_url || "",
    source: source || "database",
    unverified_foods: [],
    foods,
    totals: { energy_kj, protein_g, carb_g, fat_g },
  };
}

async function mealAnalysisGet(req, res) {
  try {
    const student_id = req.query.student_id;
    const mission_id = req.query.mission_id;
    if (!student_id || !mission_id) {
      return res.status(400).json({ error: "student_id and mission_id required" });
    }
    const { rows: data } = await query(
      `SELECT * FROM public.meal_analysis
       WHERE student_id = $1 AND mission_id = $2
       ORDER BY created_at DESC
       LIMIT 40`,
      [student_id, mission_id],
    );
    const latestByKey = {};
    for (const row of data || []) {
      const k = `${row.slot_id}:${row.version}`;
      if (!latestByKey[k]) latestByKey[k] = row;
    }
    res.json({ analyses: Object.values(latestByKey) });
  } catch (e) {
    console.error("mealAnalysisGet", e);
    res.status(500).json({ error: e.message || "Kez unavailable" });
  }
}

async function mealAnalysisPost(req, res) {
  try {
    const {
      student_id,
      mission_id,
      slot_id,
      image_url,
      meal_text = "",
      slot_label,
      load_day,
      training_load_day,
    } = req.body || {};
    const version = req.body?.version === "v2" ? "v2" : "v1";

    if (!student_id || !mission_id || !slot_id) {
      return res.status(400).json({ error: "student_id, mission_id, slot_id required" });
    }

    const resolvedImageUrl = await resolveMealImageUrlForVision({
      student_id,
      mission_id,
      slot_id,
      version,
      client_image_url: image_url,
    });
    const visionOk =
      typeof resolvedImageUrl === "string" &&
      (resolvedImageUrl.startsWith("https://") || resolvedImageUrl.startsWith("data:image/"));
    if (!visionOk) {
      return res.status(400).json({
        error:
          "No usable meal image URL. Use the hosted HTTPS URL saved after upload (missions), or ensure the client sends a data: URL. Dashboard should prefer `url` over `localUrl`.",
        code: "BAD_IMAGE_URL",
      });
    }

    const lbl = slot_label || slot_id;

    const [{ rows: stRows }, { rows: prescreenRows }] = await Promise.all([
      query(`SELECT id, full_name, first_name FROM public.students WHERE id = $1`, [student_id]),
      query(`SELECT * FROM public.prescreen WHERE student_id = $1`, [student_id]),
    ]);

    const studentRow = stRows?.[0];
    if (!studentRow) return res.status(404).json({ error: "Student not found" });

    const firstName =
      studentRow.first_name ||
      String(studentRow.full_name || "Athlete")
        .trim()
        .split(/\s+/)[0] ||
      "Athlete";

    const [{ rows: eerRows }, likedFoods] = await Promise.all([
      query(`SELECT * FROM public.eer_config WHERE id = 1`),
      likedFoodsForStudent(student_id),
    ]);
    const eerRow = eerRows?.[0];
    const eerConfig = eerRow
      ? {
          pal: eerRow.pal,
          carb_gkg: eerRow.carb_gkg,
          protein_gkg: eerRow.protein_gkg,
          fat_gday: eerRow.fat_gday,
        }
      : {};

    const prescreenRow = prescreenRows?.[0];
    const prescreen = prescreenRow || {};
    const inferredLoadDay = classifyLoadFromPrescreen(prescreen);
    const explicitLoadDay = normalizeLoadDay(load_day || training_load_day);
    const loadDay = explicitLoadDay || inferredLoadDay;
    const loadDaySource = explicitLoadDay ? "photo" : "prescreen_inferred";
    const daily = computeDailyEER(prescreen, loadDay, eerConfig);
    const fraction = mealFractionForSlot(lbl);
    const targetBand = daily ? mealTargetBand(daily, fraction) : null;
    const category = slotCategory(lbl);

    const vision = await runMealVision({
      imageUrl: resolvedImageUrl,
      mealText: meal_text,
      mealCategory: category,
    });

    const resolved = [];
    for (const it of vision.items) {
      const grams = Number(it.grams_estimate) || 100;
      const line = await resolveLabelToFood(it.label || "food", grams, Number(it.confidence) || 0.6, true);
      resolved.push({
        label: it.label,
        portion_phrase: it.portion_phrase,
        ...line,
      });
    }

    const macroLines = [];
    for (const r of resolved) {
      if (r.food_row && r.grams_estimate) macroLines.push(scaleFoodRow(r.food_row, r.grams_estimate));
    }
    const summed = sumMacros(macroLines);
    const macro_totals = finalizeTotals(summed);
    const vs_targets = targetBand ? buildVsTargets(macro_totals, targetBand) : {};

    const flags = [];
    const conf = overallConfidence(resolved);
    let needs_correction = conf < 0.45 || vision.items.length === 0;
    if (resolved.some((r) => !r.food_id)) {
      needs_correction = true;
      flags.push("unresolved_foods");
    }

    const brain = await buildBrainInjection(
      `Meal analysis ${mission_id} ${slot_id} athlete ${firstName} ${category}`,
    );
    const systemPrompt = assembleMealAnalysisSystemPrompt(brain);

    const facts = {
      firstName,
      age: ageFromDob(prescreen.dob),
      sex: prescreen.sex || "Male",
      weight_kg: prescreen.weight,
      version,
      mission_id,
      slot_id,
      slot_label: lbl,
      meal_text,
      load_day_for_this_photo: loadDay,
      load_day_source: loadDaySource,
      prescreen_inferred_load_day: inferredLoadDay,
      meal_category: category,
      liked_foods: likedFoods,
      dislike_foods: prescreen.dislike_foods || prescreen.dislikeFoods || "",
      dietary_requirements: prescreen.dietary_reqs || prescreen.dietaryReqs || "",
      daily_eer_kcal: daily ? [daily.eerLow, daily.eerHigh] : null,
      meal_target_band: targetBand,
      estimated_meal_macros: macro_totals,
      vs_targets,
      resolved_foods: resolved.map((r) => ({
        label: r.label,
        matched_name: r.food_row?.food_name || null,
        grams: r.grams_estimate,
      })),
      vision_uncertainties: vision.uncertainties,
    };

    const factsJson = JSON.stringify(facts, null, 2);
    let structuredDraft = null;
    let structuredValid = { ok: false, issues: ["not_run"] };
    try {
      const rawStructured = await callLlmText(structuredMealPrompt({ firstName, factsJson }), {
        system: systemPrompt,
        json: true,
      });
      structuredDraft = safeJsonObject(rawStructured);
      structuredValid = validateMealAnalysisDraft(structuredDraft);
    } catch {
      structuredValid = { ok: false, issues: ["structured_model_error"] };
    }

    if (!structuredValid.ok) {
      needs_correction = true;
      flags.push(...structuredValid.issues.map((issue) => `structured_${issue}`));
    }

    const userPrompt = structuredValid.ok
      ? composeMealFeedbackPrompt({
          firstName,
          factsJson,
          draftJson: JSON.stringify(structuredDraft, null, 2),
        })
      : mealAnalysisUserPrompt({
          firstName,
          factsJson,
        });

    let feedback_text = "";
    try {
      feedback_text = await callLlmText(userPrompt, { system: systemPrompt, json: false });
    } catch {
      feedback_text = `Hey ${firstName}. I couldn't finish this analysis right now — try again in a moment.\n\n[FLAG:UNCERTAIN] — model error`;
      flags.push("model_error");
      needs_correction = true;
    }

    const stopped = applyHardStopTemplates(feedback_text, { firstName });
    feedback_text = stopped.text;
    if (stopped.flagged) {
      needs_correction = true;
      flags.push("hard_stop_medical");
    }

    feedback_text = stripHealthyUnhealthy(feedback_text);

    let valid = validateMealFeedback(feedback_text, { firstName, mealAnalysis: true });
    if (!valid.ok) {
      try {
        feedback_text = await callLlmText(
          `${userPrompt}\n\nPrevious draft failed checks: ${valid.issues.join(", ")}. Fix and keep FACTS unchanged.`,
          { system: systemPrompt, json: false },
        );
        feedback_text = stripHealthyUnhealthy(feedback_text);
        valid = validateMealFeedback(feedback_text, { firstName, mealAnalysis: true });
      } catch {
        /* keep */
      }
    }
    if (!valid.ok && structuredValid.ok) {
      feedback_text = stripHealthyUnhealthy(fallbackMealFeedback(firstName, structuredDraft));
      valid = validateMealFeedback(feedback_text, { firstName, mealAnalysis: true });
    }
    if (!valid.ok) {
      needs_correction = true;
      flags.push("validator_failed");
    }

    const resolvedForDb = resolved.map((r) => ({
      label: r.label,
      portion_phrase: r.portion_phrase,
      food_id: r.food_id,
      grams_estimate: r.grams_estimate,
      vision_confidence: r.vision_confidence,
      resolver_score: r.resolver_score,
      food_name: r.food_row?.food_name || null,
      food_row: r.food_row
        ? {
            id: r.food_row.id,
            food_name: r.food_row.food_name,
            serving_label: r.food_row.serving_label,
            weight_g: r.food_row.weight_g,
            protein_g: r.food_row.protein_g,
            carb_g: r.food_row.carb_g,
            fat_g: r.food_row.fat_g,
            energy_kj: r.food_row.energy_kj,
            energy_kcal: r.food_row.energy_kcal,
          }
        : null,
    }));

    const vision_raw = { items: vision.items, uncertainties: vision.uncertainties, raw: vision.raw };
    const model_meta = {
      route: "meal-analysis",
      load_day_source: loadDaySource,
      slot_label: lbl,
      liked_foods: likedFoods,
      structured_draft: structuredDraft,
      structured_valid: structuredValid,
    };

    const { rows: insRows } = await query(
      `INSERT INTO public.meal_analysis (
        student_id, mission_id, slot_id, version, image_url, meal_text,
        load_day, category, vision_raw, resolved_items, macro_totals, target_band, vs_targets,
        feedback_text, feedback_status, confidence, needs_correction, flags, model_meta
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
        $14, $15, $16, $17, $18, $19::jsonb
      )
      RETURNING id`,
      [
        student_id,
        mission_id,
        slot_id,
        version,
        resolvedImageUrl,
        meal_text,
        loadDay,
        category,
        jsonbString(vision_raw),
        jsonbString(resolvedForDb),
        jsonbString(macro_totals),
        jsonbString(targetBand),
        jsonbString(vs_targets),
        feedback_text,
        "draft",
        conf,
        needs_correction,
        flags,
        jsonbString(model_meta),
      ],
    );

    const inserted = insRows?.[0];
    if (!inserted?.id) {
      return res.status(500).json({ error: "Failed to save analysis" });
    }

    res.json({
      analysis_id: inserted.id,
      feedback_text,
      macro_totals,
      target_band: targetBand,
      vs_targets,
      resolved_items: resolvedForDb,
      confidence: conf,
      needs_correction,
      flags,
    });
  } catch (e) {
    console.error("mealAnalysisPost", e);
    res.status(500).json({ error: e.message || "Kez unavailable" });
  }
}

async function loadMealsWithFoodsPg(categoryExact) {
  const useCat = categoryExact ? categoryExact.trim() : null;
  const { rows } = await query(
    `SELECT m.*,
       COALESCE(
         json_agg(
           json_build_object(
             'id', mf.id,
             'meal_id', mf.meal_id,
             'food_id', mf.food_id,
             'food_name', mf.food_name,
             'weight_g', mf.weight_g,
             'energy_kj', mf.energy_kj,
             'protein_g', mf.protein_g,
             'carb_g', mf.carb_g,
             'fat_g', mf.fat_g,
             'sort_order', mf.sort_order
           ) ORDER BY mf.sort_order NULLS LAST
         ) FILTER (WHERE mf.id IS NOT NULL),
         '[]'::json
       ) AS meal_foods
    FROM public.meals m
    LEFT JOIN public.meal_foods mf ON mf.meal_id = m.id
    WHERE m.is_active = true
      AND (m.is_verified IS NULL OR m.is_verified = true)
      AND ($1::text IS NULL OR m.category ILIKE $1)
    GROUP BY m.id`,
    [useCat],
  );
  return rows || [];
}

async function mealCarouselPost(req, res) {
  try {
    const {
      student_id,
      mission_id,
      slot_id,
      based_on: basedRaw,
      meal_analysis_id,
      slot_label,
      liked_foods: likedFoodsBody,
    } = req.body || {};
    let target_count = Number(req.body?.target_count) || 5;
    const based_on = basedRaw === "v2" ? "v2" : "v1";
    const liked_foods = Array.isArray(likedFoodsBody) ? likedFoodsBody : [];
    const lbl = slot_label || slot_id;

    if (!student_id || !mission_id || !slot_id) {
      return res.status(400).json({ error: "student_id, mission_id, slot_id required" });
    }

    let analysis = null;
    if (meal_analysis_id) {
      const { rows } = await query(`SELECT * FROM public.meal_analysis WHERE id = $1`, [meal_analysis_id]);
      analysis = rows?.[0];
      if (!analysis) return res.status(404).json({ error: "Analysis not found" });
    } else {
      const { rows } = await query(
        `SELECT * FROM public.meal_analysis
         WHERE student_id = $1 AND mission_id = $2 AND slot_id = $3 AND version = $4
         ORDER BY created_at DESC
         LIMIT 1`,
        [student_id, mission_id, slot_id, based_on],
      );
      analysis = rows?.[0] || null;
    }

    if (!analysis) {
      return res.status(404).json({
        error: "No meal analysis for this slot — run meal analysis first.",
        code: "NO_ANALYSIS",
      });
    }

    const [{ rows: prescreenRows }, { rows: studentRows }, { rows: eerRows }] = await Promise.all([
      query(`SELECT * FROM public.prescreen WHERE student_id = $1`, [student_id]),
      query(`SELECT id, full_name, first_name FROM public.students WHERE id = $1`, [student_id]),
      query(`SELECT * FROM public.eer_config WHERE id = 1`),
    ]);

    const prescreenRow = prescreenRows?.[0];
    const studentRow = studentRows?.[0];
    const eerRow = eerRows?.[0];
    const prescreen = prescreenRow || {};

    const firstName =
      studentRow?.first_name ||
      String(studentRow?.full_name || "Athlete")
        .trim()
        .split(/\s+/)[0] ||
      "Athlete";

    const eerConfig = eerRow
      ? {
          pal: eerRow.pal,
          carb_gkg: eerRow.carb_gkg,
          protein_gkg: eerRow.protein_gkg,
          fat_gday: eerRow.fat_gday,
        }
      : {};

    const carousel_settings = eerRow?.carousel_settings;
    if (carousel_settings?.suggestion_count != null) {
      target_count = Number(carousel_settings.suggestion_count) || target_count;
    }

    const loadDay = classifyLoadFromPrescreen(prescreen);
    const daily = computeDailyEER(prescreen, loadDay, eerConfig);
    const fraction = mealFractionForSlot(lbl);
    const targetBand = daily ? mealTargetBand(daily, fraction) : null;

    const category = analysis?.category || "";
    const dislikes = dislikeList(prescreen);
    const likedTokens = liked_foods.map((s) => String(s).toLowerCase());

    const resolvedItems = analysis?.resolved_items || [];
    const resolvedNameSet = new Set(
      resolvedItems.map((r) => r.food_name || r.food_row?.food_name || r.label).filter(Boolean),
    );
    const macroTotals = analysis?.macro_totals || {};

    let allMeals = await loadMealsWithFoodsPg(category || null);
    if (!allMeals.length && category) {
      allMeals = await loadMealsWithFoodsPg(null);
    }

    const candidates = allMeals.filter((m) => {
      const mfoods = m.meal_foods || [];
      return !mealExcludedByDislikes(mfoods, dislikes);
    });

    const scored = candidates
      .map((m) => ({
        meal: m,
        score: scoreMealCandidate(m, {
          resolvedNameSet,
          macroTotals,
          targetBand,
          likedTokens,
        }),
      }))
      .sort((a, b) => b.score - a.score);

    const verifiedCards = scored.slice(0, target_count).map((s) =>
      mealToCarouselShape(s.meal, s.meal.meal_foods, "database"),
    );

    let suggestions = [...verifiedCards];
    const need = Math.max(0, target_count - suggestions.length);

    const verifiedSummary = verifiedCards
      .map(
        (c) =>
          `- ${c.title}: P ${c.totals.protein_g}g C ${c.totals.carb_g}g F ${c.totals.fat_g}g ${c.totals.energy_kj}kJ`,
      )
      .join("\n");

    if (need > 0) {
      const brain = await buildBrainInjection(`V3 carousel ${mission_id} ${slot_id} ${firstName}`);
      const systemPrompt = assembleMealAnalysisSystemPrompt(brain);
      const analysisFacts = {
        firstName,
        mission_id,
        slot_id,
        slot_label: lbl,
        based_on,
        target_band: targetBand,
        analysis_macros: macroTotals,
        dislikes,
        liked_foods,
        need_count: Math.min(2, need),
      };
      const userPrompt = v3CarouselUserPrompt({
        firstName,
        factsJson: JSON.stringify(analysisFacts, null, 2),
        verifiedMealsSummary: verifiedSummary || "(no close verified matches in database)",
      });

      try {
        const raw = await callLlmText(
          `${userPrompt}\n\nGenerate exactly ${Math.min(2, need)} additional meals as JSON.`,
          { system: systemPrompt, json: true },
        );
        const jsonStr = extractJsonObject(raw) || raw;
        const parsed = JSON.parse(jsonStr);
        const extra = Array.isArray(parsed.meals) ? parsed.meals : [];
        for (const m of extra.slice(0, Math.min(2, need))) {
          const card = {
            title: m.title,
            description: m.description || "",
            blueprintNote: m.blueprintNote || "",
            image_prompt: m.image_prompt || "",
            image_url: m.image_url || "",
            source: m.source || "kez_generated",
            unverified_foods: Array.isArray(m.unverified_foods) ? m.unverified_foods : [],
            foods: (m.foods || []).map((f) => ({
              food_name: f.food_name,
              weight_grams: Number(f.weight_grams ?? f.weight_g) || 0,
              energy_kj: Number(f.energy_kj) || 0,
              protein_g: Number(f.protein_g) || 0,
              carb_g: Number(f.carb_g) || 0,
              fat_g: Number(f.fat_g) || 0,
            })),
            totals: m.totals || { energy_kj: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
          };
          if (!card.totals.energy_kj && card.foods.length) {
            card.totals.energy_kj = card.foods.reduce((s, f) => s + f.energy_kj, 0);
            card.totals.protein_g = card.foods.reduce((s, f) => s + f.protein_g, 0);
            card.totals.carb_g = card.foods.reduce((s, f) => s + f.carb_g, 0);
            card.totals.fat_g = card.foods.reduce((s, f) => s + f.fat_g, 0);
          }
          suggestions.push(card);

          await query(
            `INSERT INTO public.meal_carousel_draft (analysis_id, student_id, mission_id, slot_id, payload, status)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
            [analysis?.id || null, student_id, mission_id, slot_id, card, "pending"],
          );
        }
      } catch (e) {
        console.error("carousel gap fill", e);
      }
    }

    const formatted_lines = suggestions.map((s) => {
      const kj = Number(s.totals.energy_kj) || 0;
      const kcal = kj > 0 ? kjToKcal(kj) : 0;
      return formatCarouselMacros({
        p: s.totals.protein_g,
        c: s.totals.carb_g,
        f: s.totals.fat_g,
        kcal,
        kj,
      });
    });

    res.json({ suggestions, formatted_lines, analysis_id: analysis?.id || null });
  } catch (e) {
    console.error("mealCarouselPost", e);
    res.status(500).json({ error: e.message || "Kez unavailable" });
  }
}

async function mealCarouselDraftsGet(req, res) {
  try {
    const status = req.query.status || "pending";
    const { rows } = await query(
      `SELECT d.*,
         json_build_object('full_name', s.full_name, 'first_name', s.first_name) AS students
       FROM public.meal_carousel_draft d
       LEFT JOIN public.students s ON s.id = d.student_id
       WHERE d.status = $1
       ORDER BY d.created_at DESC
       LIMIT 50`,
      [status],
    );
    res.json({ drafts: rows || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

async function mealCarouselDraftsPost(req, res) {
  try {
    const draft_id = req.body?.draft_id;
    const meal_category = req.body?.meal_category || null;
    if (!draft_id) return res.status(400).json({ error: "draft_id required" });

    const { rows: drRows } = await query(`SELECT * FROM public.meal_carousel_draft WHERE id = $1`, [draft_id]);
    const draft = drRows?.[0];
    if (!draft) return res.status(404).json({ error: "Draft not found" });

    const payload = draft.payload || {};
    const foods = Array.isArray(payload.foods) ? payload.foods : [];
    const totals = payload.totals || {};
    const energy_kj = Number(totals.energy_kj) || 0;
    const protein_g = Number(totals.protein_g) || 0;
    const carb_g = Number(totals.carb_g) || 0;
    const fat_g = Number(totals.fat_g) || 0;
    const energy_kcal = energy_kj > 0 ? energy_kj / 4.184 : null;

    const { rows: mealRows } = await query(
      `INSERT INTO public.meals (
        title, description, blueprint_note, image_prompt, image_url, category,
        energy_kj, energy_kcal, protein_g, carb_g, fat_g, source, is_verified, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, true)
      RETURNING id`,
      [
        payload.title || "Kez draft meal",
        payload.description || "",
        payload.blueprintNote || "",
        payload.image_prompt || null,
        payload.image_url || null,
        meal_category,
        energy_kj,
        energy_kcal,
        protein_g,
        carb_g,
        fat_g,
        "kez_generated",
      ],
    );

    const meal = mealRows?.[0];
    if (!meal?.id) return res.status(500).json({ error: "Meal insert failed" });

    for (let i = 0; i < foods.length; i++) {
      const f = foods[i];
      await query(
        `INSERT INTO public.meal_foods (
           meal_id, food_name, weight_g, energy_kj, protein_g, carb_g, fat_g, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          meal.id,
          f.food_name || "Ingredient",
          f.weight_grams ?? f.weight_g ?? null,
          f.energy_kj ?? null,
          f.protein_g ?? null,
          f.carb_g ?? null,
          f.fat_g ?? null,
          i,
        ],
      );
    }

    await query(
      `UPDATE public.meal_carousel_draft
       SET status = 'approved', created_meal_id = $2, updated_at = now()
       WHERE id = $1`,
      [draft_id, meal.id],
    );

    res.json({ ok: true, meal_id: meal.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  mealAnalysisGet,
  mealAnalysisPost,
  mealCarouselPost,
  mealCarouselDraftsGet,
  mealCarouselDraftsPost,
};
