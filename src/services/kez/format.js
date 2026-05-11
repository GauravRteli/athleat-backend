function roundCalForDisplay(kcal) {
  return Math.round(Number(kcal) / 10) * 10;
}

function roundKjForDisplay(kj) {
  return Math.round(Number(kj) / 100) * 100;
}

// Kerry's canonical macro line:
//   "P: 32g  C: 65g  F: 14g  |  480 cal (2010 kJ)"
function formatCarouselMacros({ p, c, f, kcal, kj }) {
  const pN = Math.round(Number(p) || 0);
  const cN = Math.round(Number(c) || 0);
  const fN = Math.round(Number(f) || 0);
  const calNum = Number(kcal);
  const cal = Number.isFinite(calNum) ? roundCalForDisplay(calNum) : null;
  const kjNum = Number(kj);
  const kJ = Number.isFinite(kjNum) ? roundKjForDisplay(kjNum) : null;
  const energy =
    cal != null && kJ != null
      ? `${cal.toLocaleString()} cal (${kJ.toLocaleString()} kJ)`
      : cal != null
        ? `${cal.toLocaleString()} cal`
        : kJ != null
          ? `${kJ.toLocaleString()} kJ`
          : "";
  return `P: ${pN}g  C: ${cN}g  F: ${fN}g${energy ? `  |  ${energy}` : ""}`;
}

function kjToKcal(kj) {
  return Number(kj) / 4.184;
}

module.exports = { formatCarouselMacros, kjToKcal, roundCalForDisplay, roundKjForDisplay };
