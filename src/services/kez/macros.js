const { kjToKcal } = require("./format");

function scaleFoodRow(foodRow, gramsEstimate) {
  const refG = Number(foodRow.weight_g);
  if (!refG || refG <= 0 || !gramsEstimate || gramsEstimate <= 0) {
    return { protein_g: 0, carb_g: 0, fat_g: 0, energy_kj: 0, energy_kcal: 0 };
  }
  const r = gramsEstimate / refG;
  return {
    protein_g: Number(foodRow.protein_g || 0) * r,
    carb_g: Number(foodRow.carb_g || 0) * r,
    fat_g: Number(foodRow.fat_g || 0) * r,
    energy_kj: Number(foodRow.energy_kj || 0) * r,
    energy_kcal: Number(foodRow.energy_kcal || 0) * r,
  };
}

function sumMacros(lines) {
  return lines.reduce(
    (acc, x) => ({
      protein_g: acc.protein_g + (x.protein_g || 0),
      carb_g: acc.carb_g + (x.carb_g || 0),
      fat_g: acc.fat_g + (x.fat_g || 0),
      energy_kj: acc.energy_kj + (x.energy_kj || 0),
      energy_kcal: acc.energy_kcal + (x.energy_kcal || 0),
    }),
    { protein_g: 0, carb_g: 0, fat_g: 0, energy_kj: 0, energy_kcal: 0 },
  );
}

function finalizeTotals(totals) {
  let kcal = totals.energy_kcal;
  if ((!kcal || kcal <= 0) && totals.energy_kj > 0) kcal = kjToKcal(totals.energy_kj);
  const kj = totals.energy_kj > 0 ? totals.energy_kj : kcal * 4.184;
  return {
    protein_g: Math.round(totals.protein_g * 10) / 10,
    carb_g: Math.round(totals.carb_g * 10) / 10,
    fat_g: Math.round(totals.fat_g * 10) / 10,
    kcal: Math.round(kcal * 10) / 10,
    kj: Math.round(kj * 10) / 10,
    energy_kj: Math.round(kj * 10) / 10,
  };
}

module.exports = { scaleFoodRow, sumMacros, finalizeTotals };
