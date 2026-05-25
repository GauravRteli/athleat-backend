const { query } = require("../config/postgres");
const { resolveStorageUrl } = require("../utils/storageUrl");
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
const {
  extractIngredients,
  resolveIngredients,
} = require("../services/kez/ingredientMatcher");
const {
  buildCandidatePool: buildV3CandidatePool,
  runPrompt3: runV3Prompt3,
  splitMealText: splitV3MealText,
} = require("../services/kez/v3Carousel");
const { runPrompt2 } = require("../services/kez/prompt2");

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

// ─────────────────────────────────────────────────────────────────────────────
// Run Kez Analysis (V1/V2) — Prompt-4 flow.
//
// Database-first, AI-as-last-resort. Claude no longer reads the meal photo:
//   1. Parse title + description into [{ ingredient, qty, unit }] (Claude → fallback).
//   2. Resolve each ingredient through a 4-tier DB cascade
//      (items verified → items unverified → AFCD → AUSNUT2023) and only
//      fall through to a Claude per-100g estimate (Prompt 5) when all four miss.
//   3. Sum macros, compute slot target band.
//   4. Call Claude once with Prompt 4 (verbatim from the implementation guide)
//      for coaching analysis only. Trailing JSON block carries
//      { tags: { fuel, repair, protect }, kerry_flag }.
// ─────────────────────────────────────────────────────────────────────────────

// Verbatim Prompt 4 — see ATHLEAT KerryDashboard v5.2 Implementation Guide.
function buildPrompt4({
  firstName,
  sex,
  weight,
  age,
  goal,
  loadType,
  missionLabel,
  slotLabel,
  version,
  liked,
  disliked,
  matchedLines,
  totals,
  band,
}) {
  const kcal = Math.round(totals.kcal || 0);
  const kj = Math.round(totals.kj || totals.energy_kj || 0);
  const p = Math.round(totals.protein_g || 0);
  const c = Math.round(totals.carb_g || 0);
  const f = Math.round(totals.fat_g || 0);

  const slotKcalLow = band?.kcal_low ?? "?";
  const slotKcalHigh = band?.kcal_high ?? "?";
  const slotKjLow = band?.kj_low ?? "?";
  const slotKjHigh = band?.kj_high ?? "?";
  const slotPLow = band?.p_low ?? "?";
  const slotPHigh = band?.p_high ?? "?";
  const slotCLow = band?.c_low ?? "?";
  const slotCHigh = band?.c_high ?? "?";

  const likedStr = Array.isArray(liked) ? liked.join(", ") : String(liked || "");
  const dislikedStr = Array.isArray(disliked) ? disliked.join(", ") : String(disliked || "");

  return [
    "You are Virtual Kez. Kerry has edited and verified the ingredient list for this meal.",
    "Your job is coaching analysis only - the macros have already been matched from the database.",
    "",
    `ATHLETE: ${firstName}, ${sex}, ${weight}kg, ${age}yo, rugby league.`,
    `Goal: ${goal}`,
    `Training load today: ${loadType}`,
    `Mission: ${missionLabel} - ${slotLabel}`,
    `V1 or V2: ${version}`,
    `Liked foods: ${likedStr}`,
    `Disliked foods: ${dislikedStr}`,
    "",
    "MATCHED INGREDIENTS (from food database):",
    matchedLines.length ? matchedLines.join("\n") : "(no ingredients matched)",
    "",
    `MEAL TOTALS: P:${p}g C:${c}g F:${f}g | ${kcal} cal (${kj} kJ)`,
    "",
    `MEAL SLOT TARGET (${slotLabel}, ${loadType} day, ${goal} goal):`,
    `Energy: ${slotKcalLow}-${slotKcalHigh} kcal (${slotKjLow}-${slotKjHigh} kJ)`,
    `Protein: ${slotPLow}-${slotPHigh}g`,
    `Carbs: ${slotCLow}-${slotCHigh}g`,
    "",
    "Provide coaching analysis following this exact sequence:",
    `1. Assess carbohydrate - is there enough fuel for ${loadType} training load?`,
    "   Compare meal carbs against slot target. Flag if significantly under or over.",
    "2. Assess protein - right amount for this meal and timing?",
    "   Flag if under 30g for athletes over 80kg.",
    "3. One micronutrient observation only. One only unless critical.",
    "4. Give 2-3 specific actionable improvements using their liked foods where possible.",
    "   Never remove a food they love - improve it.",
    "5. One genuine specific positive. Not generic.",
    "",
    "FORMAT RULES:",
    "- Under 150 words.",
    "- Short paragraphs. No bullet points.",
    "- Address athlete as you throughout.",
    "- Never use the word healthy or unhealthy.",
    "- Never show macros or numbers to the athlete.",
    "Use performance language: good fuel for a high day, light on recovery protein, etc.",
    "",
    "Start the coaching message with `Hey " + firstName + ".`",
    "",
    "AFTER the coaching message, on a new line, output ONLY this JSON block (no markdown fences, no commentary):",
    '{"tags":{"fuel":"on target / light / over","repair":"on target / light / over","protect":"short phrase"},"kerry_flag":null}',
    "Set kerry_flag to a short string ONLY if there is a clinical concern Kerry should review, else null.",
  ].join("\n");
}

// Format one matched ingredient as a Prompt-4 line.
//   `name | 150g | P:30g C:0g F:3g | 651kJ | source: woolworths`
function ingredientToPromptLine(row) {
  const grams = Math.round(Number(row.grams) || 0);
  const m = row.macros || {};
  const p = Math.round(Number(m.protein_g) || 0);
  const c = Math.round(Number(m.carb_g) || 0);
  const f = Math.round(Number(m.fat_g) || 0);
  const kj = Math.round(Number(m.energy_kj) || 0);
  const sourceMap = {
    items_verified: "woolworths",
    items_unverified: "library",
    generic_afcd: "AFCD",
    generic_ausnut: "AUSNUT2023",
    ai_estimate: "ai_estimate",
    unresolved: "unresolved",
  };
  const src = sourceMap[row.source] || row.source || "unknown";
  const name = row.matched_name || row.ingredient;
  return `${name} | ${grams}g | P:${p}g C:${c}g F:${f}g | ${kj}kJ | source: ${src}`;
}

// Try to find the trailing JSON {"tags": ...} block in the model response.
// Splits the prose from the JSON; returns { prose, tags, kerry_flag }.
function splitFeedbackAndTags(raw) {
  const text = String(raw || "");
  // Search from the right for a "{" that contains "tags" — the last one
  // matching is the one we want.
  const matches = [...text.matchAll(/\{[\s\S]*?\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = matches[i][0];
    if (/"tags"\s*:/.test(candidate)) {
      try {
        const parsed = JSON.parse(candidate);
        const prose = text.slice(0, matches[i].index).trim();
        return {
          prose,
          tags: parsed.tags || null,
          kerry_flag: parsed.kerry_flag ?? null,
        };
      } catch {
        // Try a more aggressive grab: from the candidate's opening brace
        // to the end of the text.
        const tail = text.slice(matches[i].index);
        const obj = extractJsonObject(tail);
        if (obj) {
          try {
            const parsed = JSON.parse(obj);
            const prose = text.slice(0, matches[i].index).trim();
            return {
              prose,
              tags: parsed.tags || null,
              kerry_flag: parsed.kerry_flag ?? null,
            };
          } catch {
            /* fall through */
          }
        }
      }
    }
  }
  // No tags JSON detected — return the whole thing as prose.
  return { prose: text.trim(), tags: null, kerry_flag: null };
}

// Derive Fuel/Repair/Protect tags from macros vs target band as a fallback
// when Claude omits / mangles the trailing JSON.
function deriveTagsFromMacros(totals, band) {
  const tagFor = (value, low, high) => {
    if (value == null || low == null || high == null) return "unknown";
    if (value < low * 0.8) return "light";
    if (value > high * 1.2) return "over";
    return "on target";
  };
  return {
    fuel: tagFor(totals.carb_g, band?.c_low, band?.c_high),
    repair: tagFor(totals.protein_g, band?.p_low, band?.p_high),
    protect: "review micronutrients",
  };
}

async function mealAnalysisPost(req, res) {
  const t0 = Date.now();
  try {
    console.log(
      "\n" + "═".repeat(78) + "\n" +
      "║  🚀 RUN KEZ ANALYSIS — Prompt-4 DB-first flow (start)\n" +
      "═".repeat(78),
    );
    const {
      student_id,
      mission_id,
      slot_id,
      image_url,
      meal_text = "",
      title: titleIn = "",
      description: descIn = "",
      slot_label,
      mission_name,
      load_day,
      training_load_day,
    } = req.body || {};
    const version = req.body?.version === "v2" ? "v2" : "v1";

    console.log("[mealAnalysis] STEP 0 · request received:", {
      student_id,
      mission_id,
      slot_id,
      version,
      slot_label,
      mission_name,
      title: titleIn,
      description: descIn,
      has_meal_text: !!meal_text,
      has_image: !!image_url,
    });

    if (!student_id || !mission_id || !slot_id) {
      console.warn("[mealAnalysis] ✗ missing required fields");
      return res.status(400).json({ error: "student_id, mission_id, slot_id required" });
    }

    // Derive title + description from the legacy `meal_text` field if the
    // caller didn't send them separately ("Title — Description" was the v1 shape).
    let title = String(titleIn || "").trim();
    let description = String(descIn || "").trim();
    if (!title && !description && meal_text) {
      const parts = String(meal_text).split(/\s+[—-]\s+/);
      title = (parts[0] || "").trim();
      description = (parts.slice(1).join(" — ") || "").trim();
      console.log("[mealAnalysis]   ⤷ derived from legacy meal_text:", { title, description });
    }

    if (!title && !description) {
      console.warn("[mealAnalysis] ✗ no title or description to parse");
      return res.status(400).json({
        error: "title or description required for ingredient extraction",
        code: "MISSING_INGREDIENTS",
      });
    }

    const lbl = slot_label || slot_id;
    const missionLabel = mission_name || lbl;

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

    const prescreen = prescreenRows?.[0] || {};
    const inferredLoadDay = classifyLoadFromPrescreen(prescreen);
    const explicitLoadDay = normalizeLoadDay(load_day || training_load_day);
    const loadDay = explicitLoadDay || inferredLoadDay;
    const loadDaySource = explicitLoadDay ? "client" : "prescreen_inferred";
    const daily = computeDailyEER(prescreen, loadDay, eerConfig);
    const fraction = mealFractionForSlot(lbl);
    const targetBand = daily ? mealTargetBand(daily, fraction) : null;
    const category = slotCategory(lbl);

    console.log("[mealAnalysis] STEP 1 · athlete + targets:", {
      firstName,
      sex: prescreen.sex,
      weight_kg: prescreen.weight_kg ?? prescreen.weight,
      age: ageFromDob(prescreen.dob),
      loadDay,
      loadDaySource,
      mealFraction: fraction,
      slotCategory: category,
      targetBand,
      liked_foods_count: likedFoods.length,
    });

    // ── Step 2: extract ingredients from title + description ───────────────
    console.log("[mealAnalysis] STEP 2 · extract ingredients from title+description");
    const parsed = await extractIngredients({ title, description });

    // ── Step 3-5: resolve each ingredient through DB cascade → AI fallback ─
    console.log("[mealAnalysis] STEP 3 · resolve each ingredient (4-tier DB → AI)");
    const resolvedItems = await resolveIngredients(parsed);

    // ── Sum macros ─────────────────────────────────────────────────────────
    const macroLines = resolvedItems
      .filter((r) => r.macros)
      .map((r) => ({
        protein_g: r.macros.protein_g || 0,
        carb_g: r.macros.carb_g || 0,
        fat_g: r.macros.fat_g || 0,
        energy_kj: r.macros.energy_kj || 0,
        energy_kcal: r.macros.energy_kcal || 0,
      }));
    const macro_totals_full = finalizeTotals(sumMacros(macroLines));
    // Carry both `kcal` (legacy field name from finalizeTotals) and
    // `energy_kcal` (what the frontend reads).
    const macro_totals = {
      ...macro_totals_full,
      energy_kcal: macro_totals_full.kcal,
      energy_kj: macro_totals_full.energy_kj,
    };
    const vs_targets = targetBand ? buildVsTargets(macro_totals, targetBand) : {};

    const flags = [];
    const sourceSummary = resolvedItems.reduce((acc, r) => {
      acc[r.source] = (acc[r.source] || 0) + 1;
      return acc;
    }, {});
    if (sourceSummary.ai_estimate) flags.push("source:ai_estimate");
    if (sourceSummary.unresolved) flags.push("source:unresolved");
    if (resolvedItems.some((r) => r.unit_note === "unit_unverified")) {
      flags.push("unit_unverified");
    }

    // Coverage confidence — verified hits weighted highest, AI estimates lowest.
    const confidenceFor = (src) => {
      switch (src) {
        case "items_verified":
          return 0.95;
        case "items_unverified":
          return 0.8;
        case "generic_afcd":
          return 0.8;
        case "generic_ausnut":
          return 0.75;
        case "ai_estimate":
          return 0.5;
        default:
          return 0.0;
      }
    };
    const conf = resolvedItems.length
      ? Math.round(
          (resolvedItems.reduce((sum, r) => sum + confidenceFor(r.source), 0) /
            resolvedItems.length) *
            10000,
        ) / 10000
      : 0;
    let needs_correction = conf < 0.5 || resolvedItems.length === 0;

    console.log("[mealAnalysis] STEP 4 · macro totals:", macro_totals);
    console.log("[mealAnalysis]   ⤷ source summary:", sourceSummary);
    console.log("[mealAnalysis]   ⤷ confidence:", conf, "needs_correction:", needs_correction);
    console.log("[mealAnalysis]   ⤷ vs targets:", vs_targets);

    // ── Step 5: Coaching analysis — Claude with Prompt 4 ───────────────────
    const matchedLines = resolvedItems.map(ingredientToPromptLine);
    const sex = prescreen.sex || "Male";
    const weight = Math.round(
      Number(prescreen.weight_kg ?? prescreen.weight ?? 0),
    );
    const age = ageFromDob(prescreen.dob) || "?";
    const goal = prescreen.goals || prescreen.goal || "performance";
    const dislikedList = dislikeList(prescreen);

    const prompt4 = buildPrompt4({
      firstName,
      sex,
      weight,
      age,
      goal,
      loadType: loadDay,
      missionLabel,
      slotLabel: lbl,
      version,
      liked: likedFoods,
      disliked: dislikedList,
      matchedLines,
      totals: macro_totals,
      band: targetBand,
    });

    console.log("[mealAnalysis] STEP 5 · calling Claude with Prompt 4 (coaching analysis)");
    console.log("[mealAnalysis]   ⤷ matched ingredient lines fed to Claude:");
    matchedLines.forEach((l, i) => console.log(`      ${i + 1}. ${l}`));

    let rawCoaching = "";
    try {
      rawCoaching = await callLlmText(prompt4, {
        system:
          "You are Virtual Kez, a sports performance nutrition coach for rugby league athletes. Coaching analysis only — never show macros or raw numbers to the athlete. Always start with `Hey {firstName}.` and end with the trailing tags JSON exactly as instructed.",
        json: false,
      });
      console.log("[mealAnalysis]   ✓ Claude responded, length =", rawCoaching.length, "chars");
    } catch (e) {
      console.error("[mealAnalysis]   ✗ Claude coaching call failed:", e.message || e);
      flags.push("model_error");
      needs_correction = true;
      rawCoaching = `Hey ${firstName}. I couldn't finish this analysis right now — try again in a moment.`;
    }

    let { prose: feedback_text, tags, kerry_flag } = splitFeedbackAndTags(rawCoaching);
    console.log("[mealAnalysis]   ⤷ parsed tags:", tags, "kerry_flag:", kerry_flag);

    // Apply existing post-processing guards on the prose only.
    const stopped = applyHardStopTemplates(feedback_text, { firstName });
    feedback_text = stopped.text;
    if (stopped.flagged) {
      needs_correction = true;
      flags.push("hard_stop_medical");
    }
    feedback_text = stripHealthyUnhealthy(feedback_text);

    const valid = validateMealFeedback(feedback_text, {
      firstName,
      mealAnalysis: true,
      slotLabel: lbl,
    });
    const blockingIssues = (valid.issues || []).filter(
      (i) => i !== "missing_slot_alignment",
    );
    if (blockingIssues.length) {
      needs_correction = true;
      flags.push(...blockingIssues.map((i) => `validator_${i}`));
    } else if ((valid.issues || []).includes("missing_slot_alignment")) {
      flags.push("soft_missing_slot_alignment");
    }

    // Fallback tags from macros vs band if Claude omitted the JSON.
    if (!tags) {
      tags = deriveTagsFromMacros(macro_totals, targetBand);
      flags.push("tags_derived_from_macros");
    }

    // ── Persist ────────────────────────────────────────────────────────────
    const resolvedImageUrl = resolveStorageUrl(image_url || "") || image_url || null;
    const persistedMealText =
      meal_text || [title, description].filter(Boolean).join(" — ");

    const model_meta = {
      route: "meal-analysis-v2",
      load_day_source: loadDaySource,
      slot_label: lbl,
      mission_label: missionLabel,
      goal,
      liked_foods: likedFoods,
      disliked_foods: dislikedList,
      parsed_ingredients: parsed,
      ingredient_sources_summary: sourceSummary,
      tags,
      kerry_flag,
      prompt_version: "prompt-4-db-first",
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
        persistedMealText,
        loadDay,
        category,
        jsonbString(null),
        jsonbString(resolvedItems),
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
      console.error("[mealAnalysis] ✗ DB insert returned no id");
      return res.status(500).json({ error: "Failed to save analysis" });
    }

    const ms = Date.now() - t0;
    console.log("[mealAnalysis] STEP 6 · persisted meal_analysis row id =", inserted.id);
    console.log(
      "[mealAnalysis] ✅ COMPLETE in", ms, "ms",
      "| ingredients =", resolvedItems.length,
      "| confidence =", conf,
      "| flags =", flags,
    );
    console.log("═".repeat(78) + "\n");

    res.json({
      analysis_id: inserted.id,
      feedback_text,
      macro_totals,
      target_band: targetBand,
      vs_targets,
      resolved_items: resolvedItems,
      confidence: conf,
      needs_correction,
      flags,
      tags,
      kerry_flag,
      ingredient_sources_summary: sourceSummary,
    });
  } catch (e) {
    console.error("[mealAnalysis] ✗ FATAL", e);
    res.status(500).json({ error: e.message || "Kez unavailable" });
  }
}

// Convert a legacy meal row + foods into a V3 carousel card.
function legacyMealToCarouselCard(meal) {
  const foods = (meal.meal_foods || []).map((f) => ({
    item_id: f.item_id,
    food_id: f.item_id,
    food_name: f.food_name,
    qty: f.qty != null ? String(f.qty) : (f.item_qty != null ? String(f.item_qty) : ""),
    unit: f.unit || f.item_qty_unit || "g",
    item_qty: f.item_qty,
    item_qty_unit: f.item_qty_unit,
    selected_qty_unit: f.selected_qty_unit,
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
    image_url: resolveStorageUrl(meal.image_url || meal.image || ""),
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
              im.item_qty, im.item_qty_unit, im.selected_qty_unit,
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
      qty: r.item_qty != null ? String(r.item_qty) : "",
      unit: r.item_qty_unit || "g",
      item_qty: r.item_qty,
      item_qty_unit: r.item_qty_unit,
      selected_qty_unit: r.selected_qty_unit,
      weight_g: Number(r.item_qty) || null,
      weight_grams: Number(r.item_qty) || null,
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
      image_url: resolveStorageUrl(r.image || ""),
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

// =============================================================================
// V3 Meal Carousel — Prompt-3 flow (database-first, Claude as ranker/copywriter).
//
// Pipeline:
//   STEP 0   parse request + load student / prescreen / EER / liked foods.
//   STEP 1   resolve v1 / v2 from `meal_analysis` (latest per version)
//              → split each meal_text into { title, description }.
//              client can override via body { v1_title, v1_description, … }.
//   STEP 2   build the candidate pool via `v3Carousel.buildCandidatePool`
//              → embed athlete query → match_meals → hydrate ingredients
//              → re-rank by (sim × overlap × liked) → top-10 pool.
//   STEP 3   call `runV3Prompt3` → Claude Prompt 3 verbatim →
//              { meals[4], v2_slot, ai_generate_slot } with deterministic
//              fallback if Claude errors or returns malformed JSON.
//   STEP 4   hydrate the 4 picked meal_ids via `loadLegacyMealsByIds` so
//              the frontend gets image_url + foods[] + categories.
//   STEP 5   merge Claude's authored copy + flags onto the hydrated card.
//
// The response is a backwards-compatible superset of the v5.2 shape:
// `suggestions[]` is still present (legacy DashboardClient/v5.1 consumers)
// AND the new top-level `meals` / `v2_slot` / `ai_generate_slot` fields are
// added for ViewSelectionsModal to consume directly.
// =============================================================================
async function mealCarouselPost(req, res) {
  try {
    const body = req.body || {};
    const {
      student_id,
      mission_id,
      slot_id,
      based_on: basedRaw,
      meal_analysis_id,
      slot_label,
      mission_name,
      liked_foods: likedFoodsBody,
      exclude_ids: excludeIdsBody,
      load_day,
      training_load_day,
    } = body;
    let target_count = Number(body.target_count) || 4;
    const based_on = basedRaw === "v2" ? "v2" : "v1";
    const requestedLiked = Array.isArray(likedFoodsBody) ? likedFoodsBody : [];
    const clientExcludeIds = Array.isArray(excludeIdsBody)
      ? excludeIdsBody.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : [];
    const lbl = slot_label || slot_id;

    console.log("[v3Carousel] STEP 0 · request received:", {
      student_id,
      mission_id,
      slot_id,
      based_on,
      slot_label: lbl,
      mission_name,
      target_count,
      client_excludes: clientExcludeIds.length,
      client_liked: requestedLiked.length,
    });

    if (!student_id || !mission_id || !slot_id) {
      return res.status(400).json({ error: "student_id, mission_id, slot_id required" });
    }

    // ── Pin the analysis row that drives the response ─────────────────────
    let analysis = null;
    if (meal_analysis_id) {
      const { rows } = await query(
        `SELECT * FROM public.meal_analysis WHERE id = $1`,
        [meal_analysis_id],
      );
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

    // ── Parallel fetch: student, prescreen, EER, liked foods, side analyses
    const sideAnalysesPromise = query(
      `SELECT version, meal_text, image_url, resolved_items, macro_totals, model_meta
         FROM public.meal_analysis
        WHERE student_id = $1 AND mission_id = $2 AND slot_id = $3
        ORDER BY created_at DESC`,
      [student_id, mission_id, slot_id],
    );

    const [
      { rows: studentRows },
      { rows: prescreenRows },
      { rows: eerRows },
      dbLikedFoods,
      { rows: sideAnalysisRows },
    ] = await Promise.all([
      query(
        `SELECT id, full_name, first_name, last_name
           FROM public.students WHERE id = $1`,
        [student_id],
      ),
      query(`SELECT * FROM public.prescreen WHERE student_id = $1`, [student_id]),
      query(`SELECT * FROM public.eer_config WHERE id = 1`),
      likedFoodsForStudent(student_id),
      sideAnalysesPromise,
    ]);

    const studentRow = studentRows?.[0];
    if (!studentRow) return res.status(404).json({ error: "Student not found" });

    const firstName =
      studentRow.first_name ||
      String(studentRow.full_name || "Athlete").trim().split(/\s+/)[0] ||
      "Athlete";
    const lastName =
      studentRow.last_name ||
      String(studentRow.full_name || "").trim().split(/\s+/).slice(1).join(" ") ||
      "";

    const prescreen = prescreenRows?.[0] || {};
    const eerRow = eerRows?.[0];

    // Merge client-supplied liked foods with the DB resolved list.
    const liked_foods = Array.from(
      new Set([...dbLikedFoods, ...requestedLiked].filter(Boolean)),
    );

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

    const explicitLoad = normalizeLoadDay(load_day || training_load_day);
    const loadDay = explicitLoad || classifyLoadFromPrescreen(prescreen);
    const daily = computeDailyEER(prescreen, loadDay, eerConfig);
    const fraction = mealFractionForSlot(lbl);
    const targetBand = daily ? mealTargetBand(daily, fraction) : null;
    // Add kJ fields to band for Prompt 3 (display only).
    if (targetBand) {
      targetBand.kj_low = Math.round(targetBand.kcal_low * 4.184);
      targetBand.kj_high = Math.round(targetBand.kcal_high * 4.184);
    }

    const category = analysis?.category || slotCategory(lbl);
    const dislikes = dislikeList(prescreen);

    // ── STEP 1 · resolve v1 / v2 from meal_analysis ───────────────────────
    const v1Row = (sideAnalysisRows || []).find((r) => r.version === "v1");
    const v2Row = (sideAnalysisRows || []).find((r) => r.version === "v2");
    const v3Rows = (sideAnalysisRows || []).filter((r) => r.version === "v3");

    const v1FromDb = splitV3MealText(v1Row?.meal_text);
    const v2FromDb = splitV3MealText(v2Row?.meal_text);
    const v1 = {
      title: body.v1_title || v1FromDb.title,
      description: body.v1_description || v1FromDb.description,
      meal_text: v1Row?.meal_text || "",
    };
    const v2 = {
      title: body.v2_title || v2FromDb.title,
      description: body.v2_description || v2FromDb.description,
      meal_text: v2Row?.meal_text || "",
    };

    // Past-V3 exclude (canonical meal_id stored on V3 analyses + in-session).
    const v3PastMealIds = v3Rows
      .map((r) => Number(r?.model_meta?.meal_id))
      .filter((n) => Number.isFinite(n) && n > 0);
    const excludeMealIds = Array.from(
      new Set([...v3PastMealIds, ...clientExcludeIds]),
    );

    console.log("[v3Carousel] STEP 1 · context resolved:", {
      firstName,
      lastName,
      sex: prescreen.sex,
      weight_kg: prescreen.weight_kg ?? prescreen.weight,
      height_cm: prescreen.height_cm ?? prescreen.height,
      age: ageFromDob(prescreen.dob),
      goal: prescreen.goals || prescreen.goal,
      loadDay,
      category,
      liked_count: liked_foods.length,
      dislike_count: dislikes.length,
      v1_title: v1.title,
      v2_title: v2.title,
      target_band: targetBand,
      excludeMealIds,
    });

    // ── STEP 2 · candidate pool (vector + re-rank) ────────────────────────
    const { pool, leftover, embedded } = await buildV3CandidatePool({
      category,
      slotLabel: lbl,
      v1MealText: v1Row?.meal_text || null,
      v2MealText: v2Row?.meal_text || null,
      v3MealTexts: v3Rows.map((r) => r.meal_text).filter(Boolean),
      likedFoods: liked_foods,
      dislikedFoods: dislikes,
      excludeIds: excludeMealIds,
      targetBand,
    });

    // Fallback: if the embedding pipeline returned an empty pool, fall back
    // to the legacy recency-by-category id list. We then re-hydrate the
    // basic macros so Prompt 3 still has cards to choose from.
    let workingPool = pool;
    if (!workingPool.length) {
      console.warn(
        "[v3Carousel]   ⚠ vector pool empty — using recency fallback by category",
      );
      const fallbackIds = await fetchFallbackMealIds(
        category,
        [], // no dislike exclusion — surface for flagging
        25,
        excludeMealIds,
      );
      if (fallbackIds.length) {
        const recencyHydrated = await loadLegacyMealsByIds(fallbackIds);
        workingPool = recencyHydrated.map((m) => ({
          id: Number(m.id),
          title: m.title,
          description: m.description || "",
          protein_g: Number(m.protein_g) || 0,
          carb_g: Number(m.carb_g) || 0,
          fat_g: Number(m.fat_g) || 0,
          energy_kj: Number(m.energy_kj) || 0,
          energy_kcal: Number(m.energy_kcal) || 0,
          tags: [],
          ingredients: (m.meal_foods || []).map((f) => f.food_name).filter(Boolean),
          simScore: 0.5,
          overlapScore: 0,
          likedScore: 0,
          finalScore: 0.5,
          disliked_flag: null,
          disliked_substitute: null,
        }));
      }
    }

    // ── STEP 3 · Claude Prompt 3 (ranker + copywriter) ────────────────────
    const promptResult = await runV3Prompt3({
      athlete: {
        firstName,
        lastName,
        sex: prescreen.sex || "Male",
        weight: prescreen.weight_kg ?? prescreen.weight ?? null,
        height: prescreen.height_cm ?? prescreen.height ?? null,
        age: ageFromDob(prescreen.dob),
      },
      prefs: {
        goal: prescreen.goals || prescreen.goal || "performance",
        loadType: String(loadDay || "Moderate").toLowerCase(),
        liked: liked_foods,
        disliked: dislikes,
      },
      slot: {
        missionId: mission_id,
        slotId: slot_id,
        label: lbl,
        missionLabel: mission_name || lbl,
      },
      v1,
      v2,
      band: targetBand,
      pool: workingPool,
    });

    console.log(
      `[v3Carousel] STEP 3 · Claude source="${promptResult.source}" · meals=${promptResult.meals.length}`,
    );

    // ── STEP 4 · hydrate the 4 picks for the frontend ─────────────────────
    const pickedIds = promptResult.meals
      .map((m) => Number(m.meal_id))
      .filter((n) => Number.isFinite(n));
    const hydrated = pickedIds.length ? await loadLegacyMealsByIds(pickedIds) : [];
    const hydratedById = new Map(hydrated.map((m) => [Number(m.id), m]));

    // ── STEP 5 · merge Claude's copy onto the hydrated card ───────────────
    const mergedMeals = promptResult.meals.map((pick) => {
      const meal = hydratedById.get(Number(pick.meal_id));
      const card = meal
        ? legacyMealToCarouselCard(meal)
        : {
            id: pick.meal_id,
            meal_id: pick.meal_id,
            title: pick.title,
            description: pick.description,
            blueprintNote: pick.blueprint_note,
            image_url: "",
            image_prompt: "",
            source: "database",
            unverified_foods: [],
            foods: [],
            totals: {
              energy_kj: pick.slot_energy_kj,
              energy_kcal: pick.slot_energy_kcal,
              protein_g: pick.protein_g,
              carb_g: pick.carb_g,
              fat_g: pick.fat_g,
            },
            formatted_macros: formatCarouselMacros({
              p: pick.protein_g,
              c: pick.carb_g,
              f: pick.fat_g,
              kcal: pick.slot_energy_kcal,
              kj: pick.slot_energy_kj,
            }),
            categories: [],
          };

      return {
        ...card,
        title: pick.title || card.title,
        description: pick.description || card.description,
        blueprintNote: pick.blueprint_note || card.blueprintNote,
        blueprint_note: pick.blueprint_note || card.blueprintNote,
        disliked_flag: pick.disliked_flag,
        disliked_substitute: pick.disliked_substitute,
        slot_energy_kcal: pick.slot_energy_kcal,
        slot_energy_kj: pick.slot_energy_kj,
        protein_g: pick.protein_g,
        carb_g: pick.carb_g,
        fat_g: pick.fat_g,
        source: "database",
      };
    });

    // Maintain backwards compatibility: DashboardClient + v5.1 still read
    // `suggestions`. Newer ViewSelectionsModal reads `meals` / `v2_slot` /
    // `ai_generate_slot` directly.
    const response = {
      suggestions: mergedMeals,
      meals: mergedMeals,
      v2_slot: promptResult.v2_slot,
      ai_generate_slot: promptResult.ai_generate_slot,
      target_count: mergedMeals.length || target_count,
      target_band: targetBand,
      category,
      source: promptResult.source,
      embedded,
      pool_size: workingPool.length,
      leftover_size: leftover?.length || 0,
      analysis_id: analysis?.id || null,
    };

    console.log(
      `[v3Carousel] STEP 5 · responding with ${mergedMeals.length} meals (source=${promptResult.source})`,
    );

    res.json(response);
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
// Body: {
//   student_id,
//   mission_id,
//   mission_label?,          // frontend MISSION_DEFS.name (e.g. "Breakfast")
//   slot_defs?,              // frontend slots [{ id, label }, ...] for this mission
//   v3?,                     // in-memory v5.2 v3Slots keyed by slot_id
//   prompt_version?,         // "v2" (new Prompt 2) or unset (legacy behaviour)
// }
async function missionFeedbackDraftPost(req, res) {
  try {
    const {
      student_id,
      mission_id,
      mission_label,
      slot_defs,
      v3: v3Body,
      prompt_version,
    } = req.body || {};
    if (!student_id || !mission_id) {
      return res.status(400).json({ error: "student_id, mission_id required" });
    }

    // ─── Prompt 2 path (verbatim Kerry spec, v5.2) ──────────────────────────
    // Triggered when the frontend passes `prompt_version: "v2"` AND supplies
    // its MISSION_DEFS slot defs (so we have the human-readable slot labels
    // and ordering). v5.2 also passes its in-memory `v3Slots` so V3 picks
    // are reflected even though v5.2 never writes V3 to meal_analysis.
    if (
      String(prompt_version || "").toLowerCase() === "v2" &&
      Array.isArray(slot_defs) &&
      slot_defs.length > 0
    ) {
      try {
        // Fallback v3 source: public.missions.v3 JSONB (post-Send), so
        // re-opening a mission after Kerry sent feedback still surfaces v3.
        let missionRowV3 = {};
        try {
          const { rows: mRows } = await query(
            `SELECT v3 FROM public.missions
              WHERE student_id = $1 AND mission_id = $2 LIMIT 1`,
            [student_id, mission_id],
          );
          missionRowV3 =
            (mRows?.[0]?.v3 && typeof mRows[0].v3 === "object" && mRows[0].v3) ||
            {};
        } catch (e) {
          console.warn(
            "[Prompt 2] missions.v3 fallback read failed:",
            e.message,
          );
        }

        const result = await runPrompt2({
          studentId: student_id,
          missionId: mission_id,
          missionLabel: mission_label || null,
          slotDefs: slot_defs,
          v3Override: v3Body || {},
          missionRowV3,
        });

        return res.json({
          draft: result.draft,
          original_draft: result.draft,
          first_name: result.facts.firstName,
          mission_label: result.facts.mission_label,
          used_analyses: result.facts.used_analyses,
          slot_count: result.facts.slots.length,
          hard_stop_triggered: result.hard_stop_triggered,
          prompt_version: "v2",
        });
      } catch (e) {
        console.error("[Prompt 2] runPrompt2 failed:", e);
        return res.status(502).json({
          error: "Prompt 2 draft failed",
          detail: e.message || String(e),
        });
      }
    }

    // ─── Legacy path (DashboardClient.js — kept for backwards compat) ──────
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

// =============================================================================
// POST /api/kez/estimate-macros
// =============================================================================
//
// v5.2 helper: take a free-text food/meal description (and optional
// foods[] / serving info) and return a rough per-serving macro estimate
// using the same Claude / OpenAI fallback chain the rest of Kez uses.
//
// Body:
//   {
//     kind?: "food" | "meal",          // mainly for prompt phrasing
//     name?, description?, notes?,
//     serving_label?,                  // e.g. "1 cup", "100 g"
//     foods?: [{ food_name, weight_g?, qty?, unit? }],
//   }
//
// Returns: { data: { energy_kcal, energy_kj, protein_g, carb_g, fat_g } }
// All numeric fields are best-effort integers; never throws if the LLM
// reply isn't perfectly shaped (missing fields come back as null).
async function estimateMacrosPost(req, res) {
  try {
    const b = req.body || {};
    const kind = String(b.kind || "meal").toLowerCase() === "food" ? "food" : "meal";

    const name = String(b.name || b.title || "").trim();
    const description = String(b.description || "").trim();
    const notes = String(b.notes || "").trim();
    const servingLabel = String(b.serving_label || b.serving || "").trim();

    const foodsLines = (Array.isArray(b.foods) ? b.foods : [])
      .map((f) => {
        if (!f || typeof f !== "object") return "";
        const nm = String(f.food_name || f.name || f.title || "").trim();
        if (!nm) return "";
        const w = f.weight_g ?? f.weight_grams ?? f.grams_estimate;
        const qty = f.qty ?? f.quantity;
        const unit = f.unit;
        if (Number.isFinite(Number(w))) return `${nm} (~${Math.round(Number(w))} g)`;
        if (qty && unit) return `${nm} (${qty} ${unit})`;
        return nm;
      })
      .filter(Boolean);

    if (!name && !description && foodsLines.length === 0) {
      return res
        .status(400)
        .json({ error: "Provide at least a name, description, or foods[]." });
    }

    const system = [
      "You are a sports nutrition assistant.",
      "Given a description of a single",
      kind === "food" ? "food item" : "meal",
      "(plus optional list of ingredients/weights and a serving label),",
      "estimate its macronutrients PER SERVING.",
      "",
      "Output STRICT JSON only — no markdown, no preamble — with this exact shape:",
      "{",
      '  "energy_kcal": number | null,',
      '  "energy_kj":   number | null,',
      '  "protein_g":   number | null,',
      '  "carb_g":      number | null,',
      '  "fat_g":       number | null,',
      '  "notes":       string | null',
      "}",
      "",
      "If you can't make a reasonable estimate (e.g. the description is empty),",
      "return all numeric fields as null and put the reason in `notes`.",
      "Round numbers to whole integers. If only kcal is known set kj ≈ kcal * 4.184.",
    ].join(" ");

    const userText = [
      `Kind: ${kind}`,
      name ? `Name: ${name}` : "",
      description ? `Description: ${description}` : "",
      servingLabel ? `Serving: ${servingLabel}` : "",
      notes ? `Notes: ${notes}` : "",
      foodsLines.length ? `Ingredients: ${foodsLines.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const raw = await callLlmText(userText, { system, json: true });
    const jsonStr = extractJsonObject(raw) || raw || "{}";

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = {};
    }

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    };

    const energy_kcal = num(parsed.energy_kcal);
    let energy_kj = num(parsed.energy_kj);
    if (energy_kj == null && energy_kcal != null) {
      energy_kj = Math.round(energy_kcal * 4.184);
    }

    return res.json({
      data: {
        energy_kcal,
        energy_kj,
        protein_g: num(parsed.protein_g),
        carb_g: num(parsed.carb_g),
        fat_g: num(parsed.fat_g),
        notes: typeof parsed.notes === "string" ? parsed.notes : null,
      },
    });
  } catch (e) {
    console.error("estimateMacrosPost", e);
    return res.status(500).json({ error: e.message || "Estimate failed" });
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
  estimateMacrosPost,
};
