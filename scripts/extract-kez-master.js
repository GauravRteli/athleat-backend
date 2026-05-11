const fs = require("fs");
const path = require("path");

const outDir = path.join(__dirname, "../src/services/kez");
fs.mkdirSync(outDir, { recursive: true });

const src = fs.readFileSync(
  path.join(__dirname, "../../frontend/src/lib/kez/master-prompt.ts"),
  "utf8",
);

function extract(name) {
  const needle = `export const ${name} = `;
  const i = src.indexOf(needle);
  if (i < 0) throw new Error("missing " + name);
  const start = src.indexOf("`", i) + 1;
  const end = src.indexOf("`.trim();", start);
  if (end < 0) throw new Error("unclosed " + name);
  return src.slice(start, end).trim();
}

const MASTER_SYSTEM_PROMPT = extract("MASTER_SYSTEM_PROMPT");
const MEAL_ANALYSIS_TASK_SUFFIX = extract("MEAL_ANALYSIS_TASK_SUFFIX");
const V3_CAROUSEL_TASK_SUFFIX = extract("V3_CAROUSEL_TASK_SUFFIX");

const out = `module.exports = {
  MASTER_SYSTEM_PROMPT: ${JSON.stringify(MASTER_SYSTEM_PROMPT)},
  MEAL_ANALYSIS_TASK_SUFFIX: ${JSON.stringify(MEAL_ANALYSIS_TASK_SUFFIX)},
  V3_CAROUSEL_TASK_SUFFIX: ${JSON.stringify(V3_CAROUSEL_TASK_SUFFIX)},
};
`;

fs.writeFileSync(path.join(outDir, "masterPrompt.js"), out);
