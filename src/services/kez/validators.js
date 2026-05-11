const BANNED = /\bhealthy\b|\bunhealthy\b/i;
const BULLET_LINE = /^\s*[-*•]\s|^\s*\d+\.\s/m;
const MEDICAL_HINT =
  /\b(diagnos|diabetes|celiac|coeliac|eating disorder|anorex|bulim|IBS|crohn|colitis|coaching you for your condition|your deficiency)\b/i;
const BESPOKE_PLAN =
  /\b(full (week |)meal plan|personalised meal plan|write me a (7|seven)[ -]day|macros? for every meal)\b/i;
const CARB_COVERAGE = /\b(carb|carbohydrate|fuel|energy|glycogen)\b/i;
const PROTEIN_COVERAGE = /\b(protein|recovery|muscle|repair)\b/i;
const MICRONUTRIENT_COVERAGE =
  /\b(micronutrient|iron|vitamin|calcium|magnesium|zinc|folate|potassium|colour|vegetable|veggie|fruit|greens?)\b/i;
const POSITIVE_ENDING =
  /\b(good|great|strong|solid|smart|nice|well done|works|positive|build|building|nailed|included)\b/i;

function wordCount(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function validateMealFeedback(text, { firstName, mealAnalysis = false } = {}) {
  const issues = [];
  if (!text || !String(text).trim()) {
    issues.push("empty");
    return { ok: false, issues };
  }
  const t = String(text).trim();

  if (BANNED.test(t)) issues.push("banned_word");
  if (BULLET_LINE.test(t)) issues.push("bullet_or_numbered");

  const paras = t.split(/\n\s*\n/).filter((p) => p.trim());
  if (paras.length > 3) issues.push("too_many_paragraphs");

  if (wordCount(t) > 150) issues.push("over_word_limit");

  if (firstName) {
    const open = `Hey ${firstName}.`;
    if (!t.startsWith(open)) issues.push("missing_opening_hey_firstname");
  }

  const youLower = (t.match(/\byou\b/gi) || []).length;
  if (youLower < 2) issues.push("weak_you_voice");

  if (mealAnalysis) {
    if (!CARB_COVERAGE.test(t)) issues.push("missing_carb_assessment");
    if (!PROTEIN_COVERAGE.test(t)) issues.push("missing_protein_timing");
    if (!MICRONUTRIENT_COVERAGE.test(t)) issues.push("missing_micronutrient_gap");

    const tail = t.split(/\s+/).slice(-32).join(" ");
    if (!POSITIVE_ENDING.test(tail)) issues.push("missing_positive_ending");
  }

  return { ok: issues.length === 0, issues };
}

function validateMealAnalysisDraft(draft) {
  const issues = [];
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return { ok: false, issues: ["draft_not_object"] };
  }

  const requiredStrings = [
    "food_group_summary",
    "carbohydrate_assessment",
    "protein_timing_assessment",
    "micronutrient_gap",
    "positive",
  ];
  for (const key of requiredStrings) {
    if (!String(draft[key] || "").trim()) issues.push(`missing_${key}`);
  }

  if (!Array.isArray(draft.improvements) || draft.improvements.length < 2 || draft.improvements.length > 3) {
    issues.push("improvements_not_2_to_3");
  } else {
    draft.improvements.forEach((item, idx) => {
      if (!String(item || "").trim()) issues.push(`empty_improvement_${idx + 1}`);
    });
  }

  if (!CARB_COVERAGE.test(String(draft.carbohydrate_assessment || ""))) {
    issues.push("draft_missing_carb_language");
  }
  if (!PROTEIN_COVERAGE.test(String(draft.protein_timing_assessment || ""))) {
    issues.push("draft_missing_protein_language");
  }
  if (!MICRONUTRIENT_COVERAGE.test(String(draft.micronutrient_gap || ""))) {
    issues.push("draft_missing_micronutrient_language");
  }

  return { ok: issues.length === 0, issues };
}

function applyHardStopTemplates(text, { firstName = "there" } = {}) {
  if (MEDICAL_HINT.test(text)) {
    return {
      text: `Hey ${firstName}. That one needs a Sports Dietitian who knows your full history — I can't diagnose or treat here. What I can do is talk food timing and fuel around training. Want to pick one meal photo to work through?\n\n[FLAG:UNCERTAIN] — clinical scope`,
      flagged: true,
    };
  }
  if (BESPOKE_PLAN.test(text)) {
    return {
      text: `Hey ${firstName}. For a full structured plan, Kerry's Training Nutrition Plan inside EAT to BUILD for RUGBY has you covered.\n\nTell me one meal you're eating this week and I will help you tune it.`,
      flagged: false,
    };
  }
  return { text, flagged: false };
}

function stripHealthyUnhealthy(text) {
  return String(text)
    .replace(/\bhealthy\b/gi, "performance-focused")
    .replace(/\bunhealthy\b/gi, "low-nutrient density");
}

module.exports = {
  validateMealFeedback,
  validateMealAnalysisDraft,
  applyHardStopTemplates,
  stripHealthyUnhealthy,
};
