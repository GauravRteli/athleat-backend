// Supabase pgvector store — replaces the previous Pinecone client.
//
// Public surface (kept identical to the old pinecone module so the indexer,
// backfill and chat code only had to change their `require()` line):
//
//   ensureIndex()                   — verify the `vector` extension is live
//   upsertChunks(entry, chunks, vs) — write one row per chunk (UPSERT)
//   deleteByEntry(entryId)          — wipe every chunk for one entry
//   deleteAllVectors()              — wipe the whole table (admin reindex)
//   query({ vector, topK })         — top-K cosine search via SQL RPC
//   isReady()                       — bool, set true once ensureIndex passes
//
// Match shape returned by `query()`:
//   [{ id, score, metadata: { entry_id, entry_type, chunk_index,
//                             chunk_total, text, file_name, file_url,
//                             file_type, category, folder_id } }, …]
// — same shape Pinecone returned, so chat.js's `formatContext` /
// `shapeSources` continue to work without changes.

const { pool, query: pgQuery } = require("../../config/postgres");
const env = require("../../config/env");
const log = require("./log").tag("pgvector");

let _ready = false;

// ---------------------------------------------------------------------------
// 1. Startup check
// ---------------------------------------------------------------------------
async function ensureIndex() {
  try {
    // Confirm the extension is installed.  We don't try to CREATE it here
    // because the migration already does that and the live DB role usually
    // doesn't have CREATE EXTENSION privilege at runtime.
    const ext = await pgQuery(
      `SELECT extname FROM pg_extension WHERE extname = 'vector' LIMIT 1`
    );
    if (!ext.rows.length) {
      log.error("vector extension is missing — run sql/2026_05_09_pgvector_knowledge_chunks.sql in Supabase");
      return false;
    }

    // Confirm the table exists.  If somebody applied the migration and
    // forgot the table, fail loudly.
    const tbl = await pgQuery(
      `SELECT 1
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name   = 'knowledge_chunks'
        LIMIT 1`
    );
    if (!tbl.rows.length) {
      log.error("knowledge_chunks table is missing — run the pgvector migration");
      return false;
    }

    _ready = true;
    log.info("connected", { table: "knowledge_chunks", dim: env.rag.vectorDimension });
    return true;
  } catch (err) {
    log.error("ensureIndex failed", null, err);
    return false;
  }
}

function isReady() {
  return _ready;
}

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------

// pgvector accepts vectors in the literal form `[0.1,0.2,…]`.  We construct
// the string ourselves rather than rely on node-postgres array binding because
// pg would JSON.stringify a JS array as a Postgres array, not a vector.
function formatVector(values) {
  if (!Array.isArray(values)) {
    throw new Error("formatVector: expected an array of numbers");
  }
  return `[${values.join(",")}]`;
}

function buildMetadata(entry, chunkIndex, chunkTotal) {
  // We persist the human-readable bits as jsonb so chat.js can read them
  // straight off the match without a join back to knowledge_entries.
  // (The chunk text itself lives in its own column for clarity.)
  const meta = {
    entry_id: String(entry.id),
    entry_type: String(entry.type || ""),
    chunk_index: chunkIndex,
    chunk_total: chunkTotal,
  };
  if (entry.folder_id) meta.folder_id = String(entry.folder_id);
  if (entry.category) meta.category = String(entry.category);
  if (entry.file_name) meta.file_name = String(entry.file_name);
  if (entry.file_url) meta.file_url = String(entry.file_url);
  if (entry.file_type) meta.file_type = String(entry.file_type);
  return meta;
}

// ---------------------------------------------------------------------------
// 3. Upsert
// ---------------------------------------------------------------------------

const UPSERT_BATCH = 100;

async function upsertChunks(entry, chunks, vectors) {
  if (!chunks?.length || chunks.length !== vectors?.length) {
    throw new Error("upsertChunks: chunks and vectors length must match");
  }
  const expectedDim = env.rag.vectorDimension;
  if (vectors[0].length !== expectedDim) {
    throw new Error(
      `upsertChunks: embedding dim ${vectors[0].length} ≠ table dim ${expectedDim}`
    );
  }

  const total = chunks.length;
  const client = await pool.connect();
  try {
    for (let start = 0; start < total; start += UPSERT_BATCH) {
      const slice = chunks.slice(start, start + UPSERT_BATCH);
      // Build a single multi-row INSERT … VALUES … with parameter binds.
      // 7 cols per row: entry_id, chunk_index, chunk_total, content,
      // metadata, embedding, updated_at.
      const valuesSql = [];
      const params = [];
      slice.forEach((text, i) => {
        const idx = start + i;
        const base = params.length;
        valuesSql.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector, now())`
        );
        params.push(
          entry.id,                               // $1
          idx,                                    // $2 chunk_index
          total,                                  // $3 chunk_total
          text,                                   // $4 content
          JSON.stringify(buildMetadata(entry, idx, total)), // $5 metadata jsonb
          formatVector(vectors[idx]),             // $6 embedding (vector literal)
        );
      });

      const sql = `
        INSERT INTO public.knowledge_chunks
          (entry_id, chunk_index, chunk_total, content, metadata, embedding, updated_at)
        VALUES ${valuesSql.join(", ")}
        ON CONFLICT (entry_id, chunk_index) DO UPDATE
           SET chunk_total = EXCLUDED.chunk_total,
               content     = EXCLUDED.content,
               metadata    = EXCLUDED.metadata,
               embedding   = EXCLUDED.embedding,
               updated_at  = now()
      `;
      await client.query(sql, params);
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 4. Deletes
// ---------------------------------------------------------------------------

async function deleteByEntry(entryId) {
  if (!entryId) return;
  await pgQuery(
    `DELETE FROM public.knowledge_chunks WHERE entry_id = $1`,
    [entryId]
  );
}

// Admin "wipe everything" — used by the dashboard's "Reindex everything"
// button.  TRUNCATE is much cheaper than DELETE and reclaims the HNSW index
// pages, which matters when re-embedding from scratch.
async function deleteAllVectors() {
  const stop = log.timer();
  try {
    await pgQuery(`TRUNCATE TABLE public.knowledge_chunks`);
    log.info("deleteAll done", { took_ms: stop() });
  } catch (err) {
    log.error("deleteAll failed", { took_ms: stop() }, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 5. Query
// ---------------------------------------------------------------------------

async function query({ vector, topK = 6 }) {
  if (!Array.isArray(vector) || !vector.length) {
    throw new Error("query: missing vector");
  }
  const k = Math.max(1, Math.min(50, Number(topK) || 6));
  const res = await pgQuery(
    `SELECT id, entry_id, chunk_index, chunk_total, content, metadata, score
       FROM public.match_knowledge_chunks($1::vector, $2)`,
    [formatVector(vector), k]
  );
  // Reshape to mirror Pinecone's match objects so chat.js's downstream
  // formatters (formatContext / shapeSources) need no changes.
  return res.rows.map((r) => ({
    id: r.id,
    score: typeof r.score === "number" ? r.score : Number(r.score),
    metadata: {
      ...(r.metadata || {}),
      // Make sure the canonical fields are present even when older rows have
      // sparse metadata.
      entry_id: r.entry_id,
      chunk_index: r.chunk_index,
      chunk_total: r.chunk_total,
      // chat.js reads `text` for the prompt context — keep that key alias so
      // it doesn't have to know about the new `content` column name.
      text: r.content,
    },
  }));
}

module.exports = {
  ensureIndex,
  isReady,
  upsertChunks,
  deleteByEntry,
  deleteAllVectors,
  query,
};
