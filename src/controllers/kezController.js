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
const { formatCarouselMacros } = require("../services/kez/format");
const { resolveMealImageUrlForVision } = require("../services/kez/missionImageUrl");
const { uploadRemoteUrl } = require("../services/uploadService");
const mealsService = require("../services/mealsService");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "dall-e-3";

// Build the production image prompt for a V3 carousel card. Keeps tone /
// styling consistent between auto-generated images (carousel) and re-saved
// images (POST /save-suggestion).
function buildMealImagePrompt({ title, description, image_prompt }) {
  const seed =
    image_prompt ||
    `Bright, appetising overhead photo of ${title || "an athlete meal"}. ${description || ""}`.trim();
  return `${seed}. Plate on light wood, natural daylight, performance nutrition style. No text, no logos.`;
}

// Generate an image for a V3 suggestion via OpenAI's image API. Returns the
// remote URL (Cloudinary upload happens in the calling endpoint).
async function generateMealImageUrl(prompt) {
  if (!OPENAI_API_KEY || !prompt) return null;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      n: 1,
      size: "1024x1024",
      response_format: "url",
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`OpenAI images ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.data?.[0]?.url || null;
}

// Generate an image, push it straight to Cloudinary, and return the
// permanent `secure_url`. Used by both the carousel pre-generation and the
// save-to-DB endpoint so they stay in lock-step.
//
// Resolves to `null` (never throws) on any failure — callers should treat
// `null` as "no image, fall back to placeholder" without aborting their flow.
async function generateAndUploadMealImage(card) {
  if (!OPENAI_API_KEY) return null;
  try {
    const prompt = buildMealImagePrompt(card);
    const remoteUrl = await generateMealImageUrl(prompt);
    if (!remoteUrl) return null;
    const uploaded = await uploadRemoteUrl(remoteUrl, { folder: "meals" });
    return uploaded?.url || null;
  } catch (e) {
    console.error("generateAndUploadMealImage", e.message || e);
    return null;
  }
}

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

// One-line slot-aware guidance the model can lean on. Keep these in sync with
// the Slot guidance block in `MEAL_ANALYSIS_TASK_SUFFIX` (masterPrompt.js).
function slotGuidance(category) {
  switch (category) {
    case "Breakfast":
      return "Breakfast: emphasise the protein dose vs daily target — most common gap in young athletes.";
    case "Lunch":
      return "Lunch: mid-day glycogen top-up; consider afternoon training proximity.";
    case "Dinner":
      return "Dinner: recovery + overnight repair (protein dose + slow carbs).";
    case "Training":
      return "Training meal: carb timing relative to the session; quick-digesting protein.";
    case "Game Day":
      return "Game Day: high-CHO availability, low-fibre close to kick-off, hydration cues (fluid + sodium) if visible or written.";
    default:
      return "Treat this as a general meal; assess protein dose, carb fit to load, and one micronutrient gap.";
  }
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
    "Rules — follow Kerry's 6-point meal photo analysis protocol:",
    "- food_group_summary: identify the food groups visible (image + meal_text) and estimate portions.",
    "- carbohydrate_assessment: assess CARB ADEQUACY against load_day_for_this_photo. Reference the daily/meal targets in FACTS; do not give a generic answer.",
    "- protein_timing_assessment: assess PROTEIN QUANTITY AND TIMING for this specific slot_label (per FACTS.slot_guidance). Do NOT default to the daily total.",
    "- micronutrient_gap: flag ONE likely gap drawn from BOTH the image and meal_text. One only, unless clearly critical. Never diagnose.",
    "- improvements: 2 or 3 specific, actionable changes. Build each one around a food in FACTS.liked_foods when possible. NEVER remove a food the athlete likes — improve it (e.g. avo on toast gets better eggs and portion, not yoghurt).",
    "- positive: ONE genuine, specific positive — always find something to build on. 'Great job!' is banned.",
    "- Adapt the tone to FACTS.version: 'v1' = first nudge; 'v2' = tune the change.",
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
      weight_kg: prescreen.weight_kg ?? prescreen.weight ?? null,
      height_cm: prescreen.height_cm ?? prescreen.height ?? null,
      version,
      mission_id,
      slot_id,
      slot_label: lbl,
      slot_guidance: slotGuidance(category),
      meal_text,
      load_day_for_this_photo: loadDay,
      load_day_source: loadDaySource,
      prescreen_inferred_load_day: inferredLoadDay,
      meal_category: category,
      liked_foods: likedFoods,
      dislike_foods: prescreen.dislike_foods || prescreen.dislikeFoods || "",
      dietary_requirements: prescreen.dietary_reqs || prescreen.dietaryReqs || "",
      daily_eer_kcal: daily ? [daily.eerLow, daily.eerHigh] : null,
      daily_protein_g: daily?.protein || null,
      daily_carb_g: daily?.carb || null,
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

    let valid = validateMealFeedback(feedback_text, { firstName, mealAnalysis: true, slotLabel: lbl });
    // `missing_slot_alignment` is a soft warning — we record it but don't
    // hard-fail or retry just for that.
    const blockingIssues = (issues) =>
      (issues || []).filter((i) => i !== "missing_slot_alignment");

    if (blockingIssues(valid.issues).length) {
      try {
        feedback_text = await callLlmText(
          `${userPrompt}\n\nPrevious draft failed checks: ${valid.issues.join(", ")}. Fix and keep FACTS unchanged. The meal is for slot: ${lbl}.`,
          { system: systemPrompt, json: false },
        );
        feedback_text = stripHealthyUnhealthy(feedback_text);
        valid = validateMealFeedback(feedback_text, { firstName, mealAnalysis: true, slotLabel: lbl });
      } catch {
        /* keep */
      }
    }
    if (blockingIssues(valid.issues).length && structuredValid.ok) {
      feedback_text = stripHealthyUnhealthy(fallbackMealFeedback(firstName, structuredDraft));
      valid = validateMealFeedback(feedback_text, { firstName, mealAnalysis: true, slotLabel: lbl });
    }
    if (blockingIssues(valid.issues).length) {
      needs_correction = true;
      flags.push("validator_failed");
    } else if ((valid.issues || []).includes("missing_slot_alignment")) {
      // Don't block but surface the soft warning for review.
      flags.push("soft_missing_slot_alignment");
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

// Load verified meals from the legacy stack (`public.meals` + `public.item_meals` +
// `public.items` + `public.meal_category` + `public.food_categories`).
//
// `categoryExact` matches by `food_categories.name` exactly (case-insensitive).
// When supplied, only meals tagged with at least one of those categories are
// returned. Falls back to all meals if `categoryExact` is null.
async function loadLegacyMealsWithFoods(categoryExact) {
  const useCat = categoryExact ? categoryExact.trim() : null;
  const params = [];
  let categoryFilter = "";
  if (useCat) {
    params.push(useCat);
    categoryFilter = `
      AND EXISTS (
        SELECT 1 FROM public.meal_category mc
        JOIN public.food_categories fc ON fc.id = mc.category_id
        WHERE mc.meal_id = m.id AND LOWER(fc.name) = LOWER($${params.length})
      )`;
  }

  const { rows } = await query(
    `SELECT m.id, m.title, m.description, m.note, m.image, m.user_id
       FROM public.meals m
      WHERE TRUE
      ${categoryFilter}
      ORDER BY m.created_at DESC NULLS LAST, m.id DESC
      LIMIT 60`,
    params,
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const [foodsRes, catsRes] = await Promise.all([
    query(
      `SELECT im.meal_id, im.id, im.item_id,
              im.item_qty, im.item_qty_unit,
              im.energy, im.protein, im.carbs, im.fat,
              i.title AS item_title
         FROM public.item_meals im
         LEFT JOIN public.items i ON i.id = im.item_id
        WHERE im.meal_id = ANY($1::bigint[])
        ORDER BY im.meal_id, im."order" NULLS LAST, im.id ASC`,
      [ids],
    ),
    query(
      `SELECT mc.meal_id, fc.id AS category_id, fc.name AS category_name
         FROM public.meal_category mc
         JOIN public.food_categories fc ON fc.id = mc.category_id
        WHERE mc.meal_id = ANY($1::bigint[])`,
      [ids],
    ),
  ]);

  const foodsByMeal = new Map();
  for (const r of foodsRes.rows) {
    const arr = foodsByMeal.get(r.meal_id) || [];
    const energyKj = (() => {
      if (r.energy == null) return null;
      const m = String(r.energy).match(/-?\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : null;
    })();
    arr.push({
      item_id: r.item_id,
      food_id: r.item_id,
      food_name: r.item_title || `Item #${r.item_id}`,
      weight_g: Number(r.item_qty) || null,
      energy_kj: energyKj,
      protein_g: Number(r.protein) || 0,
      carb_g: Number(r.carbs) || 0,
      fat_g: Number(r.fat) || 0,
    });
    foodsByMeal.set(r.meal_id, arr);
  }

  const catsByMeal = new Map();
  for (const r of catsRes.rows) {
    const arr = catsByMeal.get(r.meal_id) || [];
    arr.push({ id: Number(r.category_id), name: r.category_name });
    catsByMeal.set(r.meal_id, arr);
  }

  return rows.map((r) => {
    const meal_foods = foodsByMeal.get(r.id) || [];
    const totals = meal_foods.reduce(
      (acc, f) => ({
        energy_kj: acc.energy_kj + (Number(f.energy_kj) || 0),
        protein_g: acc.protein_g + (Number(f.protein_g) || 0),
        carb_g: acc.carb_g + (Number(f.carb_g) || 0),
        fat_g: acc.fat_g + (Number(f.fat_g) || 0),
      }),
      { energy_kj: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
    );
    const energy_kcal = totals.energy_kj ? totals.energy_kj / 4.184 : 0;
    return {
      id: r.id,
      title: r.title,
      description: r.description || "",
      blueprint_note: r.note || "",
      image_url: r.image || "",
      categories: catsByMeal.get(r.id) || [],
      meal_foods,
      energy_kj: totals.energy_kj,
      energy_kcal,
      protein_g: totals.protein_g,
      carb_g: totals.carb_g,
      fat_g: totals.fat_g,
    };
  });
}

// Build a compact, LLM-friendly catalog of the legacy `public.items` rows so
// the model can pick real ingredient names + ids when it generates gap-fill
// meals. Each row: `id|title|cat|P|C|F|kJ|serving`. Keeps total length under
// ~60 000 chars by capping rows and trimming low-priority items.
async function buildItemsCatalog({ maxChars = 60_000, hardLimit = 1000 } = {}) {
  const { rows: items } = await query(
    `SELECT i.id, i.title, i.category,
            i.protein, i.carbs, i.fat, i.energy,
            i.serving_size, i.serving_size_unit
       FROM public.items i
      WHERE COALESCE(i.is_locked, false) = false
      ORDER BY i.category NULLS LAST, i.title ASC
      LIMIT $1`,
    [hardLimit],
  );

  const lineFor = (it) => {
    const energyKj = (() => {
      if (it.energy == null) return "";
      const m = String(it.energy).match(/-?\d+(?:\.\d+)?/);
      return m ? Math.round(Number(m[0])) : "";
    })();
    const serving =
      it.serving_size != null
        ? `${it.serving_size}${it.serving_size_unit || "g"}`
        : "";
    return [
      it.id,
      String(it.title || "").replace(/\|/g, "/"),
      String(it.category || "").replace(/\|/g, "/"),
      Number(it.protein) || 0,
      Number(it.carbs) || 0,
      Number(it.fat) || 0,
      energyKj,
      serving,
    ].join("|");
  };

  let lines = items.map(lineFor);
  let body = lines.join("\n");
  // If over budget, trim from the tail until we fit. Worst case we end up
  // with the alphabetically-earliest 200-300 items, still plenty for the LLM
  // to compose meals.
  while (body.length > maxChars && lines.length > 200) {
    lines = lines.slice(0, Math.floor(lines.length * 0.8));
    body = lines.join("\n");
  }

  const { rows: cats } = await query(
    `SELECT id, name FROM public.food_categories ORDER BY name ASC LIMIT 200`,
  );
  const { rows: subs } = await query(
    `SELECT id, title FROM public.sub_categories ORDER BY title ASC LIMIT 200`,
  );

  return [
    `FOOD CATEGORIES (id|name): ${cats.map((c) => `${c.id}|${c.name}`).join(", ")}`,
    `FOOD SUB-CATEGORIES (id|title): ${subs.map((c) => `${c.id}|${c.title}`).join(", ")}`,
    "",
    `ITEMS (${lines.length} rows; columns: id|title|category|P|C|F|kJ|serving):`,
    body,
  ].join("\n");
}

// Convert a legacy meal row + foods into a V3 carousel card.
function legacyMealToCarouselCard(meal) {
  const foods = (meal.meal_foods || []).map((f) => ({
    item_id: f.item_id,
    food_id: f.item_id,
    food_name: f.food_name,
    weight_grams: Number(f.weight_g) || 0,
    weight_g: Number(f.weight_g) || 0,
    energy_kj: Number(f.energy_kj) || 0,
    protein_g: Number(f.protein_g) || 0,
    carb_g: Number(f.carb_g) || 0,
    fat_g: Number(f.fat_g) || 0,
  }));
  const totals = {
    energy_kj: Number(meal.energy_kj) || 0,
    energy_kcal: Number(meal.energy_kcal) || (Number(meal.energy_kj) || 0) / 4.184,
    protein_g: Number(meal.protein_g) || 0,
    carb_g: Number(meal.carb_g) || 0,
    fat_g: Number(meal.fat_g) || 0,
  };
  return {
    id: meal.id,
    meal_id: meal.id,
    title: meal.title,
    description: meal.description || "",
    blueprintNote: meal.blueprint_note || "",
    image_url: meal.image_url || "",
    image_prompt: "",
    source: "database",
    unverified_foods: [],
    foods,
    totals,
    formatted_macros: formatCarouselMacros({
      p: totals.protein_g,
      c: totals.carb_g,
      f: totals.fat_g,
      kcal: totals.energy_kcal,
      kj: totals.energy_kj,
    }),
    categories: meal.categories || [],
  };
}

// Look up a single row in `public.items` by primary key and shape it like
// `foodsService.shapeItem` so downstream macro scaling has the per-serve fields
// it expects (`weight_g`, `protein_g`, `carb_g`, `fat_g`, `energy_kj`).
async function lookupItemById(itemId) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { shapeItem } = require("../services/foodsService");
  const { rows } = await query(
    `SELECT * FROM public.items WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? shapeItem(rows[0]) : null;
}

// Take an LLM-generated card, resolve each ingredient against `public.items`,
// recompute totals from the actual items macros (never trust the LLM's math).
//
// The carousel prompt instructs the model to emit `item_id` for every food
// (so the catalog row is unambiguous). When that's present we look the row up
// by primary key. Only when `item_id` is missing do we fall back to fuzzy
// name search via `resolveLabelToFood`.
async function finalizeGeneratedCard(card) {
  const cleanFoods = [];
  const macroLines = [];
  const unverifiedNames = new Set(card.unverified_foods || []);

  for (const f of card.foods || []) {
    const name = String(f.food_name || "").trim();
    const grams = Number(f.weight_grams ?? f.weight_g) || 100;
    // Prefer model-supplied `item_id` (carousel prompt asks for it explicitly).
    let resolvedRow = null;
    let resolvedId = null;
    if (f.item_id || f.food_id || f.id) {
      const byId = await lookupItemById(f.item_id || f.food_id || f.id);
      if (byId) {
        resolvedRow = byId;
        resolvedId = byId.id;
      }
    }
    if (!resolvedRow) {
      if (!name) continue;
      const resolved = await resolveLabelToFood(name, grams, 0.8, false);
      if (resolved.food_row) {
        resolvedRow = resolved.food_row;
        resolvedId = resolved.food_id;
      }
    }
    if (resolvedRow) {
      const resolved = { food_row: resolvedRow, food_id: resolvedId };
      // Per `foodsService.shapeItem`, `weight_g` is the per-serving reference.
      macroLines.push(scaleFoodRow(resolved.food_row, grams));
      cleanFoods.push({
        item_id: resolved.food_id,
        food_id: resolved.food_id,
        food_name: resolved.food_row.food_name || name,
        weight_grams: grams,
        weight_g: grams,
        // Display macros for this row scaled to the chosen grams.
        protein_g: +(Number(resolved.food_row.protein_g || 0) * (grams / (Number(resolved.food_row.weight_g) || grams))).toFixed(1),
        carb_g: +(Number(resolved.food_row.carb_g || 0) * (grams / (Number(resolved.food_row.weight_g) || grams))).toFixed(1),
        fat_g: +(Number(resolved.food_row.fat_g || 0) * (grams / (Number(resolved.food_row.weight_g) || grams))).toFixed(1),
        energy_kj: +(Number(resolved.food_row.energy_kj || 0) * (grams / (Number(resolved.food_row.weight_g) || grams))).toFixed(0),
      });
    } else {
      // No DB match — keep the LLM's numbers but mark unverified.
      // Skip blank rows so we don't pollute the card with empty ingredients.
      if (!name) continue;
      unverifiedNames.add(name);
      cleanFoods.push({
        item_id: null,
        food_id: null,
        food_name: name,
        weight_grams: grams,
        weight_g: grams,
        protein_g: Number(f.protein_g) || 0,
        carb_g: Number(f.carb_g) || 0,
        fat_g: Number(f.fat_g) || 0,
        energy_kj: Number(f.energy_kj) || 0,
      });
      macroLines.push({
        protein_g: Number(f.protein_g) || 0,
        carb_g: Number(f.carb_g) || 0,
        fat_g: Number(f.fat_g) || 0,
        energy_kj: Number(f.energy_kj) || 0,
        energy_kcal: 0,
      });
    }
  }

  const totals = finalizeTotals(sumMacros(macroLines));
  const final = {
    title: card.title || "Kez suggestion",
    description: card.description || "",
    blueprintNote: card.blueprintNote || "",
    image_url: "",
    image_prompt: card.image_prompt || "",
    source: card.source || "kez_generated",
    unverified_foods: [...unverifiedNames],
    foods: cleanFoods,
    totals: {
      energy_kj: totals.energy_kj,
      energy_kcal: totals.kcal,
      protein_g: totals.protein_g,
      carb_g: totals.carb_g,
      fat_g: totals.fat_g,
    },
  };
  // Kez may forget to write an image prompt — synthesise a safe default so
  // POST /save-suggestion always has something to send to OpenAI.
  if (!final.image_prompt) {
    final.image_prompt =
      `Bright, appetising overhead photo of ${final.title}. ${final.description || ""}`.trim();
  }
  final.formatted_macros = formatCarouselMacros({
    p: final.totals.protein_g,
    c: final.totals.carb_g,
    f: final.totals.fat_g,
    kcal: final.totals.energy_kcal,
    kj: final.totals.energy_kj,
  });
  return final;
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
    let target_count = Number(req.body?.target_count) || 3;
    const based_on = basedRaw === "v2" ? "v2" : "v1";
    const requestedLiked = Array.isArray(likedFoodsBody) ? likedFoodsBody : [];
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

    // Fetch BOTH V1 and V2 analyses for this slot so the LLM can compare what
    // the athlete currently eats (V1) with the version they tried in module
    // (V2). The carousel rules say: "match meals by type and core
    // ingredients — never replace a meal category" — so we want as much of
    // the athlete's actual eating pattern in context as possible.
    const sideAnalysesPromise = query(
      `SELECT version, meal_text, image_url, resolved_items, macro_totals
         FROM public.meal_analysis
        WHERE student_id = $1 AND mission_id = $2 AND slot_id = $3
        ORDER BY created_at DESC`,
      [student_id, mission_id, slot_id],
    );

    const [
      { rows: prescreenRows },
      { rows: studentRows },
      { rows: eerRows },
      dbLikedFoods,
      { rows: sideAnalysisRows },
    ] = await Promise.all([
      query(`SELECT * FROM public.prescreen WHERE student_id = $1`, [student_id]),
      query(`SELECT id, full_name, first_name FROM public.students WHERE id = $1`, [student_id]),
      query(`SELECT * FROM public.eer_config WHERE id = 1`),
      likedFoodsForStudent(student_id),
      sideAnalysesPromise,
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

    // Merge client-supplied liked foods (free text) with the canonical list
    // resolved from `student_food_preferences` → `items.title`.
    const liked_foods = Array.from(new Set([...dbLikedFoods, ...requestedLiked].filter(Boolean)));

    const eerConfig = eerRow
      ? {
          pal: eerRow.pal,
          carb_gkg: eerRow.carb_gkg,
          protein_gkg: eerRow.protein_gkg,
          fat_gday: eerRow.fat_gday,
        }
      : {};

    const carouselSettings = eerRow?.carousel_settings;
    if (carouselSettings?.suggestion_count != null) {
      const cs = Number(carouselSettings.suggestion_count);
      if (Number.isFinite(cs) && cs >= 1 && cs <= 12) target_count = Math.round(cs);
    }

    const loadDay = classifyLoadFromPrescreen(prescreen);
    const daily = computeDailyEER(prescreen, loadDay, eerConfig);
    const fraction = mealFractionForSlot(lbl);
    const targetBand = daily ? mealTargetBand(daily, fraction) : null;

    const category = analysis?.category || slotCategory(lbl);
    const dislikes = dislikeList(prescreen);
    const likedTokens = liked_foods.map((s) => String(s).toLowerCase());

    const resolvedItems = analysis?.resolved_items || [];
    const resolvedNameSet = new Set(
      resolvedItems.map((r) => r.food_name || r.food_row?.food_name || r.label).filter(Boolean),
    );
    const macroTotals = analysis?.macro_totals || {};

    // 1) Pull DB candidates from the legacy meals stack, scoped by slot category.
    let allMeals = await loadLegacyMealsWithFoods(category || null);
    if (!allMeals.length && category) {
      allMeals = await loadLegacyMealsWithFoods(null);
    }

    const candidates = allMeals.filter(
      (m) => !mealExcludedByDislikes(m.meal_foods || [], dislikes),
    );

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

    // Keep at most `target_count - 1` DB suggestions so there's room for at
    // least one Kez-generated card (Kerry's spec: 3–4 DB + 1–2 generated).
    const dbCap = Math.max(0, Math.min(target_count, target_count - 1, scored.length));
    const verifiedCards = scored.slice(0, dbCap).map((s) => legacyMealToCarouselCard(s.meal));

    let suggestions = [...verifiedCards];
    const need = Math.max(0, target_count - suggestions.length);

    const verifiedSummary = verifiedCards
      .map(
        (c) =>
          `- ${c.title}: P ${Math.round(c.totals.protein_g)}g C ${Math.round(c.totals.carb_g)}g F ${Math.round(c.totals.fat_g)}g ${Math.round(c.totals.energy_kj)}kJ`,
      )
      .join("\n");

    // 2) Build the compact items catalog the LLM picks ingredients from.
    let itemsCatalog = "";
    if (need > 0) {
      try {
        itemsCatalog = await buildItemsCatalog();
      } catch (e) {
        console.error("buildItemsCatalog", e);
      }
    }

    if (need > 0) {
      const brain = await buildBrainInjection(`V3 carousel ${mission_id} ${slot_id} ${firstName}`);
      const systemPrompt = assembleMealAnalysisSystemPrompt(brain);

      // Collapse V1 / V2 history into compact strings so the LLM sees what
      // the athlete actually eats for this slot.
      const v1Row = (sideAnalysisRows || []).find((r) => r.version === "v1");
      const v2Row = (sideAnalysisRows || []).find((r) => r.version === "v2");
      const summariseMealText = (row) => {
        if (!row?.meal_text) return null;
        return String(row.meal_text).trim().slice(0, 600);
      };

      // Daily energy targets, rendered as human-readable ranges Kez can echo
      // in `blueprintNote` if useful (always in kcal — keeps tokens cheap).
      const dailyEerSummary = daily
        ? {
            load_day: daily.loadDay,
            kcal_low: daily.eerLow,
            kcal_high: daily.eerHigh,
            protein_g_low: daily.protein.low,
            protein_g_high: daily.protein.high,
            carb_g_low: daily.carb.low,
            carb_g_high: daily.carb.high,
            fat_g_low: daily.fat.low,
            fat_g_high: daily.fat.high,
          }
        : null;

      const analysisFacts = {
        firstName,
        mission_id,
        slot_id,
        slot_label: lbl,
        slot_guidance: slotGuidance(category),
        based_on,
        meal_category: category,
        need_count: need,
        athlete: {
          first_name: firstName,
          age: ageFromDob(prescreen?.dob),
          sex: prescreen?.sex || null,
          weight_kg: prescreen?.weight_kg ?? prescreen?.weight ?? null,
          height_cm: prescreen?.height_cm ?? null,
          goals: Array.isArray(prescreen?.goals) ? prescreen.goals : [],
          biggest_challenges: Array.isArray(prescreen?.biggest_challenges)
            ? prescreen.biggest_challenges
            : [],
          meal_priority: prescreen?.meal_priority || null,
          weight_trend: prescreen?.weight_trend || null,
          eating_style: Array.isArray(prescreen?.eating_style)
            ? prescreen.eating_style
            : [],
          dietary_requirements: Array.isArray(prescreen?.dietary_reqs)
            ? prescreen.dietary_reqs
            : [],
          medical_flags: Array.isArray(prescreen?.medical) ? prescreen.medical : [],
          cooking_skills: prescreen?.cooking_skills || null,
        },
        preferences: {
          liked_foods,
          fav_foods_raw: prescreen?.fav_foods || null,
          disliked_foods: dislikes,
          disliked_foods_raw: prescreen?.dislike_foods || null,
        },
        training: {
          load_day: loadDay,
          activity_type: Array.isArray(prescreen?.activity_type)
            ? prescreen.activity_type
            : [],
          days_low: Number(prescreen?.days_low) || 0,
          days_med: Number(prescreen?.days_med) || 0,
          days_high: Number(prescreen?.days_high) || 0,
          session_length: prescreen?.session_length || null,
        },
        daily_eer: dailyEerSummary,
        target_band: targetBand,
        analysis_macros: macroTotals,
        // Backwards-compat aliases so older prompt segments / validators
        // that still read top-level `dislikes` / `liked_foods` keep working.
        dislikes,
        liked_foods,
        current_meal_v1: summariseMealText(v1Row)
          ? { description: summariseMealText(v1Row), image_url: v1Row.image_url || null }
          : null,
        improved_meal_v2: summariseMealText(v2Row)
          ? { description: summariseMealText(v2Row), image_url: v2Row.image_url || null }
          : null,
      };
      const factsJson = JSON.stringify(analysisFacts, null, 2);
      const userPrompt = [
        v3CarouselUserPrompt({
          firstName,
          factsJson,
          verifiedMealsSummary: verifiedSummary || "(no close verified matches in database)",
        }),
        "",
        "WHEN GENERATING NEW MEALS:",
        "- READ THE CONTEXT FIRST. Before picking ingredients, study FACTS.athlete (age, sex, weight, height, goals, dietary_requirements, medical_flags), FACTS.training (load_day, activity_type, session_length), FACTS.daily_eer, and FACTS.target_band. The plate must serve THIS athlete on THIS training day.",
        "- MATCH WHAT THEY EAT. If FACTS.current_meal_v1.description or FACTS.improved_meal_v2.description is present, keep the same meal type and core ingredients — make a smarter version of it, never a totally different cuisine. The athlete should look at V3 and think 'I could do that.'",
        "- HONOUR PREFERENCES. FACTS.preferences.liked_foods is a weighted preference — prioritise these items when macros allow. FACTS.preferences.disliked_foods AND FACTS.dislikes are a HARD exclusion — never include any of those words, ingredients, or close synonyms.",
        "- RESPECT DIETARY REQUIREMENTS. If FACTS.athlete.dietary_requirements lists 'Vegetarian' / 'Vegan' / 'Halal' / 'Gluten-free' / etc., obey it strictly. Same for any allergen-style entry in FACTS.athlete.medical_flags.",
        "- Compose each meal by COMBINING 3–6 DIFFERENT food items from the ITEMS catalog below (by their numeric id and exact title).",
        "  • Pick items from complementary categories — e.g. a protein item + a carb base + 1–2 vegetables/fruit + a fat source — so the plate looks like a real meal, not a single ingredient.",
        "  • Specify a realistic weight in grams for each item so the totals land inside FACTS.target_band (P, C, F, kcal).",
        "  • Hard rule: every food MUST come from the catalog. If a needed ingredient is missing, pick the closest available item instead of inventing one. Never invent foods outside the catalog.",
        "- For each generated meal:",
        "    title: a short coach-style name like \"Beef burrito bowl\" or \"Tropical oats\".",
        "    description: one sentence on what the meal is.",
        "    blueprintNote: one short line for Kerry's coach notes (timing/training context).",
        "    image_prompt: a vivid one-line description that could be passed to an image model (overhead plate shot, daylight).",
        "    foods[]: each entry must include item_id (from the catalog), food_name (the catalog title), weight_grams.",
        "    source: \"kez_generated\".",
        "",
        itemsCatalog,
        "",
        `Generate exactly ${need} meals as JSON. Every meal must combine multiple catalog items.`,
      ].join("\n");

      try {
        const raw = await callLlmText(userPrompt, { system: systemPrompt, json: true });
        const jsonStr = extractJsonObject(raw) || raw;
        const parsed = JSON.parse(jsonStr);
        const extra = Array.isArray(parsed.meals) ? parsed.meals : [];

        // Finalise all generated cards first so we know which prompts need
        // images, then kick off image generation + Cloudinary upload for ALL
        // of them in parallel — DALL-E is ~10s per image, doing them serially
        // would push the carousel response past the user's patience window.
        const finalisedCards = await Promise.all(
          extra.slice(0, need).map((m) => finalizeGeneratedCard(m)),
        );

        const cardsWithImages = await Promise.all(
          finalisedCards.map(async (card) => {
            const url = await generateAndUploadMealImage(card);
            if (url) card.image_url = url;
            return card;
          }),
        );

        for (const finalised of cardsWithImages) {
          suggestions.push(finalised);

          // Persist into the Brain Drafts queue (analyst can re-approve via the
          // dedicated POST /save-suggestion endpoint or the existing drafts UI).
          await query(
            `INSERT INTO public.meal_carousel_draft (
              analysis_id, student_id, mission_id, slot_id, payload, status, image_prompt
            ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [
              analysis?.id || null,
              student_id,
              mission_id,
              slot_id,
              jsonbString(finalised),
              "pending",
              finalised.image_prompt || null,
            ],
          );
        }
      } catch (e) {
        console.error("carousel gap fill", e);
      }
    }

    res.json({
      suggestions,
      target_count,
      target_band: targetBand,
      analysis_id: analysis?.id || null,
    });
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

// =============================================================================
// POST /api/kez/save-suggestion
// =============================================================================
//
// Coach picks a V3 carousel card and presses "Save to Meals DB". We:
//   1. Generate an image via OpenAI (1024x1024).
//   2. Upload that image straight to Cloudinary by URL.
//   3. Create a row in `public.meals` + `public.item_meals` (via
//      mealsService.createMeal) so the meal shows up in the legacy
//      Library / Meals stack and the Browse Meals DB tab.
//   4. If the suggestion came from a `meal_carousel_draft` row, mark that
//      draft `approved` and link its `meal_id`.
//
// Body: {
//   suggestion: { title, description, blueprintNote, foods[], image_prompt? },
//   mission_id?, slot_id?, draft_id?,
//   category_ids?: number[], sub_category_ids?: number[], tag_ids?: number[],
// }
async function saveSuggestionPost(req, res) {
  try {
    const {
      suggestion,
      draft_id,
      category_ids,
      sub_category_ids,
      tag_ids,
    } = req.body || {};

    if (!suggestion || typeof suggestion !== "object") {
      return res.status(400).json({ error: "suggestion required" });
    }
    if (!suggestion.title) {
      return res.status(400).json({ error: "suggestion.title required" });
    }
    if (!Array.isArray(suggestion.foods) || suggestion.foods.length === 0) {
      return res.status(400).json({ error: "suggestion.foods must be a non-empty array" });
    }

    // Step 1+2: image generation + Cloudinary upload.
    //
    // If the carousel already pre-generated an image (most cards do — see
    // `mealCarouselPost`), reuse it instead of paying for a fresh DALL-E
    // call. Otherwise fall back to the same `generateAndUploadMealImage`
    // helper the carousel uses.
    let imageUrl =
      typeof suggestion.image_url === "string" && /^https?:\/\//i.test(suggestion.image_url)
        ? suggestion.image_url
        : null;
    if (!imageUrl) {
      imageUrl = await generateAndUploadMealImage({
        title: suggestion.title,
        description: suggestion.description,
        image_prompt: suggestion.image_prompt,
      });
    }

    // Step 3: meal create. `foods[]` may carry an explicit `item_id` (preferred
    // path — fast bulk insert) or only a name (slow path inside mealsService).
    const foodsPayload = (suggestion.foods || []).map((f) => ({
      item_id: f.item_id || f.food_id || null,
      food_name: f.food_name || f.title || "Ingredient",
      weight_g: Number(f.weight_g ?? f.weight_grams) || 0,
      weight_grams: Number(f.weight_g ?? f.weight_grams) || 0,
      protein_g: Number(f.protein_g) || 0,
      carb_g: Number(f.carb_g) || 0,
      fat_g: Number(f.fat_g) || 0,
      energy_kj: Number(f.energy_kj) || 0,
      unit: f.unit || "g",
    }));

    const created = await mealsService.createMeal({
      title: suggestion.title,
      description: suggestion.description || "",
      blueprint_note: suggestion.blueprintNote || suggestion.blueprint_note || "",
      image_url: imageUrl,
      foods: foodsPayload,
      category_ids: Array.isArray(category_ids) ? category_ids : [],
      sub_category_ids: Array.isArray(sub_category_ids) ? sub_category_ids : [],
      tag_ids: Array.isArray(tag_ids) ? tag_ids : [],
    });

    // Step 4: link back to the draft (if any).
    if (draft_id) {
      try {
        await query(
          `UPDATE public.meal_carousel_draft
             SET status = 'approved', meal_id = $2, updated_at = now()
           WHERE id = $1`,
          [draft_id, created.id],
        );
      } catch (e) {
        // The migration that adds `meal_id` may not be applied yet — log and
        // fall back to a status-only update. Don't fail the save.
        console.error("saveSuggestionPost draft link", e);
        try {
          await query(
            `UPDATE public.meal_carousel_draft
               SET status = 'approved', updated_at = now()
             WHERE id = $1`,
            [draft_id],
          );
        } catch {}
      }
    }

    res.json({
      ok: true,
      meal_id: created.id,
      image_url: imageUrl,
      meal: created,
    });
  } catch (e) {
    console.error("saveSuggestionPost", e);
    res.status(500).json({ error: e.message || "Save failed" });
  }
}

module.exports = {
  mealAnalysisGet,
  mealAnalysisPost,
  mealCarouselPost,
  mealCarouselDraftsGet,
  mealCarouselDraftsPost,
  saveSuggestionPost,
};
