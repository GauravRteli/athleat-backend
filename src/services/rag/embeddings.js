// OpenAI embeddings wrapper.
//
// Centralises:
//   • client initialisation (lazy — so a missing key only blows up when
//     embedding is actually requested, not at import time)
//   • batching (OpenAI accepts up to 2048 inputs per call but we keep the
//     batch under 100 to stay well within the 300K token-per-request limit)
//   • light retry on transient 429 / 5xx
//   • passes `dimensions` from env so the embedding output width matches the
//     `vector(N)` column in knowledge_chunks (default 1024 vs the model's
//     native 3072 for text-embedding-3-large)
//
// The shape returned by `embedBatch` is a parallel array of float vectors
// matching the order of the input strings.

const OpenAI = require("openai");
const env = require("../../config/env");
const log = require("./log").tag("embed");

let _client = null;
function getClient() {
  if (!env.openai.apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set — cannot embed text. Add it to backend/.env."
    );
  }
  if (!_client) _client = new OpenAI({ apiKey: env.openai.apiKey });
  return _client;
}

const MAX_BATCH = 96;
const MAX_RETRIES = 3;

// Default native widths for OpenAI's text-embedding-3-* models. We only
// pass the `dimensions` parameter to OpenAI when the configured target
// differs from the model's native width — that way users running the
// 3-small model on its default 1536 dim aren't forced to override.
const NATIVE_DIMS = {
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
};

function targetDimension() {
  const native = NATIVE_DIMS[env.openai.embeddingModel] || null;
  const target = Number(env.rag.vectorDimension) || null;
  if (!target) return null;
  if (native && native === target) return null;
  return target;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function embedOnce(texts) {
  const client = getClient();
  const dim = targetDimension();
  let attempt = 0;
  while (true) {
    try {
      const params = {
        model: env.openai.embeddingModel,
        input: texts,
      };
      if (dim) params.dimensions = dim;
      const res = await client.embeddings.create(params);
      return res.data.map((d) => d.embedding);
    } catch (err) {
      const status = err?.status || err?.response?.status;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable || attempt >= MAX_RETRIES) {
        log.error("embedOnce failed", { batch: texts.length, status, model: env.openai.embeddingModel }, err);
        throw err;
      }
      const backoff = 500 * Math.pow(2, attempt);
      log.warn("retry", { batch: texts.length, status, attempt: attempt + 1, backoff_ms: backoff });
      attempt += 1;
      await sleep(backoff);
    }
  }
}

async function embedBatch(texts) {
  if (!Array.isArray(texts) || !texts.length) return [];
  const out = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const slice = texts.slice(i, i + MAX_BATCH);
    const vecs = await embedOnce(slice);
    out.push(...vecs);
  }
  return out;
}

async function embedQuery(text) {
  const [vec] = await embedBatch([text || ""]);
  return vec;
}

module.exports = { embedBatch, embedQuery, targetDimension };
