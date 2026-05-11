const { query } = require("../../config/postgres");
const { callLlmText, extractJsonObject } = require("./llm");
const { shapeItem } = require("../foodsService");

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

// Canonical foods now live in `public.items` (legacy ~800-row Library table).
// `foodsService.shapeItem` normalises each row to the per-serve macro shape
// (`food_name`, `weight_g`, `energy_kj`, `protein_g`, `carb_g`, `fat_g`, ...).
async function searchFoodCandidates(label, limit = 12) {
  const tokens = tokenize(label);
  const uniq = [...new Set(tokens)].slice(0, 4);

  if (uniq.length === 0) {
    const { rows } = await query(
      `SELECT * FROM public.items
       WHERE COALESCE(is_locked, false) = false
       ORDER BY created_at DESC NULLS LAST
       LIMIT $1`,
      [limit],
    );
    return (rows || []).map(shapeItem);
  }

  const orParts = uniq.map((_, i) => `title ILIKE $${i + 2}`);
  const orSql = orParts.join(" OR ");
  const params = [limit, ...uniq.map((t) => `%${t}%`)];
  const { rows } = await query(
    `SELECT * FROM public.items
     WHERE COALESCE(is_locked, false) = false AND (${orSql})
     LIMIT $1`,
    params,
  );
  const list = (rows || []).map(shapeItem);
  if (list.length >= 3) return list;

  // Fallback: try a single-token ILIKE if multi-token search came up empty.
  const { rows: rows2 } = await query(
    `SELECT * FROM public.items
     WHERE COALESCE(is_locked, false) = false AND title ILIKE $2
     LIMIT $1`,
    [limit, `%${uniq[0]}%`],
  );
  const fallback = (rows2 || []).map(shapeItem);
  return (fallback.length ? fallback : list).slice(0, limit);
}

async function resolveLabelToFood(label, gramsEstimate, confidence, llmPick = true) {
  const candidates = await searchFoodCandidates(label, 12);
  if (!candidates.length) {
    return {
      food_id: null,
      food_row: null,
      grams_estimate: gramsEstimate,
      label,
      vision_confidence: confidence,
      resolver_score: 0,
    };
  }

  const top5 = candidates.slice(0, 5);
  let chosen = top5[0];
  let resolverScore = 0.4;

  if (llmPick && top5.length > 1) {
    const list = top5
      .map((c, i) => `${i + 1}. id=${c.id} name=${c.food_name} serving=${c.serving_label || ""}`)
      .join("\n");
    const prompt = `Food line from meal vision: "${label}" (~${gramsEstimate} g estimated).

Pick the single best database match from:
${list}

Reply JSON only: {"choice_index":1-5} or {"choice_index":null} if none fit.`;
    try {
      const raw = await callLlmText(prompt, {
        system: "You map short food descriptions to a canonical food list. JSON only.",
        json: true,
      });
      const j = JSON.parse(extractJsonObject(raw) || raw);
      const idx = j.choice_index;
      if (idx != null && idx >= 1 && idx <= top5.length) {
        chosen = top5[idx - 1];
        resolverScore = 0.85;
      }
    } catch {
      resolverScore = 0.55;
    }
  } else {
    resolverScore = 0.65;
  }

  const nameMatch = String(chosen.food_name || "").toLowerCase();
  const overlap = tokenize(label).filter((t) => nameMatch.includes(t)).length;
  resolverScore = Math.min(1, resolverScore + overlap * 0.05);

  return {
    food_id: chosen.id,
    food_row: chosen,
    grams_estimate: gramsEstimate,
    label,
    vision_confidence: confidence,
    resolver_score: resolverScore,
  };
}

function overallConfidence(resolvedLines) {
  if (!resolvedLines.length) return 0;
  const scores = resolvedLines.map((r) => {
    const vc = Number(r.vision_confidence) || 0.5;
    const rs = Number(r.resolver_score) || 0.5;
    if (!r.food_id) return vc * 0.35;
    return vc * 0.45 + rs * 0.55;
  });
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10000) / 10000;
}

module.exports = { searchFoodCandidates, resolveLabelToFood, overallConfidence };
