// Pinecone client + index helpers.
//
// Responsibilities:
//   • lazy client init (so a missing key only blows up at first use)
//   • `ensureIndex()` — idempotently create the configured serverless index
//     (called once at server startup)
//   • `upsertChunks(entry, chunks, vectors)` — write one vector per chunk
//   • `deleteByEntry(entryId)` — remove every vector belonging to one entry
//   • `query({ vector, topK, filter })` — semantic search
//
// Vector ID convention: `${entry_id}::${chunkIndex}` so a single entry's
// chunks are easy to enumerate / delete by metadata filter.

const { Pinecone } = require("@pinecone-database/pinecone");
const env = require("../../config/env");
const log = require("./log").tag("pinecone");

let _client = null;
let _indexReady = false;

function getClient() {
  if (!env.pinecone.apiKey) {
    throw new Error(
      "PINECONE_API_KEY is not set — cannot use the vector store. Add it to backend/.env."
    );
  }
  if (!_client) _client = new Pinecone({ apiKey: env.pinecone.apiKey });
  return _client;
}

function getIndex() {
  return getClient().index(env.pinecone.indexName);
}

async function ensureIndex() {
  if (!env.pinecone.apiKey) {
    log.warn("PINECONE_API_KEY missing — vector indexing disabled");
    return false;
  }
  const client = getClient();
  try {
    const list = await client.listIndexes();
    const existing = (list.indexes || []).find(
      (i) => i.name === env.pinecone.indexName
    );
    if (!existing) {
      log.info("creating index", {
        name: env.pinecone.indexName,
        dim: env.pinecone.dimension,
        cloud: env.pinecone.cloud,
        region: env.pinecone.region,
      });
      await client.createIndex({
        name: env.pinecone.indexName,
        dimension: env.pinecone.dimension,
        metric: "cosine",
        spec: {
          serverless: {
            cloud: env.pinecone.cloud,
            region: env.pinecone.region,
          },
        },
        waitUntilReady: true,
      });
    } else if (existing.dimension && existing.dimension !== env.pinecone.dimension) {
      log.warn("DIMENSION MISMATCH — embeddings will fail to upsert", {
        index: env.pinecone.indexName,
        index_dim: existing.dimension,
        env_dim: env.pinecone.dimension,
        fix: `Set PINECONE_DIMENSION=${existing.dimension} in backend/.env (and restart)`,
      });
    }
    _indexReady = true;
    log.info("connected", {
      index: env.pinecone.indexName,
      dim: existing?.dimension || env.pinecone.dimension,
    });
    return true;
  } catch (err) {
    log.error("ensureIndex failed", { index: env.pinecone.indexName }, err);
    return false;
  }
}

// Pinecone caps metadata size at 40 KB per record. We keep the chunk text
// itself under ~8 KB to leave headroom for the rest of the metadata fields.
const MAX_METADATA_TEXT = 8000;

function buildMetadata(entry, chunkText, chunkIndex, chunkTotal) {
  const meta = {
    entry_id: String(entry.id),
    entry_type: String(entry.type || ""),
    chunk_index: chunkIndex,
    chunk_total: chunkTotal,
    text:
      chunkText.length > MAX_METADATA_TEXT
        ? chunkText.slice(0, MAX_METADATA_TEXT)
        : chunkText,
  };
  if (entry.folder_id) meta.folder_id = String(entry.folder_id);
  if (entry.category) meta.category = String(entry.category);
  if (entry.file_name) meta.file_name = String(entry.file_name);
  if (entry.file_url) meta.file_url = String(entry.file_url);
  if (entry.file_type) meta.file_type = String(entry.file_type);
  return meta;
}

const UPSERT_BATCH = 100;

async function upsertChunks(entry, chunks, vectors) {
  if (!chunks?.length || chunks.length !== vectors?.length) {
    throw new Error("upsertChunks: chunks and vectors length must match");
  }
  const index = getIndex();
  const total = chunks.length;
  const records = chunks.map((text, i) => ({
    id: `${entry.id}::${i}`,
    values: vectors[i],
    metadata: buildMetadata(entry, text, i, total),
  }));
  // Pinecone JS SDK v7 takes an options object (`{ records, namespace? }`),
  // not the bare array that v3/v4 accepted. Passing the array directly fails
  // validator with "Must pass in at least 1 record to upsert."
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    await index.upsert({ records: records.slice(i, i + UPSERT_BATCH) });
  }
}

async function deleteByEntry(entryId) {
  const index = getIndex();
  // The cheapest reliable way to wipe an entry's chunks: enumerate IDs and
  // delete by ID list. listPaginated supports prefix on serverless indexes.
  try {
    let pageToken;
    const idsToDelete = [];
    do {
      const page = await index.listPaginated({
        prefix: `${entryId}::`,
        paginationToken: pageToken,
      });
      for (const v of page.vectors || []) idsToDelete.push(v.id);
      pageToken = page.pagination?.next;
    } while (pageToken);
    if (idsToDelete.length) {
      // Pinecone caps deleteMany at 1000 ids per call. v7 SDK takes the
      // ids inside an options object: `{ ids: [...] }`.
      for (let i = 0; i < idsToDelete.length; i += 1000) {
        await index.deleteMany({ ids: idsToDelete.slice(i, i + 1000) });
      }
    }
  } catch (err) {
    // Some Pinecone tiers / regions don't support `listPaginated` — fall back
    // to filter-based delete (only available on pod-based indexes; will throw
    // on serverless starter tier, which is fine because the upsert that
    // follows will overwrite anyway).
    try {
      await index.deleteMany({ filter: { entry_id: { $eq: String(entryId) } } });
    } catch (innerErr) {
      log.warn("deleteByEntry fallback failed", { id: entryId }, innerErr);
    }
  }
}

async function query({ vector, topK = 6, filter = undefined }) {
  const index = getIndex();
  const res = await index.query({
    vector,
    topK,
    includeMetadata: true,
    ...(filter ? { filter } : {}),
  });
  return res.matches || [];
}

// Wipe every vector in the configured namespace. Used by the admin
// "rebuild from scratch" flow — files in Cloudinary and rows in Postgres
// are NOT touched; only the Pinecone vectors are cleared so the next
// backfill rebuilds them from the source of truth.
async function deleteAllVectors() {
  const index = getIndex();
  const stop = log.timer();
  try {
    await index.deleteAll();
    log.info("deleteAll done", { index: env.pinecone.indexName, took_ms: stop() });
  } catch (err) {
    log.error("deleteAll failed", { index: env.pinecone.indexName, took_ms: stop() }, err);
    throw err;
  }
}

function isReady() {
  return _indexReady;
}

module.exports = {
  ensureIndex,
  upsertChunks,
  deleteByEntry,
  deleteAllVectors,
  query,
  isReady,
};
