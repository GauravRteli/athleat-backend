const { callLlmUserContent, extractJsonObject } = require("./llm");

const VISION_SCHEMA = `You must return ONLY valid JSON with this shape:
{"items":[{"label":"string","portion_phrase":"string","grams_estimate":number,"confidence":0.0}],"uncertainties":["string"]}
Rules: 2-8 items; grams_estimate is your best guess for grams eaten of that food line; confidence 0-1 per item.`;

async function runMealVision({ imageUrl, mealText, mealCategory }) {
  const textBlock = [
    "Analyse this meal photo for a performance nutrition coach.",
    mealCategory ? `Meal category context: ${mealCategory}` : "",
    mealText ? `Athlete caption: ${mealText}` : "",
    VISION_SCHEMA,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callLlmUserContent(
    [
      { type: "image", url: imageUrl },
      { type: "text", text: textBlock },
    ],
    { system: "You identify foods and portions for athletes. Output JSON only.", json: true },
  );

  const jsonStr = extractJsonObject(raw) || raw;
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [],
      raw,
    };
  } catch {
    return { items: [], uncertainties: ["vision_parse_failed"], raw };
  }
}

module.exports = { runMealVision };
