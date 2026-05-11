function roundCalForDisplay(kcal) {
  return Math.round(Number(kcal) / 10) * 10;
}

function roundKjForDisplay(kj) {
  return Math.round(Number(kj) / 100) * 100;
}

function formatCarouselMacros({ p, c, f, kcal, kj }) {
  const pN = Math.round(Number(p));
  const cN = Math.round(Number(c));
  const fN = Math.round(Number(f));
  const cal = roundCalForDisplay(kcal);
  const kJ = roundKjForDisplay(kj);
  return `P: ${pN}g C: ${cN}g F: ${fN}g | ${cal.toLocaleString()} cal (${kJ.toLocaleString()} kJ)`;
}

function kjToKcal(kj) {
  return Number(kj) / 4.184;
}

module.exports = { formatCarouselMacros, kjToKcal, roundCalForDisplay, roundKjForDisplay };
