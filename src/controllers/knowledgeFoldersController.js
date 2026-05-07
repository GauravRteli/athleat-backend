const {
  listKnowledgeFolders,
  createKnowledgeFolder,
  updateKnowledgeFolder,
  deleteKnowledgeFolder,
} = require("../services/knowledgeFoldersService");

async function getAll(req, res, next) {
  try {
    const includeInactive = req.query.includeInactive === "true";
    const data = await listKnowledgeFolders({ activeOnly: !includeInactive });
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function postFolder(req, res, next) {
  try {
    const data = await createKnowledgeFolder(req.body || {});
    return res.status(201).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function patchFolder(req, res, next) {
  try {
    const { id } = req.params;
    const data = await updateKnowledgeFolder(id, req.body || {});
    return res.status(200).json({ data });
  } catch (error) {
    return next(error);
  }
}

async function deleteFolder(req, res, next) {
  try {
    const { id } = req.params;
    await deleteKnowledgeFolder(id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getAll, postFolder, patchFolder, deleteFolder };
