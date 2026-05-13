const env = require("../../config/env");
const { query } = require("../../config/postgres");
const {
  MASTER_SYSTEM_PROMPT,
  MEAL_ANALYSIS_TASK_SUFFIX,
} = require("./masterPrompt");

const TTL_MS = 60_000;
let cache = { at: 0, never: [], correction: [] };

/** pgvector literal for `vector` parameters (see `vectorStore.js`). */
function formatVectorLiteral(values) {
  if (!Array.isArray(values)) {
    throw new Error("formatVectorLiteral: expected an array of numbers");
  }
  return `[${values.join(",")}]`;
}

async function fetchNeverAndCorrectionRows() {
  const now = Date.now();
  if (now - cache.at < TTL_MS && (cache.never.length || cache.correction.length)) {
    return { never: cache.never, correction: cache.correction };
  }

  const [neverRes, correctionRes] = await Promise.all([
    query(
      `SELECT id, category, content FROM public.knowledge_entries
       WHERE type = 'never' AND is_active = true`,
    ),
    query(
      `SELECT id, category, wrong_answer, right_answer FROM public.knowledge_entries
       WHERE type = 'correction' AND is_active = true`,
    ),
  ]);

  cache = { at: now, never: neverRes.rows || [], correction: correctionRes.rows || [] };
  return { never: cache.never, correction: cache.correction };
}

function formatNeverCorrectionBlock({ never, correction }) {
  const n = (never || [])
    .map((r) => `- [HARD STOP] (${r.category || "rule"}) ${r.content || ""}`)
    .join("\n");
  const c = (correction || [])
    .map(
      (r) =>
        `- [CORRECTION] (${r.category || "fix"}) if wrong: "${(r.wrong_answer || "").slice(0, 200)}" → use: "${(r.right_answer || "").slice(0, 400)}"`,
    )
    .join("\n");
  if (!n && !c) return "";
  return ["=== RUNTIME HARD STOPS & CORRECTIONS ===", n, c].filter(Boolean).join("\n");
}

async function embedQueryText(text) {
  if (!env.openai.apiKey || !String(text || "").trim()) return null;
  const body = {
    model: env.openai.embeddingModel,
    input: text.slice(0, 8000),
    dimensions: env.rag.vectorDimension,
  };
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openai.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.data?.[0]?.embedding || null;
}

async function fetchKnowledgeChunkContext(queryText, matchCount = 6) {
  const emb = await embedQueryText(queryText);
  if (!emb) return "";

  const k = Math.max(1, Math.min(50, Number(matchCount) || 6));
  const { rows } = await query(
    `SELECT id, entry_id, chunk_index, chunk_total, content, metadata, score
       FROM public.match_knowledge_chunks($1::vector, $2)`,
    [formatVectorLiteral(emb), k],
  );
  if (!rows?.length) return "";

  return [
    "=== KNOWLEDGE SNIPPETS (retrieved) ===",
    ...rows.map((row, i) => `[${i + 1}] (score ${Number(row.score).toFixed(3)})\n${row.content}`),
  ].join("\n\n");
}

async function buildBrainInjection(queryForRag) {
  const { never, correction } = await fetchNeverAndCorrectionRows();
  const nc = formatNeverCorrectionBlock({ never, correction });
  const chunks = await fetchKnowledgeChunkContext(queryForRag, 6);
  return [nc, chunks].filter(Boolean).join("\n\n");
}

function assembleMealAnalysisSystemPrompt(brainInjection) {
  return [MASTER_SYSTEM_PROMPT, brainInjection].filter(Boolean).join("\n\n");
}

function mealAnalysisUserPrompt({ firstName, factsJson }) {
  return [
    MEAL_ANALYSIS_TASK_SUFFIX.replace(/\[FirstName\]/g, firstName || "there"),
    "",
    "FACTS (do not change numbers):",
    factsJson,
  ].join("\n");
}

module.exports = {
  buildBrainInjection,
  assembleMealAnalysisSystemPrompt,
  mealAnalysisUserPrompt,
};
