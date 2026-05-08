const {
  listKnowledgeEntries,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
} = require("../services/knowledgeEntriesService");
const indexer = require("../services/rag/indexer");
const pinecone = require("../services/rag/pinecone");
const { runBackfillAsync } = require("../services/rag/backfill");
const { query } = require("../config/postgres");

async function getAll(req, res, next) {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const data = await listKnowledgeEntries({ activeOnly: !includeInactive });
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function postEntry(req, res, next) {
  try {
    const data = await createKnowledgeEntry(req.body || {});
    return res.status(201).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function patchEntry(req, res, next) {
  try {
    const { id } = req.params;
    const data = await updateKnowledgeEntry(id, req.body || {});
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function deleteEntry(req, res, next) {
  try {
    const { id } = req.params;
    await deleteKnowledgeEntry(id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

async function reindexEntry(req, res, next) {
  try {
    const { id } = req.params;
    // Reset the row to "pending" so the UI immediately reflects the retry.
    await query(
      `UPDATE public.knowledge_entries
          SET embedding_status = 'pending',
              embedding_error  = NULL,
              updated_at       = now()
        WHERE id = $1`,
      [id]
    );
    // Fire-and-forget: clients poll the entry list to see status flip.
    indexer
      .reindexEntryById(id)
      .catch((err) => console.error("[rag] reindexEntryById error:", err));
    return res.status(202).json({ ok: true, status: "pending" });
  } catch (error) {
    return next(error);
  }
}

// Admin: wipe ALL vectors from Pinecone and re-embed every active entry.
// Files in Cloudinary and rows in Postgres are not touched. We do the wipe
// + status reset SYNCHRONOUSLY so the response can report `{ queued: N }`
// and the frontend's status poll immediately sees rows flip to 'pending'.
// The actual re-embedding runs in the background.
async function reindexAll(req, res, next) {
  try {
    // 1. Wipe every vector in the configured index.
    await pinecone.deleteAllVectors();

    // 2. Reset every active row to pending so the next poll shows progress.
    const result = await query(
      `UPDATE public.knowledge_entries
          SET embedding_status = 'pending',
              embedding_error  = NULL,
              embedded_at      = NULL,
              updated_at       = now()
        WHERE is_active = true
        RETURNING id`
    );
    const queued = result.rowCount || 0;

    // 3. Kick the normal backfill in the background — the standard
    //    indexer logs (`[rag][indexer …]`) cover the rest.
    runBackfillAsync();

    return res.status(202).json({ ok: true, wiped: true, queued });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getAll,
  postEntry,
  patchEntry,
  deleteEntry,
  reindexEntry,
  reindexAll,
};
