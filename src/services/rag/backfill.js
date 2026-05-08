// One-shot backfill — runs on backend startup.
//
// Goals:
//   1. Reset any rows wedged in `processing` after a previous crash to
//      `pending` so they get retried.
//   2. Find every active row in the knowledge base whose vectors aren't in
//      Pinecone yet (status `pending` or `failed`) and run `indexEntry` on
//      each, with a small concurrency cap so we don't blast the OpenAI rate
//      limit on a cold start with hundreds of files.
//
// Idempotent — `indexEntry` itself uses an atomic claim, so running this
// twice (or alongside a manual reindex) is safe.

const { query } = require("../../config/postgres");
const { indexEntry, ragEnabled } = require("./indexer");
const pinecone = require("./pinecone");
const log = require("./log").tag("backfill");

const DEFAULT_CONCURRENCY = 2;

async function resetStuckProcessing() {
  const result = await query(
    `UPDATE public.knowledge_entries
        SET embedding_status = 'pending',
            embedding_error  = NULL,
            updated_at       = now()
      WHERE embedding_status = 'processing'
        AND is_active = true
      RETURNING id`
  );
  return result.rowCount || 0;
}

async function listUnindexed() {
  const result = await query(
    `SELECT * FROM public.knowledge_entries
      WHERE is_active = true
        AND embedding_status IN ('pending','failed')
      ORDER BY created_at ASC`
  );
  return result.rows;
}

async function runWithConcurrency(items, worker, concurrency) {
  const queue = items.slice();
  const stats = { ok: 0, failed: 0, skipped: 0 };
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const r = await worker(item);
        if (r?.failed) stats.failed += 1;
        else if (r?.skipped) stats.skipped += 1;
        else stats.ok += 1;
      } catch (err) {
        stats.failed += 1;
        log.error("worker threw", { id: item?.id }, err);
      }
    }
  });
  await Promise.all(runners);
  return stats;
}

async function runBackfill({ concurrency = DEFAULT_CONCURRENCY } = {}) {
  if (!ragEnabled()) {
    log.warn("rag disabled — skipping backfill (OPENAI_API_KEY/PINECONE_API_KEY missing)");
    return { reset: 0, total: 0, ok: 0, failed: 0, skipped: 0 };
  }
  const stop = log.timer();
  const reset = await resetStuckProcessing();
  if (reset) log.info("reset stuck processing rows", { count: reset });

  const rows = await listUnindexed();
  if (!rows.length) {
    log.info("nothing to backfill — all entries are ready");
    return { reset, total: 0, ok: 0, failed: 0, skipped: 0, took_ms: stop() };
  }

  const counts = rows.reduce(
    (acc, r) => {
      acc[r.embedding_status] = (acc[r.embedding_status] || 0) + 1;
      return acc;
    },
    {}
  );
  log.info("queued", { total: rows.length, ...counts, concurrency });

  const stats = await runWithConcurrency(
    rows,
    (row) => indexEntry(row),
    concurrency
  );

  log.info("complete", {
    total: rows.length,
    ok: stats.ok,
    failed: stats.failed,
    skipped: stats.skipped,
    took_ms: stop(),
  });
  return { reset, total: rows.length, ...stats, took_ms: stop() };
}

// Detached version — safe to call at server startup without blocking the
// HTTP listener.
function runBackfillAsync(opts) {
  Promise.resolve()
    .then(() => runBackfill(opts))
    .catch((err) => log.error("backfill swallowed", null, err));
}

// Admin "rebuild everything" flow — wipes the entire Pinecone index, resets
// every active row's status to `pending`, then runs the normal backfill which
// re-extracts + re-embeds + re-upserts every entry.
//
// Files in Cloudinary and rows in Postgres are NOT deleted — only the vector
// store is rebuilt from the source of truth.
//
// Returns a summary so the HTTP handler can echo `{ wiped, queued }` back to
// the client; the actual indexing happens in the background.
async function reindexAll({ concurrency = DEFAULT_CONCURRENCY } = {}) {
  if (!ragEnabled()) {
    log.warn("rag disabled — cannot reindex (OPENAI_API_KEY/PINECONE_API_KEY missing)");
    return { ok: false, reason: "rag-disabled" };
  }
  const stop = log.timer();
  log.info("REINDEX-ALL start — wiping Pinecone");

  // 1. wipe vectors
  try {
    await pinecone.deleteAllVectors();
  } catch (err) {
    log.error("REINDEX-ALL pinecone wipe failed — aborting", null, err);
    throw err;
  }

  // 2. reset every active row to pending so the backfill picks them up
  const reset = await query(
    `UPDATE public.knowledge_entries
        SET embedding_status = 'pending',
            embedding_error  = NULL,
            embedded_at      = NULL,
            updated_at       = now()
      WHERE is_active = true
      RETURNING id`
  );
  log.info("REINDEX-ALL reset rows to pending", { count: reset.rowCount || 0 });

  // 3. queue them through the normal backfill pipeline
  const stats = await runBackfill({ concurrency });
  log.info("REINDEX-ALL complete", { reset: reset.rowCount || 0, ...stats, took_ms: stop() });
  return {
    ok: true,
    wiped: true,
    queued: reset.rowCount || 0,
    ...stats,
  };
}

// Fire-and-forget version: HTTP handler returns 202 immediately, the rebuild
// runs in the background. Frontend polls `embedding_status` to see progress.
function reindexAllAsync(opts) {
  Promise.resolve()
    .then(() => reindexAll(opts))
    .catch((err) => log.error("reindexAll swallowed", null, err));
}

module.exports = { runBackfill, runBackfillAsync, reindexAll, reindexAllAsync };
