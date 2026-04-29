const {
  listKnowledgeEntries,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
} = require("../services/knowledgeEntriesService");

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

module.exports = { getAll, postEntry, patchEntry, deleteEntry };
