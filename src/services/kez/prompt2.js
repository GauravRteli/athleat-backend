// =============================================================================
// Prompt 2 — AI Draft (student feedback)
// =============================================================================
//
// Owner: Gaurav
// Model: claude-sonnet-4-20250514 (via `callLlmText` → env.anthropic.model)
//
// Generates ONE mission-level coaching draft for Kerry to review and edit
// before sending to the athlete. The prompt body is the verbatim Prompt 2
// template (see Kerry's spec): same headings, same numbered rules, same
// performance-language constraints. Because the v5.2 UI shows ONE textarea
// per mission (not per slot), we loop each slot inside the prompt body and
// ask Claude for a single coherent note under 120 words.
//
// Data sources (per the plan) — all server-side, no client trust:
//   - public.students          → first_name, last_name
//   - public.prescreen         → sex, weight_kg, dob, goals, dislike_foods,
//                                 days_high / days_med (load classification)
//   - public.eer_config (id=1) → PAL bands + g/kg defaults for EER
//   - student_food_preferences → resolved liked items.title list
//   - public.meal_analysis     → latest per (slot_id, version) row for
//                                 meal_text + macro_totals + resolved_items
//   - Request body `v3`        → in-memory V3 picks from v5.2 (since v5.2
//                                 never persists v3 to meal_analysis)
//   - Request body slot labels → from MISSION_DEFS in the frontend
//
// Variable map → Prompt 2 placeholder:
//   FirstName, LastName, sex, weight, age, goals, loadType, eerLow/High,
//   eerLowKj/HighKj, liked, disliked       → from prescreen + EER calc
//   missionLabel, slotLabel                → request body (frontend
//                                              MISSION_DEFS lookup)
//   v1Title/Desc, v2Title/Desc             → meal_analysis.meal_text split
//   v3Title/Desc                           → request body `v3[slot]` first,
//                                              fallback to meal_analysis v3,
//                                              else missions.v3 JSONB
//   matched macros + ingredients (V2)      → meal_analysis.resolved_items +
//                                              macro_totals (written by
//                                              mealAnalysisPost)
//   slot target band                       → mealTargetBand(computeDailyEER)
// =============================================================================

const { query } = require("../../config/postgres");
const {
  classifyLoadFromPrescreen,
  computeDailyEER,
  mealFractionForSlot,
  mealTargetBand,
  ageFromDob,
} = require("./targets");
const { callLlmText } = require("./llm");
const { MASTER_SYSTEM_PROMPT } = require("./masterPrompt");
const {
  applyHardStopTemplates,
  stripHealthyUnhealthy,
} = require("./validators");
const { buildBrainInjection } = require("./composer");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function kcalFromKj(kj) {
  const n = Number(kj);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / 4.184);
}

// `meal_analysis.meal_text` is stored as "Title — Description". Mirrors the
// splitter used in v3Carousel.js so backend reads are consistent.
function splitMealText(text) {
  const s = String(text || "").trim();
  if (!s) return { title: "", description: "" };
  const parts = s.split(/\s+[—-]\s+/);
  return {
    title: (parts[0] || "").trim(),
    description: (parts.slice(1).join(" — ") || "").trim(),
  };
}

// Pull every selected food id from student_food_preferences.selections and
// hydrate them against public.items.title. Same logic as
// `likedFoodsForStudent` in kezController.js — duplicated here to keep this
// module self-contained.
async function likedFoodsForStudent(studentId) {
  try {
    const { rows } = await query(
      `SELECT selections
         FROM public.student_food_preferences
        WHERE student_id = $1
        LIMIT 1`,
      [studentId],
    );
    const sel = rows?.[0]?.selections;
    if (!sel) return [];
    const source =
      typeof sel === "string" ? safeJsonParse(sel) : sel;
    if (!source || typeof source !== "object") return [];
    const ids = new Set();
    for (const value of Object.values(source)) {
      const list = Array.isArray(value) ? value : [value];
      for (const raw of list) {
        const n = Number(raw);
        if (Number.isInteger(n) && n > 0) ids.add(n);
      }
    }
    const idList = [...ids].slice(0, 40);
    if (!idList.length) return [];
    const { rows: itemRows } = await query(
      `SELECT title
         FROM public.items
        WHERE id = ANY($1::bigint[])
        ORDER BY title ASC`,
      [idList],
    );
    return (itemRows || [])
      .map((r) => String(r.title || "").trim())
      .filter(Boolean)
      .slice(0, 25);
  } catch (e) {
    console.error("[Prompt 2] likedFoodsForStudent failed:", e);
    return [];
  }
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function dislikeListFromPrescreen(prescreen) {
  const raw = prescreen?.dislike_foods || prescreen?.dislikeFoods || "";
  return String(raw)
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// `resolved_items` is JSONB written by mealAnalysisPost and contains an
// array of `{ name, quantity_g, protein_g, carb_g, fat_g, energy_kj,
// source }` records. Be tolerant of legacy/null rows.
function normaliseResolvedItems(raw) {
  let arr = raw;
  if (typeof arr === "string") arr = safeJsonParse(arr);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((it) => {
      if (!it || typeof it !== "object") return null;
      return {
        name: String(it.name || it.title || "").trim(),
        quantity_g: Number(it.quantity_g ?? it.weight_g ?? 0) || 0,
        protein_g: Number(it.protein_g ?? 0) || 0,
        carb_g: Number(it.carb_g ?? it.carbs_g ?? 0) || 0,
        fat_g: Number(it.fat_g ?? 0) || 0,
        energy_kj: Number(it.energy_kj ?? 0) || 0,
        source: String(it.source || "").trim() || "unknown",
      };
    })
    .filter((it) => it && it.name);
}

function normaliseMacroTotals(raw) {
  let v = raw;
  if (typeof v === "string") v = safeJsonParse(v);
  if (!v || typeof v !== "object") return null;
  const energy_kj = Number(v.energy_kj ?? v.kj ?? 0) || 0;
  return {
    energy_kj,
    kcal: v.kcal != null ? Number(v.kcal) || 0 : kcalFromKj(energy_kj),
    protein_g: Number(v.protein_g ?? 0) || 0,
    carb_g: Number(v.carb_g ?? v.carbs_g ?? 0) || 0,
    fat_g: Number(v.fat_g ?? 0) || 0,
  };
}

// V3 from the request body has the shape produced by `v3SlotFromMealData`
// in KerryDashboard_v5_2.jsx — `{ desc, description, foods, totals, ... }`.
function v3RequestSlotToTitleDesc(slot) {
  if (!slot || typeof slot !== "object") return null;
  const title = String(slot.title || slot.desc || "").trim();
  const description = String(
    slot.description || slot.blueprintNote || slot.blueprint_note || "",
  ).trim();
  if (!title && !description) return null;
  return { title, description };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Facts assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pulls everything Prompt 2 needs and returns a structured `facts` object.
 *
 * @param {object} args
 * @param {number|string} args.studentId
 * @param {string} args.missionId          - "m1".."m5" (frontend MISSION_DEFS id)
 * @param {string} args.missionLabel       - e.g. "Breakfast" (frontend name)
 * @param {Array<{id:string,label:string}>} args.slotDefs - frontend slot defs
 *   for this mission. `id` is the meal_analysis.slot_id, `label` is the
 *   coaching label shown in the UI.
 * @param {object} [args.v3Override]       - keyed by slot_id; in-memory V3
 *   picks from v5.2 (since v5.2 never writes V3 to meal_analysis).
 * @param {object} [args.missionRowV3]     - public.missions.v3 JSONB (fallback
 *   if v3Override doesn't have a given slot, e.g. on re-open after Send).
 */
async function buildPrompt2Facts({
  studentId,
  missionId,
  missionLabel,
  slotDefs,
  v3Override = {},
  missionRowV3 = {},
}) {
  if (!studentId) throw new Error("studentId required");
  if (!missionId) throw new Error("missionId required");
  if (!Array.isArray(slotDefs) || !slotDefs.length) {
    throw new Error("slotDefs required (frontend MISSION_DEFS slots)");
  }

  const [
    { rows: stRows },
    { rows: prescreenRows },
    { rows: eerRows },
    dbLikedFoods,
    { rows: analysisRows },
  ] = await Promise.all([
    query(
      `SELECT id, full_name, first_name, last_name
         FROM public.students
        WHERE id = $1`,
      [studentId],
    ),
    query(`SELECT * FROM public.prescreen WHERE student_id = $1`, [studentId]),
    query(`SELECT * FROM public.eer_config WHERE id = 1`),
    likedFoodsForStudent(studentId),
    query(
      `SELECT slot_id, version, meal_text, macro_totals, resolved_items,
              target_band, load_day, created_at
         FROM public.meal_analysis
        WHERE student_id = $1 AND mission_id = $2
        ORDER BY slot_id ASC, version ASC, created_at DESC`,
      [studentId, missionId],
    ),
  ]);

  if (!stRows?.[0]) throw new Error("Student not found");

  const student = stRows[0];
  const firstName =
    student.first_name ||
    String(student.full_name || "Athlete").trim().split(/\s+/)[0] ||
    "Athlete";
  const lastName =
    student.last_name ||
    String(student.full_name || "")
      .trim()
      .split(/\s+/)
      .slice(1)
      .join(" ") ||
    "";

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

  const loadDay = classifyLoadFromPrescreen(prescreen);
  const daily = computeDailyEER(prescreen, loadDay, eerConfig);
  const dislikes = dislikeListFromPrescreen(prescreen);

  // Pick the freshest analysis row per (slot_id, version) tuple.
  const latestBySlotVer = new Map();
  for (const r of analysisRows || []) {
    const key = `${r.slot_id}|${r.version}`;
    if (!latestBySlotVer.has(key)) latestBySlotVer.set(key, r);
  }
  function getAnalysis(slotId, version) {
    return latestBySlotVer.get(`${slotId}|${version}`) || null;
  }

  // Build per-slot blocks in the order they appear in the UI.
  const slots = slotDefs.map((slot) => {
    const slotId = slot.id;
    const slotLabel = slot.label || slotId;
    const fraction = mealFractionForSlot(slotLabel || slotId);
    const targetBand = daily ? mealTargetBand(daily, fraction) : null;

    const v1Row = getAnalysis(slotId, "v1");
    const v2Row = getAnalysis(slotId, "v2");
    const v3RowDb = getAnalysis(slotId, "v3");

    const v1 = v1Row ? splitMealText(v1Row.meal_text) : { title: "", description: "" };
    const v2 = v2Row ? splitMealText(v2Row.meal_text) : { title: "", description: "" };

    // V3 priority: request body override → missions.v3 JSONB → meal_analysis v3.
    let v3 = v3RequestSlotToTitleDesc(v3Override[slotId])
      || v3RequestSlotToTitleDesc(missionRowV3?.[slotId])
      || (v3RowDb ? splitMealText(v3RowDb.meal_text) : null)
      || { title: "", description: "" };

    const v2Items = v2Row ? normaliseResolvedItems(v2Row.resolved_items) : [];
    const v2Totals = v2Row ? normaliseMacroTotals(v2Row.macro_totals) : null;

    return {
      slot_id: slotId,
      slot_label: slotLabel,
      v1,
      v2,
      v3,
      v2_matched_items: v2Items,
      v2_totals: v2Totals,
      target_band: targetBand,
      load_day: loadDay,
    };
  });

  return {
    firstName,
    lastName,
    sex: prescreen.sex || null,
    weight_kg: prescreen.weight_kg ?? prescreen.weight ?? null,
    age: ageFromDob(prescreen.dob),
    goals: Array.isArray(prescreen.goals)
      ? prescreen.goals.filter(Boolean)
      : String(prescreen.goals || "")
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean),
    load_day: loadDay,
    eer_low: daily?.eerLow ?? null,
    eer_high: daily?.eerHigh ?? null,
    eer_low_kj: daily?.kjLow ?? null,
    eer_high_kj: daily?.kjHigh ?? null,
    liked_foods: dbLikedFoods || [],
    disliked_foods: dislikes,
    mission_id: missionId,
    mission_label: missionLabel || missionId,
    slots,
    used_analyses: latestBySlotVer.size,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Prompt builder — VERBATIM Prompt 2 wording
// ─────────────────────────────────────────────────────────────────────────────

function fmtList(arr) {
  const xs = Array.isArray(arr) ? arr.filter(Boolean) : [];
  return xs.length ? xs.join(", ") : "none recorded";
}

function fmtLoadDay(loadDay) {
  // Spec says "Training load this week: [loadType] days" — keep it as a single
  // tier label since prescreen captures days_high/days_med separately and the
  // model treats the classified band the same way.
  return String(loadDay || "Moderate").toLowerCase();
}

function fmtIngredientLine(it) {
  const parts = [
    it.name,
    `${Math.round(it.quantity_g)}g`,
    `P:${Number(it.protein_g).toFixed(1)}g C:${Number(it.carb_g).toFixed(1)}g F:${Number(it.fat_g).toFixed(1)}g`,
    `${Math.round(it.energy_kj)}kJ`,
    `source: ${it.source}`,
  ];
  return parts.join(" | ");
}

function fmtSlotBlock(slot, idx) {
  const lines = [];
  lines.push(`--- SLOT ${idx + 1}: ${slot.slot_label} ---`);
  lines.push(
    `V1 meal (athlete's current): ${slot.v1.title || "(not provided)"}${
      slot.v1.description ? ` - ${slot.v1.description}` : ""
    }`,
  );
  lines.push(
    `V2 meal (athlete's improved attempt): ${slot.v2.title || "(not provided)"}${
      slot.v2.description ? ` - ${slot.v2.description}` : ""
    }`,
  );
  lines.push(
    `V3 meal (Kerry's selection): ${slot.v3.title || "(not yet selected)"}${
      slot.v3.description ? ` - ${slot.v3.description}` : ""
    }`,
  );
  lines.push("");

  if (slot.v2_matched_items.length) {
    lines.push("MATCHED MACROS FOR V2:");
    for (const it of slot.v2_matched_items) lines.push(fmtIngredientLine(it));
    if (slot.v2_totals) {
      const t = slot.v2_totals;
      lines.push(
        `Totals: P: ${t.protein_g.toFixed(1)}g C: ${t.carb_g.toFixed(1)}g F: ${t.fat_g.toFixed(1)}g | ${Math.round(
          t.kcal,
        )} cal (${Math.round(t.energy_kj)} kJ)`,
      );
    }
  } else {
    lines.push("MATCHED MACROS FOR V2: (Run Kez Analysis on V2 to populate)");
  }
  lines.push("");

  if (slot.target_band) {
    const b = slot.target_band;
    lines.push(
      `MEAL SPLIT TARGET FOR THIS SLOT (${slot.slot_label}, ${fmtLoadDay(slot.load_day)} day):`,
    );
    lines.push(
      `Target energy range: ${b.kcal_low}-${b.kcal_high} kcal (${b.kj_low}-${b.kj_high} kJ)`,
    );
    lines.push(`Target protein: ${b.p_low}-${b.p_high}g`);
    lines.push(`Target carbs: ${b.c_low}-${b.c_high}g`);
  } else {
    lines.push(
      `MEAL SPLIT TARGET FOR THIS SLOT (${slot.slot_label}): (insufficient prescreen data — skip macro comparison)`,
    );
  }

  return lines.join("\n");
}

/**
 * Returns the FULL Prompt 2 user message (verbatim wording from Kerry's
 * spec). The slot template is repeated for every mission slot inside the
 * "MISSION" block; the rules section asks for ONE single under-120-word
 * note covering all slots.
 */
function buildPrompt2(facts) {
  const f = facts;
  const header = [
    `You are Virtual Kez - Kerry's clinical coaching voice. Kerry is reviewing this athlete's mission submission.`,
    ``,
    `ATHLETE: ${f.firstName} ${f.lastName || ""}, ${f.sex || "?"}, ${
      f.weight_kg != null ? `${f.weight_kg}kg` : "?kg"
    }, ${f.age != null ? `${f.age}yo` : "?yo"}, rugby league.`,
    `Goals: ${fmtList(f.goals)}`,
    `Training load this week: ${fmtLoadDay(f.load_day)} days`,
    `EER range: ${
      f.eer_low != null && f.eer_high != null
        ? `${f.eer_low} to ${f.eer_high} kcal/day (${f.eer_low_kj} to ${f.eer_high_kj} kJ/day)`
        : "(insufficient prescreen data)"
    }`,
    `Liked foods: ${fmtList(f.liked_foods)}`,
    `Disliked foods: ${fmtList(f.disliked_foods)}`,
    ``,
    `MISSION: ${f.mission_label}`,
  ].join("\n");

  const slotBlocks = f.slots.map(fmtSlotBlock).join("\n\n");

  const rules = [
    ``,
    `Write a coaching draft for Kerry to review and edit before sending to the athlete.`,
    `Rules:`,
    `1. Open with: Hey ${f.firstName}.`,
    `2. Acknowledge what they did well in V2 - one specific genuine positive.`,
    `3. Reference the V3 meal Kerry has selected. Explain why it performs better for their load.`,
    `4. Give one clear action - what should they do next.`,
    `5. Under 120 words. Short paragraphs. No bullet points.`,
    `6. Athlete never sees macros - use performance language only.`,
    `Do not mention numbers. Say: good fuel for a high training day, not 480 calories.`,
    `7. Never use the word healthy or unhealthy.`,
    ``,
    `IMPORTANT: produce ONE single coaching note covering all slots above ` +
      `(do not repeat the same praise per slot). Use the slot data as ` +
      `context for the model; the athlete reads ONE short note.`,
  ].join("\n");

  return [header, "", slotBlocks, rules].join("\n");
}

// Claude returns prose (not JSON). Strip surrounding fences / leading
// pleasantries that some models tack on.
function parsePrompt2Response(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^```(?:[a-z]+)?\s*/i, "").replace(/```\s*$/i, "").trim();
  s = s.replace(/^"+|"+$/g, "").trim();
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. End-to-end runner — gather → prompt → Claude → post-process
// ─────────────────────────────────────────────────────────────────────────────

async function runPrompt2(args) {
  const facts = await buildPrompt2Facts(args);
  const prompt = buildPrompt2(facts);

  // Pull the Brain (HARD STOPS + CORRECTIONS + retrieved chunks) so any
  // previously-saved Kerry correction shows up here immediately. The RAG
  // retrieval uses the mission + first name as the seed query so corrections
  // about coaching tone surface.
  let brainInjection = "";
  try {
    brainInjection = await buildBrainInjection(
      `Mission feedback coaching note for ${facts.firstName} - ${facts.mission_label}`,
    );
  } catch (e) {
    console.warn("[Prompt 2] brain injection failed:", e.message);
  }
  const system = [MASTER_SYSTEM_PROMPT, brainInjection]
    .filter(Boolean)
    .join("\n\n");

  console.log(
    "[Prompt 2 → Claude] mission=%s slots=%d used_analyses=%d",
    facts.mission_label,
    facts.slots.length,
    facts.used_analyses,
  );

  let raw = "";
  try {
    raw = await callLlmText(prompt, { system, json: false });
  } catch (e) {
    console.error("[Prompt 2] LLM call failed:", e);
    throw e;
  }

  let draft = parsePrompt2Response(raw);
  const stopped = applyHardStopTemplates(draft, { firstName: facts.firstName });
  draft = stripHealthyUnhealthy(stopped.text);

  return {
    draft,
    facts,
    prompt,
    hard_stop_triggered: !!stopped.flagged,
  };
}

module.exports = {
  buildPrompt2Facts,
  buildPrompt2,
  parsePrompt2Response,
  runPrompt2,
  splitMealText,
};
