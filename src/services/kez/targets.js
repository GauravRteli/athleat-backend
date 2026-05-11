const DEFAULT_PAL = {
  Lower: { low: 1.6, high: 1.75 },
  Moderate: { low: 1.8, high: 2.0 },
  High: { low: 2.0, high: 2.15 },
};

const DEFAULT_CARB_GKG = {
  Lower: { low: 4.5, high: 5.0 },
  Moderate: { low: 5.0, high: 6.0 },
  High: { low: 6.5, high: 7.0 },
};

function classifyLoadFromPrescreen(prescreen) {
  if (!prescreen) return "Moderate";
  const high = Number(prescreen.daysHigh) || 0;
  const med = Number(prescreen.daysMed) || 0;
  if (high >= 3) return "High";
  if (med >= 2) return "Moderate";
  return "Lower";
}

function calcHenryREE(age, sex, weightKg) {
  const s = String(sex || "Male");
  const male = s.toLowerCase().startsWith("m");
  if (male) return age < 18 ? 17.686 * weightKg + 658.2 : 15.057 * weightKg + 692.2;
  return age < 18 ? 13.384 * weightKg + 692.6 : 14.818 * weightKg + 486.6;
}

function ageFromDob(dob) {
  if (!dob) return null;
  return Math.floor((Date.now() - new Date(dob).getTime()) / 31557600000);
}

function computeDailyEER(prescreen, loadDay, eerConfig = {}) {
  const age = ageFromDob(prescreen?.dob);
  const weight = parseFloat(prescreen?.weight);
  const sex = prescreen?.sex || "Male";
  if (!age || !weight) return null;

  const pal = eerConfig.pal?.[loadDay] || DEFAULT_PAL[loadDay] || DEFAULT_PAL.Moderate;
  const carb =
    eerConfig.carb_gkg?.[loadDay] || DEFAULT_CARB_GKG[loadDay] || DEFAULT_CARB_GKG.Moderate;
  const proteinGkg = eerConfig.protein_gkg || { low: 1.6, high: 2.2 };
  const fatGday = eerConfig.fat_gday || { low: 95, high: 115 };

  const ree = calcHenryREE(age, sex, weight);
  const eerLow = Math.round((ree * pal.low) / 100) * 100;
  const eerHigh = Math.round((ree * pal.high) / 100) * 100;
  const kjLow = Math.round((eerLow * 4.184) / 100) * 100;
  const kjHigh = Math.round((eerHigh * 4.184) / 100) * 100;
  const protLow = Math.round((weight * proteinGkg.low) / 5) * 5;
  const protHigh = Math.round((weight * proteinGkg.high) / 5) * 5;
  const carbLow = Math.round((weight * carb.low) / 5) * 5;
  const carbHigh = Math.round((weight * carb.high) / 5) * 5;

  return {
    loadDay,
    ree: Math.round(ree),
    eerLow,
    eerHigh,
    kjLow,
    kjHigh,
    protein: { low: protLow, high: protHigh },
    carb: { low: carbLow, high: carbHigh },
    fat: { low: fatGday.low, high: fatGday.high },
  };
}

function mealFractionForSlot(slotLabelOrId) {
  const key = String(slotLabelOrId || "").toLowerCase();
  if (key.includes("breakfast")) return 0.22;
  if (key.includes("lunch")) return 0.3;
  if (key.includes("dinner")) return 0.33;
  if (key.includes("training")) return 0.15;
  if (key.includes("game")) return 0.2;
  return 0.25;
}

function mealTargetBand(daily, fraction) {
  if (!daily || fraction <= 0) return null;
  const f = fraction;
  return {
    kcal_low: Math.round(daily.eerLow * f),
    kcal_high: Math.round(daily.eerHigh * f),
    kj_low: Math.round((daily.eerLow * f * 4.184) / 100) * 100,
    kj_high: Math.round((daily.eerHigh * f * 4.184) / 100) * 100,
    p_low: Math.round(daily.protein.low * f),
    p_high: Math.round(daily.protein.high * f),
    c_low: Math.round(daily.carb.low * f),
    c_high: Math.round(daily.carb.high * f),
    f_low: Math.round(daily.fat.low * f),
    f_high: Math.round(daily.fat.high * f),
  };
}

function compareToBand(value, low, high) {
  if (value == null || low == null || high == null) return "unknown";
  if (value < low) return "below";
  if (value > high) return "above";
  return "in_band";
}

function buildVsTargets(macroTotals, band) {
  if (!macroTotals || !band) return {};
  return {
    protein: compareToBand(macroTotals.protein_g, band.p_low, band.p_high),
    carb: compareToBand(macroTotals.carb_g, band.c_low, band.c_high),
    fat: compareToBand(macroTotals.fat_g, band.f_low, band.f_high),
    energy: compareToBand(macroTotals.kcal, band.kcal_low, band.kcal_high),
  };
}

module.exports = {
  classifyLoadFromPrescreen,
  computeDailyEER,
  mealFractionForSlot,
  mealTargetBand,
  ageFromDob,
  buildVsTargets,
};
