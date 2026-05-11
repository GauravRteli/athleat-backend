// Indexer — turns a knowledge_entry row into pgvector chunks.
//
// Public surface:
//   indexEntry(entry, { force })   — extract → chunk → embed → upsert
//   indexEntryAsync(entry, opts)   — fire-and-forget version (used by HTTP)
//   removeEntry(id)                — delete every chunk for one entry
//   removeEntryAsync(id)           — fire-and-forget version
//   reindexEntryById(id, opts)     — load row + indexEntry (manual retry)
//
// Idempotency: indexEntry uses an atomic SQL UPDATE to claim the row by
// flipping its `embedding_status` from `pending` (or `failed`) to `processing`
// in a single statement. If the row is already `ready` (or already
// `processing`) the claim returns 0 rows and the indexer no-ops — so back-
// filling on startup, the reindex button, and the auto-trigger from
// create/update can all fire freely without doing duplicate work.
//
// Pass `force: true` to bypass the `ready` skip (used by the manual reindex
// endpoint). Even with `force`, an entry already in `processing` is left
// alone unless `force` AND it's been "stuck" longer than STALE_PROCESSING_MS.

const { query } = require("../../config/postgres");
const { extractFromUrl } = require("./extractor");
const { chunkText } = require("./chunker");
const { embedBatch, targetDimension } = require("./embeddings");
const vectorStore = require("./vectorStore");
const env = require("../../config/env");
const log = require("./log").tag("indexer");

// If a row is stuck in `processing` for longer than this, a forced reindex
// will reclaim it (covers crashes mid-index).
const STALE_PROCESSING_MS = 10 * 60 * 1000; // 10 minutes

function ragEnabled() {
  // Vector store lives in Supabase Postgres now — the only external dep
  // is OpenAI for embeddings + chat completions.
  return Boolean(env.openai.apiKey);
}

// Atomically claim the row for indexing. Returns the claimed row, or null if
// the row is in a state that should be left alone.
//   force = false → claim from {pending, failed}
//   force = true  → claim from {pending, failed, ready, stale-processing}
async function claim(id, force) {
  const allowed = force
    ? `embedding_status IN ('pending','failed','ready')
       OR (embedding_status = 'processing' AND updated_at < now() - interval '${STALE_PROCESSING_MS} milliseconds')`
    : `embedding_status IN ('pending','failed')`;
  const result = await query(
    `UPDATE public.knowledge_entries
        SET embedding_status = 'processing',
            embedding_error  = NULL,
            updated_at       = now()
      WHERE id = $1
        AND (${allowed})
      RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function setReady(id, embeddedAt = new Date()) {
  await query(
    `UPDATE public.knowledge_entries
        SET embedding_status = 'ready',
            embedding_error  = NULL,
            embedded_at      = $2,
            updated_at       = now()
      WHERE id = $1`,
    [id, embeddedAt]
  );
}

async function setFailed(id, errorMessage) {
  await query(
    `UPDATE public.knowledge_entries
        SET embedding_status = 'failed',
            embedding_error  = $2,
            updated_at       = now()
      WHERE id = $1`,
    [id, String(errorMessage || "unknown error").slice(0, 1000)]
  );
}

function buildText(entry) {
  if (entry.type === "correction") {
    const w = entry.wrong_answer ? `Wrong: ${entry.wrong_answer}\n\n` : "";
    const r = entry.right_answer ? `Correct: ${entry.right_answer}` : "";
    return `${w}${r}`.trim();
  }
  if (entry.type === "knowledge" || entry.type === "never") {
    return (entry.content || "").trim();
  }
  return "";
}

async function resolveText(entry) {
  if (entry.type === "file") {
    if (!entry.file_url) throw new Error("File entry has no file_url");
    const txt = await extractFromUrl({
      url: entry.file_url,
      filename: entry.file_name || "",
    });
    return (txt || "").trim();
  }
  return buildText(entry);
}

function describe(entry) {
  return {
    id: entry.id,
    type: entry.type,
    file: entry.file_name || undefined,
    cat: entry.category || undefined,
  };
}

async function indexEntry(entryInput, { force = false } = {}) {
  if (!entryInput?.id) return { skipped: true, reason: "no-id" };
  if (!ragEnabled()) {
    log.warn("rag disabled — skipping (OPENAI_API_KEY missing)", { id: entryInput.id });
    return { skipped: true, reason: "rag-disabled" };
  }

  // Try to atomically claim the row. If we can't, the entry is either already
  // `ready` or another worker is processing it — either way, do nothing.
  const entry = await claim(entryInput.id, force);
  if (!entry) {
    // Read the actual current status for the log line.
    const cur = await query(
      `SELECT embedding_status FROM public.knowledge_entries WHERE id = $1`,
      [entryInput.id]
    );
    const status = cur.rows[0]?.embedding_status || "?";
    log.info("skip", { id: entryInput.id, reason: `already ${status}` });
    return { skipped: true, reason: `already-${status}` };
  }

  const stop = log.timer();
  log.info("claim", { ...describe(entry), force });

  try {
    // 1. Extract / resolve text
    const tExtract = log.timer();
    const text = await resolveText(entry);
    log.info("extract done", {
      id: entry.id,
      chars: text.length,
      took_ms: tExtract(),
    });

    if (!text) {
      log.warn("no extractable text — marking ready (no chunks)", { id: entry.id });
      await vectorStore.deleteByEntry(entry.id).catch(() => {});
      await setReady(entry.id);
      return { skipped: false, chunks: 0, total_ms: stop() };
    }

    // 2. Chunk
    const chunks = chunkText(text);
    log.info("chunk done", { id: entry.id, chunks: chunks.length });
    if (!chunks.length) {
      await vectorStore.deleteByEntry(entry.id).catch(() => {});
      await setReady(entry.id);
      return { skipped: false, chunks: 0, total_ms: stop() };
    }

    // 3. Embed
    const tEmbed = log.timer();
    log.info("embed start", {
      id: entry.id,
      chunks: chunks.length,
      model: env.openai.embeddingModel,
      dim: targetDimension() || "model-default",
    });
    const vectors = await embedBatch(chunks);
    log.info("embed done", { id: entry.id, vectors: vectors.length, took_ms: tEmbed() });

    // 4. Replace any prior chunks for this entry
    const tDel = log.timer();
    await vectorStore.deleteByEntry(entry.id);
    log.info("pgvector wipe", { id: entry.id, took_ms: tDel() });

    // 5. Upsert fresh
    const tUp = log.timer();
    await vectorStore.upsertChunks(entry, chunks, vectors);
    log.info("pgvector upsert", { id: entry.id, chunks: chunks.length, took_ms: tUp() });

    // 6. Mark ready
    await setReady(entry.id);
    log.info("DONE", { id: entry.id, file: entry.file_name || undefined, chunks: chunks.length, total_ms: stop() });
    return { skipped: false, chunks: chunks.length, total_ms: stop() };
  } catch (err) {
    log.error("FAILED", { id: entry.id, file: entry.file_name || undefined, total_ms: stop() }, err);
    await setFailed(entry.id, err.message).catch(() => {});
    return { skipped: false, failed: true, error: err.message, total_ms: stop() };
  }
}

function indexEntryAsync(entry, opts) {
  Promise.resolve()
    .then(() => indexEntry(entry, opts))
    .catch((err) => log.error("indexEntryAsync swallowed", { id: entry?.id }, err));
}

async function removeEntry(entryId) {
  if (!entryId) return;
  // Note: this is a defence-in-depth call.  The knowledge_chunks FK has
  // ON DELETE CASCADE, so deleting the parent row in
  // knowledge_entries already wipes its chunks.  We still call this to
  // cover soft-delete flows that flip is_active without removing the row.
  const stop = log.timer();
  try {
    await vectorStore.deleteByEntry(entryId);
    log.info("removeEntry", { id: entryId, took_ms: stop() });
  } catch (err) {
    log.error("removeEntry failed", { id: entryId, took_ms: stop() }, err);
  }
}

function removeEntryAsync(entryId) {
  Promise.resolve()
    .then(() => removeEntry(entryId))
    .catch((err) => log.error("removeEntryAsync swallowed", { id: entryId }, err));
}

async function reindexEntryById(id, opts = {}) {
  const result = await query(
    `SELECT * FROM public.knowledge_entries WHERE id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Entry not found");
  return indexEntry(row, { force: true, ...opts });
}

module.exports = {
  indexEntry,
  indexEntryAsync,
  removeEntry,
  removeEntryAsync,
  reindexEntryById,
  ragEnabled,
};
