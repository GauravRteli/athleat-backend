function bandDistance(v, low, high) {
  if (v == null || low == null || high == null) return 0;
  if (v >= low && v <= high) return 0;
  if (v < low) return low - v;
  return v - high;
}

function scoreMealCandidate(meal, { resolvedNameSet, macroTotals, targetBand, likedTokens }) {
  let score = 0;
  const nameSet =
    resolvedNameSet instanceof Set ? resolvedNameSet : new Set((resolvedNameSet || []).map((s) => String(s)));
  const tags = Array.isArray(meal.tags) ? meal.tags.map((t) => String(t).toLowerCase()) : [];
  const title = String(meal.title || "").toLowerCase();
  const desc = String(meal.description || "").toLowerCase();

  for (const name of nameSet) {
    const n = String(name).toLowerCase();
    if (!n) continue;
    if (title.includes(n) || desc.includes(n)) score += 8;
    for (const t of tags) {
      if (t.includes(n) || n.includes(t)) score += 4;
    }
  }

  const mp = Number(meal.protein_g) || 0;
  const mc = Number(meal.carb_g) || 0;
  const mf = Number(meal.fat_g) || 0;
  const mk = Number(meal.energy_kcal) || (Number(meal.energy_kj) ? Number(meal.energy_kj) / 4.184 : 0);

  if (targetBand && macroTotals?.kcal) {
    const tk = macroTotals.kcal;
    if (mk > 0) score += Math.max(0, 12 - Math.abs(mk - tk) / 40);
  }

  if (targetBand) {
    const dist =
      bandDistance(mp, targetBand.p_low, targetBand.p_high) +
      bandDistance(mc, targetBand.c_low, targetBand.c_high) +
      bandDistance(mf, targetBand.f_low, targetBand.f_high) +
      (mk > 0 ? bandDistance(mk, targetBand.kcal_low, targetBand.kcal_high) : 0);
    score += Math.max(0, 25 - dist / 10);
  }

  for (const like of likedTokens || []) {
    if (like && (title.includes(like) || desc.includes(like))) score += 3;
  }

  return score;
}

function mealExcludedByDislikes(mealFoods, dislikePhrases) {
  const phrases = (dislikePhrases || [])
    .map((d) => String(d).toLowerCase().trim())
    .filter(Boolean);
  if (!phrases.length || !Array.isArray(mealFoods)) return false;
  for (const row of mealFoods) {
    const name = String(row.food_name || "").toLowerCase();
    for (const p of phrases) {
      if (p && name.includes(p)) return true;
    }
  }
  return false;
}

module.exports = { scoreMealCandidate, mealExcludedByDislikes };
