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
} = require("../services/kez/composer");
const {
  MEAL_ANALYSIS_TASK_SUFFIX,
  MASTER_SYSTEM_PROMPT,
} = require("../services/kez/masterPrompt");
const { callLlmText, extractJsonObject } = require("../services/kez/llm");
const {
  validateMealFeedback,
  validateMealAnalysisDraft,
  applyHardStopTemplates,
  stripHealthyUnhealthy,
} = require("../services/kez/validators");
const { formatCarouselMacros } = require("../services/kez/format");
const { resolveMealImageUrlForVision } = require("../services/kez/missionImageUrl");
const { uploadRemoteUrl, uploadImage } = require("../services/uploadService");
const mealsService = require("../services/mealsService");
const { embedQuery } = require("../services/rag/embeddings");
const {
  buildAthleteQueryText,
  formatVectorLiteral,
} = require("../services/mealEmbeddings");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
// `gpt-image-1` is OpenAI's current flagship image model — best quality and
// best instruction-following for food photography. Override with env var to
// force `dall-e-3` / `dall-e-2` if needed.
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

// Build the production image prompt for a meal card (carousel, save, or
// POST /generate-meal-image). Uses optional `foods[]` for ingredient-grounded
// visuals. Keep under ~4k chars for DALL-E 3.
function buildMealImagePrompt({
  title,
  description,
  blueprint_note: blueprintSnake,
  blueprintNote,
  image_prompt,
  foods,
  slot_id: slotId,
  slot_label: slotLabelSnake,
  slotLabel,
}) {
  const desc =
    String(description || "").trim() ||
    String(blueprintNote || blueprintSnake || "").trim();
  const slotHint = String(slotLabel || slotLabelSnake || slotId || "").trim();

  const foodLines = (Array.isArray(foods) ? foods : [])
    .map((f) => {
      if (!f || typeof f !== "object") return "";
      const nm = String(f.food_name || f.name || f.title || "").trim();
      if (!nm) return "";
      const w = f.weight_g ?? f.weight_grams ?? f.grams_estimate;
      const wg = w != null && Number.isFinite(Number(w)) ? Math.round(Number(w)) : null;
      return wg ? `${nm} (~${wg} g)` : nm;
    })
    .filter(Boolean)
    .slice(0, 14);

  const ingredientsPhrase =
    foodLines.length > 0
      ? `The dish clearly includes these ingredients, visibly recognizable: ${foodLines.join("; ")}.`
      : "";

  const cat = slotHint ? slotCategory(slotHint) : null;
  const categoryPhrase = cat ? `Meal type: ${cat} — composition should match typical ${cat.toLowerCase()} fueling.` : "";

  const seed =
    String(image_prompt || "").trim() ||
    [
      title && `Main meal: ${String(title).trim()}.`,
      desc && `How it should look: ${String(desc).slice(0, 420)}`,
      ingredientsPhrase,
      categoryPhrase,
    ]
      .filter(Boolean)
      .join(" ");

  const core = seed.trim() || "Balanced performance-nutrition meal on a ceramic plate, colourful whole foods.";

  const style =
    "Photorealistic editorial food photograph, 50mm lens, shallow depth of field, soft natural daylight from the side, neutral linen or light wood surface, simple ceramic plate, subtle steam only if realistic. Rich colour, crisp textures, appetising presentation. No text, no logos, no brand packaging, no watermark, no people, no hands.";

  const full = `${core} ${style}`.replace(/\s+/g, " ").trim();
  return full.length > 3800 ? full.slice(0, 3800) : full;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Images: model-aware request builder
// ─────────────────────────────────────────────────────────────────────────────
//
// OpenAI's `/v1/images/generations` endpoint behaves differently per model:
//
//   • gpt-image-1 (current flagship)
//       - Returns `b64_json` (never `url`).
//       - Quality values: "low" | "medium" | "high" | "auto".
//       - Size values: "1024x1024" | "1024x1536" | "1536x1024" | "auto".
//       - DOES NOT accept `response_format` — sending it returns 400.
//
//   • dall-e-3
//       - Returns `url` by default; `response_format` is deprecated.
//       - Quality values: "standard" | "hd".
//       - Size values: "1024x1024" | "1024x1792" | "1792x1024".
//
//   • dall-e-2
//       - Returns `url` by default.
//       - No quality parameter.
//
// To stay forward-compatible we NEVER send `response_format` and instead
// parse whichever shape comes back (`url` OR `b64_json`).
function buildImageRequestBody(prompt) {
  const model = String(OPENAI_IMAGE_MODEL || "gpt-image-1");
  const isDalle3 = /dall-e-3/i.test(model);
  const isDalle2 = /dall-e-2/i.test(model);
  const isGptImage = /gpt-image/i.test(model);

  const body = {
    model,
    prompt,
    n: 1,
    size: "1024x1024",
  };
  if (isGptImage) {
    body.quality = "high";
  } else if (isDalle3) {
    body.quality = "hd";
    body.style = "natural";
  } else if (isDalle2) {
    // no quality / style fields supported
  }
  return body;
}

function pickImageFromResponse(data) {
  const item = data?.data?.[0];
  if (!item) return null;
  if (item.url && /^https?:\/\//i.test(item.url)) return item.url;
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  return null;
}

// Call OpenAI Images. Returns either an https URL (dall-e-*) or a
// `data:image/png;base64,...` data URL (gpt-image-1). Throws on error so the
// caller can surface a useful message; returns null only if no payload.
async function generateMealImageUrl(prompt) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  if (!prompt || !String(prompt).trim()) throw new Error("Empty image prompt");

  const requestBody = buildImageRequestBody(String(prompt).slice(0, 3800));

  const res = await fetch(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `OpenAI images ${res.status} (model=${requestBody.model}): ${errBody.slice(0, 300)}`,
    );
  }

  const data = await res.json();
  return pickImageFromResponse(data);
}

// Try the primary model. If the org isn't verified for `gpt-image-1`
// (or the model name is otherwise rejected), automatically retry with
// `dall-e-3` so the carousel / regen flow keeps working.
async function generateImageWithFallback(prompt) {
  const primary = String(OPENAI_IMAGE_MODEL || "gpt-image-1");
  try {
    return { ref: await generateMealImageUrl(prompt), model: primary };
  } catch (err) {
    const msg = String(err?.message || "");
    const looksLikeAccess =
      /must be verified|organization.*verify|model_not_found|model.*not.*found|invalid.*model|gpt-image-1/i.test(
        msg,
      );
    if (looksLikeAccess && !/dall-e-3/i.test(primary)) {
      console.warn(
        `[image-gen] primary model ${primary} unavailable, falling back to dall-e-3: ${msg.slice(0, 200)}`,
      );
      const prevModel = process.env.OPENAI_IMAGE_MODEL;
      process.env.OPENAI_IMAGE_MODEL = "dall-e-3";
      try {
        const body = buildImageRequestBody(String(prompt).slice(0, 3800));
        const res = await fetch(OPENAI_IMAGES_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...body, model: "dall-e-3" }),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          throw new Error(`OpenAI images ${res.status} (dall-e-3 fallback): ${errBody.slice(0, 300)}`);
        }
        const data = await res.json();
        return { ref: pickImageFromResponse(data), model: "dall-e-3" };
      } finally {
        process.env.OPENAI_IMAGE_MODEL = prevModel;
      }
    }
    throw err;
  }
}

// Generate + upload pipeline. Returns the permanent Cloudinary `secure_url`
// (or `null` on any failure — the caller falls back to a placeholder).
async function generateAndUploadMealImage(card) {
  if (!OPENAI_API_KEY) return null;
  try {
    const prompt = buildMealImagePrompt(card);
    const { ref, model } = await generateImageWithFallback(prompt);
    if (!ref) {
      console.error("generateAndUploadMealImage: no image in OpenAI response");
      return null;
    }
    const uploaded = ref.startsWith("data:")
      ? await uploadImage(ref, { folder: "meals" })
      : await uploadRemoteUrl(ref, { folder: "meals" });
    if (uploaded?.url) {
      console.log(`[image-gen] success model=${model} -> ${uploaded.url}`);
    }
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

// =============================================================================
// Vector-driven carousel retrieval helpers.
//
// `mealCarouselPost` no longer pulls ALL meals by category and scores them in
// JS. Instead it embeds an athlete-context query and lets
// `public.match_meals` do the work in Postgres (hard category + dislikes
// filters, then HNSW ANN ordering). These two helpers handle:
//
//   loadLegacyMealsByIds   — batched hydrate of meals by id, preserving the
//                            input order so match_meals' ranking survives.
//   fetchFallbackMealIds   — degraded fallback when vector search yields zero
//                            rows (no embeddings yet, OpenAI hiccup, or no
//                            usable query context). Pulls the newest meals in
//                            the slot category, respecting dislikes.
// =============================================================================

async function loadLegacyMealsByIds(orderedIds) {
  if (!Array.isArray(orderedIds) || !orderedIds.length) return [];
  const ids = orderedIds.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (!ids.length) return [];

  const [mealRes, foodsRes, catsRes] = await Promise.all([
    query(
      `SELECT id, title, description, note, image, user_id
         FROM public.meals
        WHERE id = ANY($1::bigint[])`,
      [ids],
    ),
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
      `SELECT mc.meal_id, c.id AS category_id, c.title AS category_name
         FROM public.meal_category mc
         JOIN public.categories c ON c.id = mc.category_id
        WHERE mc.meal_id = ANY($1::bigint[])`,
      [ids],
    ),
  ]);

  // IMPORTANT: `public.meals.id` is a Postgres `bigint`, which `node-postgres`
  // returns as a STRING. The carousel ranking from `match_meals` arrives as
  // JS numbers, and we Number()-coerce input ids at the top of this helper.
  // If we keyed the Maps by `r.id` directly we'd be mixing string and number
  // keys → `Map.get` is strict-equality → every lookup would miss and
  // hydrated would silently come back empty. Normalize every key to Number.
  const foodsByMeal = new Map();
  for (const r of foodsRes.rows) {
    const mealKey = Number(r.meal_id);
    const arr = foodsByMeal.get(mealKey) || [];
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
    foodsByMeal.set(mealKey, arr);
  }

  const catsByMeal = new Map();
  for (const r of catsRes.rows) {
    const mealKey = Number(r.meal_id);
    const arr = catsByMeal.get(mealKey) || [];
    arr.push({ id: Number(r.category_id), name: r.category_name });
    catsByMeal.set(mealKey, arr);
  }

  const byId = new Map();
  for (const r of mealRes.rows) {
    const mealKey = Number(r.id);
    const meal_foods = foodsByMeal.get(mealKey) || [];
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
    byId.set(mealKey, {
      id: mealKey,
      title: r.title,
      description: r.description || "",
      blueprint_note: r.note || "",
      image_url: r.image || "",
      categories: catsByMeal.get(mealKey) || [],
      meal_foods,
      energy_kj: totals.energy_kj,
      energy_kcal,
      protein_g: totals.protein_g,
      carb_g: totals.carb_g,
      fat_g: totals.fat_g,
    });
  }

  // Preserve the input ordering (match_meals' ANN ranking) — meals dropped
  // by id-filter or hydration are silently skipped.
  return ids.map((id) => byId.get(Number(id))).filter(Boolean);
}

async function fetchFallbackMealIds(category, dislikes, limit, excludeIds = []) {
  const params = [];
  const filters = [];

  if (category) {
    // Substring (not equality) so `slotCategory("Pre-Training") = "Training"`
    // still pulls Pre-Training / Post-Training / Training - AM rows. Keeps
    // parity with the same `LIKE` filter inside `public.match_meals`.
    params.push(category);
    filters.push(`EXISTS (
      SELECT 1 FROM public.meal_category mc
      JOIN public.categories c ON c.id = mc.category_id
      WHERE mc.meal_id = m.id
        AND LOWER(c.title) LIKE '%' || LOWER(TRIM($${params.length})) || '%'
    )`);
  }

  if (Array.isArray(dislikes) && dislikes.length) {
    const cleaned = dislikes.map((d) => String(d).toLowerCase().trim()).filter(Boolean);
    if (cleaned.length) {
      params.push(cleaned);
      filters.push(`NOT EXISTS (
        SELECT 1
          FROM public.item_meals im
          JOIN public.items i ON i.id = im.item_id
         WHERE im.meal_id = m.id
           AND EXISTS (
             SELECT 1 FROM UNNEST($${params.length}::text[]) AS d
              WHERE LOWER(i.title) LIKE '%' || d || '%'
           )
      )`);
    }
  }

  // Past-V3 + in-session excludes — keeps fallback consistent with the
  // vector path so the "Try different" rotation works even when ANN search
  // is unavailable.
  const cleanedExclude = Array.isArray(excludeIds)
    ? excludeIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (cleanedExclude.length) {
    params.push(cleanedExclude);
    filters.push(`NOT (m.id = ANY ($${params.length}::bigint[]))`);
  }

  params.push(Math.max(1, Number(limit) || 10));
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const { rows } = await query(
    `SELECT m.id
       FROM public.meals m
       ${where}
      ORDER BY m.created_at DESC NULLS LAST, m.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
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
      exclude_ids: excludeIdsBody,
    } = req.body || {};
    let target_count = Number(req.body?.target_count) || 3;
    const based_on = basedRaw === "v2" ? "v2" : "v1";
    const requestedLiked = Array.isArray(likedFoodsBody) ? likedFoodsBody : [];
    // In-session exclude (frontend "Try different" button). Past-pick exclude
    // is derived below from `meal_analysis` v3 history.
    const clientExcludeIds = Array.isArray(excludeIdsBody)
      ? excludeIdsBody.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : [];
    const lbl = slot_label || slot_id;

    if (!student_id || !mission_id || !slot_id) {
      return res.status(400).json({ error: "student_id, mission_id, slot_id required" });
    }

    // Pin the analysis row that drives the response. Either explicit
    // (meal_analysis_id) or the latest v1/v2 for this slot.
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

    // Fetch BOTH V1 and V2 (eating pattern + module attempt) AND every V3
    // pick the coach has previously sent for this slot. The V3 rows are
    // used twice below:
    //   • their `meal_text` becomes a soft "previously suggested" signal
    //     in the embedded query, nudging ANN away from re-ranking the
    //     same meals to the top;
    //   • their `model_meta.meal_id` becomes a HARD exclude list passed
    //     to `match_meals.exclude_meal_ids`, so an already-sent meal
    //     never reappears in a future carousel for the same slot.
    const sideAnalysesPromise = query(
      `SELECT version, meal_text, image_url, resolved_items, macro_totals, model_meta
         FROM public.meal_analysis
        WHERE student_id = $1 AND mission_id = $2 AND slot_id = $3
        ORDER BY created_at DESC`,
      [student_id, mission_id, slot_id],
    );

    const [
      { rows: prescreenRows },
      { rows: eerRows },
      dbLikedFoods,
      { rows: sideAnalysisRows },
    ] = await Promise.all([
      query(`SELECT * FROM public.prescreen WHERE student_id = $1`, [student_id]),
      query(`SELECT * FROM public.eer_config WHERE id = 1`),
      likedFoodsForStudent(student_id),
      sideAnalysesPromise,
    ]);

    const prescreen = prescreenRows?.[0] || {};
    const eerRow = eerRows?.[0];

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

    // ── 1) Build the athlete query text + embed it ─────────────────────────
    // The query combines what the athlete eats now (V1), what they tried in
    // module (V2), their preferences, dislikes, slot category, and the macro
    // target band. `match_meals` then ranks meals by cosine similarity to
    // this composite signal — far smarter than substring matching on
    // ingredient names. Slot category is also passed as a hard SQL filter,
    // so Breakfast carousel never returns dinner meals etc.
    const v1Row = (sideAnalysisRows || []).find((r) => r.version === "v1");
    const v2Row = (sideAnalysisRows || []).find((r) => r.version === "v2");
    const v3Rows = (sideAnalysisRows || []).filter((r) => r.version === "v3");

    // Build the past-V3 exclude set:
    //   1. canonical meal_id stored in model_meta (set by mealAnalysisV3Post);
    //   2. plus whatever the client sent for in-session rotation.
    const v3PastMealIds = v3Rows
      .map((r) => Number(r?.model_meta?.meal_id))
      .filter((n) => Number.isFinite(n) && n > 0);
    const excludeMealIds = Array.from(
      new Set([...v3PastMealIds, ...clientExcludeIds]),
    );

    const queryText = buildAthleteQueryText({
      slotCategory: category,
      slotLabel: lbl !== category ? lbl : null,
      v1MealText: v1Row?.meal_text || null,
      v2MealText: v2Row?.meal_text || null,
      v3MealTexts: v3Rows.map((r) => r.meal_text).filter(Boolean),
      likedFoods: liked_foods,
      dislikedFoods: dislikes,
      targetBand,
    });

    // ── 2) Vector search via match_meals RPC ───────────────────────────────
    // Hard category + dislike filters happen in SQL, ANN ordering happens
    // against the HNSW index. We over-fetch a fat pool (>= 25, scaling with
    // target_count) so step 4 has room to pick a fresh-looking mix on
    // every call instead of the deterministic top-N.
    let matchedRows = [];
    if (queryText) {
      try {
        const vec = await embedQuery(queryText);
        if (Array.isArray(vec) && vec.length) {
          const k = Math.max(target_count * 6, 25);
          const { rows } = await query(
            `SELECT * FROM public.match_meals($1::vector, $2, $3::text[], $4, $5::bigint[])`,
            [
              formatVectorLiteral(vec),
              category || null,
              dislikes,
              k,
              excludeMealIds,
            ],
          );
          matchedRows = rows || [];
        }
      } catch (e) {
        console.error("[carousel] match_meals failed, will use fallback:", e.message || e);
      }
    }

    // ── 3) Fallback: newest meals in the slot category (vector empty) ──────
    // Triggered when match_meals returns nothing — usually because the
    // embeddings haven't been backfilled yet or OpenAI is unreachable. Keeps
    // the carousel rendering something usable instead of an empty screen.
    let pooledIds = matchedRows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
    if (!pooledIds.length) {
      pooledIds = await fetchFallbackMealIds(
        category,
        dislikes,
        Math.max(target_count * 6, 25),
        excludeMealIds,
      );
    }

    // ── 4) Pick `target_count` meals with rank-weighted random sampling ────
    //
    // Why: pure ANN ranking is fully deterministic — same embedding always
    // yields the same top-N → the coach sees the same 3 cards every click.
    // We over-fetched a pool of ~6× target_count above, so we can sample
    // `target_count` *without replacement* with weights ∝ 1 / (rank + 1).
    //
    // Effect:
    //   • Top of the pool (most semantically relevant) is picked most
    //     often, so the suggestions stay on-topic.
    //   • Lower-ranked but still-relevant meals occasionally surface,
    //     giving the carousel meaningful variety on each refresh.
    //   • Combined with the V3-past exclude above, the same meal never
    //     appears once the coach has sent it.
    function sampleWeighted(ids, k) {
      const pool = ids.slice();
      const out = [];
      while (pool.length && out.length < k) {
        const weights = pool.map((_, i) => 1 / (i + 1));
        const total = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        let idx = 0;
        for (; idx < pool.length; idx += 1) {
          r -= weights[idx];
          if (r <= 0) break;
        }
        if (idx >= pool.length) idx = pool.length - 1;
        out.push(pool[idx]);
        pool.splice(idx, 1);
      }
      return out;
    }

    const chosenIds = sampleWeighted(pooledIds, Math.max(0, target_count));
    const hydrated = chosenIds.length ? await loadLegacyMealsByIds(chosenIds) : [];
    const suggestions = hydrated.map((meal) => legacyMealToCarouselCard(meal));

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
// POST /api/kez/generate-meal-image
// =============================================================================
//
// Kerry dashboard — regenerate meal hero image from structured meal data
// (title, description, foods with weights, optional slot label). Uses the same
// OpenAI + Cloudinary path as carousel / save-suggestion.
//
// Body: { title?, description?, blueprintNote?, image_prompt?, prompt?, foods?, slotLabel? }
//       (camelCase or snake_case accepted)
async function mealImageGeneratePost(req, res) {
  try {
    const b = req.body || {};
    const title = String(b.title || b.desc || "").trim();
    const description = String(b.description || "").trim();
    const blueprintNote = String(b.blueprintNote || b.blueprint_note || "").trim();
    const directPrompt = String(b.prompt || "").trim();
    const image_prompt =
      String(b.image_prompt || "").trim() || directPrompt;
    const foods = Array.isArray(b.foods) ? b.foods : [];
    const slotLabel = String(b.slotLabel || b.slot_label || "").trim();

    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        error: "OPENAI_API_KEY is not configured on the server — add it to backend env for meal image generation.",
      });
    }

    if (
      !title &&
      !image_prompt &&
      foods.length === 0 &&
      !description &&
      !blueprintNote
    ) {
      return res.status(400).json({
        error: "Provide title, description, blueprint note, image_prompt, prompt, or foods[]",
      });
    }

    const imageUrl = await generateAndUploadMealImage({
      title,
      description,
      blueprintNote,
      image_prompt,
      foods,
      slotLabel,
    });

    if (!imageUrl) {
      return res.status(502).json({
        error: "Image generation or Cloudinary upload failed — see server logs.",
      });
    }

    const promptUsed = buildMealImagePrompt({
      title,
      description,
      blueprintNote,
      image_prompt,
      foods,
      slotLabel,
    });

    return res.json({ image_url: imageUrl, image_prompt_used: promptUsed, provider: "openai+cloudinary" });
  } catch (e) {
    console.error("mealImageGeneratePost", e);
    return res.status(500).json({ error: e.message || "Image generation failed" });
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
        blueprintNote: suggestion.blueprintNote || suggestion.blueprint_note,
        image_prompt: suggestion.image_prompt,
        foods: suggestion.foods,
      });
    }

    // Step 3: meal create. `foods[]` may carry an explicit `item_id` (preferred
    // path — fast bulk insert) or only a name (slow path inside mealsService).
    // Pass `selected_qty_unit` through verbatim so Kerry's recipe portions
    // (e.g. "40g or 1/2 cup") survive a Save-card → Edit-meal round trip.
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
      selected_qty_unit: f.selected_qty_unit || null,
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

// =============================================================================
// POST /api/kez/meal-analysis-v3
// =============================================================================
//
// "Send to athlete" persistence for V3 picks. Unlike `mealAnalysisPost`
// (which runs vision + LLM on a photo for V1/V2), this is a lightweight
// write triggered when the coach selects a carousel/library meal to send
// downstream. It records the pick as a `meal_analysis` row with
// version='v3' so:
//   • the side panel `GET /api/kez/meal-analysis` returns the V3 alongside
//     V1/V2 on the next reload (kezBySlot in the dashboard);
//   • the future `mealCarouselPost` calls for the same slot have an
//     explicit V3 history row to consider; and
//   • the V3 progression survives page reloads instead of living only in
//     the dashboard's local `v3Slots` state.
//
// No vision, no LLM — the meal is already chosen, we just normalize the
// macros against the prescreen-derived target band and persist.
//
// Body: {
//   student_id, mission_id, slot_id, slot_label?,
//   meal_id?,            // legacy meal pk if the card came from the DB
//   title,               // required, becomes meal_text + feedback_text
//   description?, blueprint_note?, image_url?, image_prompt?,
//   foods?: Array<{ item_id?, food_name, weight_g?, energy_kj?,
//                   protein_g?, carb_g?, fat_g? }>,
//   totals?: { energy_kj?, protein_g?, carb_g?, fat_g? }
// }
async function mealAnalysisV3Post(req, res) {
  try {
    const body = req.body || {};
    const {
      student_id,
      mission_id,
      slot_id,
      slot_label,
      meal_id,
      title,
      description = "",
      blueprint_note: blueprintNote = "",
      image_url: imageUrlIn,
      image_prompt: imagePromptIn,
      foods: foodsIn,
      totals: totalsIn,
    } = body;

    if (!student_id || !mission_id || !slot_id) {
      return res.status(400).json({ error: "student_id, mission_id, slot_id required" });
    }
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title required" });
    }

    const lbl = slot_label || slot_id;

    const [{ rows: stRows }, { rows: prescreenRows }, { rows: eerRows }] = await Promise.all([
      query(`SELECT id, full_name, first_name FROM public.students WHERE id = $1`, [student_id]),
      query(`SELECT * FROM public.prescreen WHERE student_id = $1`, [student_id]),
      query(`SELECT * FROM public.eer_config WHERE id = 1`),
    ]);
    if (!stRows?.[0]) return res.status(404).json({ error: "Student not found" });

    const prescreen = prescreenRows?.[0] || {};
    const eerRow = eerRows?.[0];
    const eerConfig = eerRow
      ? {
          pal: eerRow.pal,
          carb_gkg: eerRow.carb_gkg,
          protein_gkg: eerRow.protein_gkg,
          fat_gday: eerRow.fat_gday,
        }
      : {};

    // load_day is NOT NULL CHECK ('Lower'|'Moderate'|'High') on the table —
    // fall back to "Moderate" if prescreen can't be classified so the
    // insert never fails the constraint.
    const inferredLoad = classifyLoadFromPrescreen(prescreen);
    const loadDay = inferredLoad || "Moderate";

    const daily = computeDailyEER(prescreen, loadDay, eerConfig);
    const fraction = mealFractionForSlot(lbl);
    const targetBand = daily ? mealTargetBand(daily, fraction) : null;
    const category = slotCategory(lbl);

    // Resolve macro totals. Prefer client-supplied `totals` (the carousel
    // already aggregates per-card); otherwise sum across foods.
    const foods = Array.isArray(foodsIn) ? foodsIn : [];
    const sumFromFoods = foods.reduce(
      (acc, f) => ({
        energy_kj: acc.energy_kj + (Number(f.energy_kj) || 0),
        protein_g: acc.protein_g + (Number(f.protein_g) || 0),
        carb_g: acc.carb_g + (Number(f.carb_g) || 0),
        fat_g: acc.fat_g + (Number(f.fat_g) || 0),
      }),
      { energy_kj: 0, protein_g: 0, carb_g: 0, fat_g: 0 },
    );
    const raw = {
      energy_kj: Number(totalsIn?.energy_kj) || sumFromFoods.energy_kj,
      protein_g: Number(totalsIn?.protein_g) || sumFromFoods.protein_g,
      carb_g: Number(totalsIn?.carb_g) || sumFromFoods.carb_g,
      fat_g: Number(totalsIn?.fat_g) || sumFromFoods.fat_g,
    };
    const macro_totals = finalizeTotals(raw);
    const vs_targets = targetBand ? buildVsTargets(macro_totals, targetBand) : {};

    // Frontend uses `feedback_text` as the short slot description in the
    // V1/V2/V3 progression strip. Keep it short and human.
    const feedback_text = description
      ? `${title} — ${description}`
      : title;

    const resolvedItems = foods.map((f) => ({
      food_id: f.item_id || f.food_id || null,
      food_name: f.food_name || "Ingredient",
      grams_estimate: Number(f.weight_g ?? f.weight_grams) || null,
      vision_confidence: null,
      resolver_score: null,
      food_row: null,
      energy_kj: Number(f.energy_kj) || 0,
      protein_g: Number(f.protein_g) || 0,
      carb_g: Number(f.carb_g) || 0,
      fat_g: Number(f.fat_g) || 0,
    }));

    const model_meta = {
      route: "meal-analysis-v3",
      source: meal_id ? "library_meal" : "carousel_card",
      meal_id: meal_id != null ? Number(meal_id) || null : null,
      slot_label: lbl,
      blueprint_note: blueprintNote,
      image_prompt: imagePromptIn || null,
      foods,
      totals: macro_totals,
    };

    const { rows: insRows } = await query(
      `INSERT INTO public.meal_analysis (
        student_id, mission_id, slot_id, version, image_url, meal_text,
        load_day, category, vision_raw, resolved_items, macro_totals, target_band, vs_targets,
        feedback_text, feedback_status, confidence, needs_correction, flags, model_meta
      ) VALUES (
        $1, $2, $3, 'v3', $4, $5, $6, $7,
        $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
        $13, 'approved', $14, false, $15, $16::jsonb
      )
      RETURNING id, created_at`,
      [
        student_id,
        mission_id,
        slot_id,
        imageUrlIn || null,
        title,
        loadDay,
        category,
        jsonbString({}),
        jsonbString(resolvedItems),
        jsonbString(macro_totals),
        jsonbString(targetBand),
        jsonbString(vs_targets),
        feedback_text,
        1.0,
        ["v3_manual_selection"],
        jsonbString(model_meta),
      ],
    );

    const inserted = insRows?.[0];
    if (!inserted?.id) return res.status(500).json({ error: "Failed to save V3 selection" });

    res.json({
      ok: true,
      analysis_id: inserted.id,
      created_at: inserted.created_at,
      category,
      macro_totals,
      target_band: targetBand,
      vs_targets,
    });
  } catch (e) {
    console.error("mealAnalysisV3Post", e);
    res.status(500).json({ error: e.message || "Save V3 failed" });
  }
}

// =============================================================================
// POST /api/kez/mission-feedback-draft
// =============================================================================
//
// Generates ONE personalized, mission-level coaching draft from "Virtual Kez"
// (Kerry's persona, see MASTER_SYSTEM_PROMPT). Replaces the old behaviour
// where the dashboard simply concatenated each slot's `feedback_text` —
// which read more like a stitched-together report than a coach's note.
//
// Inputs collected server-side from canonical tables (no client trust):
//   • `public.students`              — first name, age via prescreen.dob
//   • `public.prescreen`             — sex, weight, height, dietary reqs,
//                                       dislikes, free-text liked foods
//   • `student_food_preferences`     — resolved list of liked items.title
//   • `public.eer_config`            — PAL bands + g/kg defaults
//   • `public.meal_analysis`         — ALL rows for (student, mission),
//                                       grouped by slot, including v1, v2,
//                                       AND v3 picks
//
// Output: one coherent draft (text), <= 3 short paragraphs, follows every
// rule from the master persona (no bullets, food-first, "Hey [Name].",
// never "healthy"/"unhealthy"). The same hard-stop / template / strip
// post-processors used by `mealAnalysisPost` run here too so the output
// stays inside the same guardrails.
//
// Body: { student_id, mission_id }
async function missionFeedbackDraftPost(req, res) {
  try {
    const { student_id, mission_id } = req.body || {};
    if (!student_id || !mission_id) {
      return res.status(400).json({ error: "student_id, mission_id required" });
    }

    const [
      { rows: stRows },
      { rows: prescreenRows },
      { rows: eerRows },
      dbLikedFoods,
      { rows: analysisRows },
    ] = await Promise.all([
      query(`SELECT id, full_name, first_name FROM public.students WHERE id = $1`, [student_id]),
      query(`SELECT * FROM public.prescreen WHERE student_id = $1`, [student_id]),
      query(`SELECT * FROM public.eer_config WHERE id = 1`),
      likedFoodsForStudent(student_id),
      query(
        `SELECT slot_id, version, image_url, meal_text, category,
                load_day, macro_totals, target_band, vs_targets,
                feedback_text, confidence, needs_correction, flags,
                created_at
           FROM public.meal_analysis
          WHERE student_id = $1 AND mission_id = $2
          ORDER BY slot_id ASC, version ASC, created_at DESC`,
        [student_id, mission_id],
      ),
    ]);

    if (!stRows?.[0]) return res.status(404).json({ error: "Student not found" });
    const prescreen = prescreenRows?.[0] || {};
    const eerRow = eerRows?.[0];
    const eerConfig = eerRow
      ? {
          pal: eerRow.pal,
          carb_gkg: eerRow.carb_gkg,
          protein_gkg: eerRow.protein_gkg,
          fat_gday: eerRow.fat_gday,
        }
      : {};

    const studentRow = stRows[0];
    const firstName =
      studentRow.first_name ||
      String(studentRow.full_name || "Athlete").trim().split(/\s+/)[0] ||
      "Athlete";

    if (!analysisRows.length) {
      // No analyses run yet → return a stub the dashboard can show without
      // burning an LLM call. Same friendly nudge the frontend used to print.
      return res.json({
        draft:
          `Hey ${firstName}. Run Kez analysis on the V1/V2 meal photos for ` +
          `this mission first (button under each slot), then generate this ` +
          `draft again so I can speak to what you actually ate.`,
        used_analyses: 0,
        empty_mission_analyses: true,
      });
    }

    // Pick the freshest row per (slot, version) tuple. Same student can have
    // multiple v1 attempts as they retake photos — we want the latest.
    const latestBySlotVer = new Map();
    for (const r of analysisRows) {
      const key = `${r.slot_id}|${r.version}`;
      if (!latestBySlotVer.has(key)) latestBySlotVer.set(key, r);
    }

    // Group by slot for the prompt so the model sees the V1 → V2 → V3
    // progression for each meal slot side-by-side, matching how Kerry
    // reviews missions in the dashboard.
    const slotsMap = new Map();
    for (const r of latestBySlotVer.values()) {
      const slot = slotsMap.get(r.slot_id) || {
        slot_id: r.slot_id,
        category: r.category || null,
        load_day: r.load_day || null,
        v1: null,
        v2: null,
        v3: null,
      };
      if (!slot.category && r.category) slot.category = r.category;
      if (!slot.load_day && r.load_day) slot.load_day = r.load_day;
      slot[r.version] = {
        meal_text: r.meal_text || "",
        macro_totals: r.macro_totals || null,
        target_band: r.target_band || null,
        vs_targets: r.vs_targets || null,
        confidence: r.confidence != null ? Number(r.confidence) : null,
        needs_correction: !!r.needs_correction,
        flags: Array.isArray(r.flags) ? r.flags : [],
        feedback_text: r.feedback_text || "",
      };
      slotsMap.set(r.slot_id, slot);
    }
    const slots = Array.from(slotsMap.values());

    const loadDay = classifyLoadFromPrescreen(prescreen);
    const daily = computeDailyEER(prescreen, loadDay, eerConfig);
    const dislikes = dislikeList(prescreen);

    const facts = {
      firstName,
      age: ageFromDob(prescreen.dob),
      sex: prescreen.sex || null,
      weight_kg: prescreen.weight_kg ?? prescreen.weight ?? null,
      height_cm: prescreen.height_cm ?? prescreen.height ?? null,
      training_load_day: loadDay,
      dietary_requirements:
        prescreen.dietary_reqs || prescreen.dietaryReqs || "",
      liked_foods: dbLikedFoods,
      disliked_foods: dislikes,
      daily_eer_kcal: daily ? [daily.eerLow, daily.eerHigh] : null,
      daily_protein_g: daily?.protein || null,
      daily_carb_g: daily?.carb || null,
      mission_id,
      slots,
    };
    const factsJson = JSON.stringify(facts, null, 2);

    const userPrompt = [
      `Current task: MISSION_FEEDBACK_DRAFT`,
      ``,
      `Write a single, personalized coaching note from Kerry to ${firstName} ` +
        `for this mission. Use the FACTS below as the only source of truth ` +
        `— do not invent numbers, brands, or food choices.`,
      ``,
      `What to cover (in order, but use Kerry's voice — no headings, no ` +
        `bullets, plain prose):`,
      `  1. Read across V1 → V2 (and V3 where present) for each slot and ` +
        `name what actually shifted. Acknowledge real improvements.`,
      `  2. Connect the changes to ${firstName}'s training load ` +
        `(FACTS.training_load_day) and daily fuel targets ` +
        `(FACTS.daily_eer_kcal, FACTS.daily_protein_g, FACTS.daily_carb_g).`,
      `  3. Give 2–3 specific, actionable nudges built ONLY from ` +
        `FACTS.liked_foods. Never recommend something in ` +
        `FACTS.disliked_foods or contrary to FACTS.dietary_requirements.`,
      `  4. Close with one concrete next step.`,
      ``,
      `Hard format rules (non-negotiable):`,
      `  - Open with: "Hey ${firstName}."`,
      `  - Maximum 3 short paragraphs. NO bullet points. NO headings.`,
      `  - Address ${firstName} as "you" throughout.`,
      `  - Never use the words "healthy" or "unhealthy".`,
      `  - Show energy as "X cal (Y kJ)" when referencing a number; round ` +
        `cal to nearest 10, kJ to nearest 100.`,
      `  - If a number is missing in FACTS, do not fabricate one — say what ` +
        `you'd need to know.`,
      ``,
      `FACTS (JSON):`,
      factsJson,
    ].join("\n");

    let draft = "";
    try {
      draft = await callLlmText(userPrompt, {
        system: MASTER_SYSTEM_PROMPT,
        json: false,
      });
    } catch (e) {
      console.error("missionFeedbackDraftPost LLM error", e);
      return res.status(502).json({
        error: "LLM call failed",
        detail: e.message || String(e),
      });
    }

    const stopped = applyHardStopTemplates(draft, { firstName });
    draft = stopped.text;
    draft = stripHealthyUnhealthy(draft);

    res.json({
      draft,
      first_name: firstName,
      used_analyses: latestBySlotVer.size,
      slot_count: slots.length,
      hard_stop_triggered: !!stopped.flagged,
    });
  } catch (e) {
    console.error("missionFeedbackDraftPost", e);
    res.status(500).json({ error: e.message || "Draft generation failed" });
  }
}

// =============================================================================
// POST /api/kez/student-feedback-draft
// =============================================================================
//
// Athlete-level overall coaching note (was `genMainAI` in DashboardClient —
// prompt built in the browser + POST to Next `/api/ai-draft`). Now the entire
// pipeline lives here: prescreen + food prefs + EER-derived daily targets,
// Virtual Kez persona (`MASTER_SYSTEM_PROMPT`), same guardrail post-processors.
//
// Body: { student_id }
async function studentFeedbackDraftPost(req, res) {
  try {
    const { student_id } = req.body || {};
    if (!student_id) return res.status(400).json({ error: "student_id required" });

    const normArr = (val) => {
      if (Array.isArray(val)) return val.map(String).map((s) => s.trim()).filter(Boolean);
      if (val == null || val === "") return [];
      return [String(val).trim()].filter(Boolean);
    };

    const [{ rows: stRows }, { rows: prescreenRows }, { rows: eerRows }, dbLikedFoods] = await Promise.all([
      query(`SELECT id, full_name, first_name FROM public.students WHERE id = $1`, [student_id]),
      query(`SELECT * FROM public.prescreen WHERE student_id = $1`, [student_id]),
      query(`SELECT * FROM public.eer_config WHERE id = 1`),
      likedFoodsForStudent(student_id),
    ]);

    if (!stRows?.[0]) return res.status(404).json({ error: "Student not found" });
    const ps = prescreenRows?.[0] || {};
    const eerRow = eerRows?.[0];
    const eerConfig = eerRow
      ? {
          pal: eerRow.pal,
          carb_gkg: eerRow.carb_gkg,
          protein_gkg: eerRow.protein_gkg,
          fat_gday: eerRow.fat_gday,
        }
      : {};

    const studentRow = stRows[0];
    const firstName =
      studentRow.first_name ||
      String(studentRow.full_name || "Athlete").trim().split(/\s+/)[0] ||
      "Athlete";

    const loadDay = classifyLoadFromPrescreen(ps);
    const daily = computeDailyEER(ps, loadDay, eerConfig);
    const dislikes = dislikeList(ps);

    const facts = {
      firstName,
      full_name: studentRow.full_name || null,
      age: ageFromDob(ps.dob),
      sex: ps.sex || null,
      height_cm: ps.height_cm ?? ps.height ?? null,
      weight_kg: ps.weight_kg ?? ps.weight ?? null,
      training_load_day: loadDay,
      training_days_per_week: {
        high: Number(ps.days_high ?? ps.daysHigh) || 0,
        moderate: Number(ps.days_med ?? ps.daysMed) || 0,
        low: Number(ps.days_low ?? ps.daysLow) || 0,
      },
      goals: normArr(ps.goals),
      biggest_challenges: normArr(ps.biggest_challenges ?? ps.biggestChallenges),
      medical: normArr(ps.medical),
      activity_type: normArr(ps.activity_type ?? ps.activityType),
      supplements: ps.supplements || null,
      fav_foods_free_text: ps.fav_foods || ps.favFoods || null,
      liked_foods: dbLikedFoods,
      disliked_foods: dislikes,
      dietary_requirements: ps.dietary_reqs || ps.dietaryReqs || "",
      daily_eer_kcal: daily ? [daily.eerLow, daily.eerHigh] : null,
      daily_protein_g: daily?.protein || null,
      daily_carb_g: daily?.carb || null,
    };
    const factsJson = JSON.stringify(facts, null, 2);

    const userPrompt = [
      `Current task: STUDENT_OVERALL_FEEDBACK_DRAFT`,
      ``,
      `Write one overall coaching feedback note from Kerry to ${firstName}. ` +
        `Use the FACTS JSON below as the only source of truth — do not invent ` +
        `numbers, brands, medical diagnoses, or foods not implied by FACTS.`,
      ``,
      `What to cover (in Kerry's voice — no headings, no bullets, plain prose):`,
      `  1. Acknowledge where they are today using their goals, challenges, ` +
        `and training week pattern (FACTS.training_days_per_week, ` +
        `FACTS.training_load_day).`,
      `  2. Connect fueling to their daily energy and macro band ` +
        `(FACTS.daily_eer_kcal, FACTS.daily_protein_g, FACTS.daily_carb_g) ` +
        `when those numbers exist.`,
      `  3. Give 2–3 specific, actionable improvements built ONLY from ` +
        `FACTS.liked_foods (and FACTS.fav_foods_free_text if present). ` +
        `Never recommend anything in FACTS.disliked_foods or contrary to ` +
        `FACTS.dietary_requirements. If FACTS.medical lists conditions, stay ` +
        `general — encourage seeing a clinician — never diagnose.`,
      `  4. Close with one concrete next step.`,
      ``,
      `Hard format rules (non-negotiable):`,
      `  - Open with: "Hey ${firstName}."`,
      `  - Under 200 words total. Maximum 3 short paragraphs. NO bullet points. NO headings.`,
      `  - Address ${firstName} as "you" throughout.`,
      `  - Never use the words "healthy" or "unhealthy".`,
      `  - Show energy as "X cal (Y kJ)" when referencing a number; round cal ` +
        `to nearest 10, kJ to nearest 100.`,
      ``,
      `FACTS (JSON):`,
      factsJson,
    ].join("\n");

    let draft = "";
    try {
      draft = await callLlmText(userPrompt, {
        system: MASTER_SYSTEM_PROMPT,
        json: false,
      });
    } catch (e) {
      console.error("studentFeedbackDraftPost LLM error", e);
      return res.status(502).json({
        error: "LLM call failed",
        detail: e.message || String(e),
      });
    }

    const stopped = applyHardStopTemplates(draft, { firstName });
    draft = stopped.text;
    draft = stripHealthyUnhealthy(draft);

    res.json({
      draft,
      first_name: firstName,
      hard_stop_triggered: !!stopped.flagged,
    });
  } catch (e) {
    console.error("studentFeedbackDraftPost", e);
    res.status(500).json({ error: e.message || "Draft generation failed" });
  }
}

module.exports = {
  mealAnalysisGet,
  mealAnalysisPost,
  mealAnalysisV3Post,
  mealCarouselPost,
  mealCarouselDraftsGet,
  mealCarouselDraftsPost,
  missionFeedbackDraftPost,
  studentFeedbackDraftPost,
  saveSuggestionPost,
  mealImageGeneratePost,
};
