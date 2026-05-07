const { query } = require("../config/postgres");

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listKnowledgeFolders({ activeOnly = true } = {}) {
  const where = activeOnly ? "WHERE is_active = true" : "";
  const result = await query(
    `SELECT * FROM public.knowledge_folders ${where} ORDER BY created_at ASC`,
  );
  return result.rows.map(shape);
}

async function createKnowledgeFolder({ name }) {
  const trimmed = (name || "").trim();
  if (!trimmed) throw new Error("Folder name is required");
  const result = await query(
    `INSERT INTO public.knowledge_folders (name) VALUES ($1) RETURNING *`,
    [trimmed],
  );
  return shape(result.rows[0]);
}

async function updateKnowledgeFolder(id, payload) {
  const fields = [];
  const values = [];
  let i = 1;
  ["name", "is_active"].forEach((f) => {
    if (payload[f] !== undefined) {
      fields.push(`${f} = $${i++}`);
      values.push(payload[f]);
    }
  });
  if (!fields.length) return null;
  fields.push("updated_at = now()");
  values.push(id);
  const result = await query(
    `UPDATE public.knowledge_folders SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ? shape(result.rows[0]) : null;
}

async function deleteKnowledgeFolder(id) {
  // Soft-delete the folder. We also unassign any files from it so they appear
  // at the root level rather than disappearing.
  await query(
    `UPDATE public.knowledge_entries
       SET folder_id = NULL, updated_at = now()
     WHERE folder_id = $1 AND type = 'file'`,
    [id],
  );
  await query(
    `UPDATE public.knowledge_folders
       SET is_active = false, updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

module.exports = {
  listKnowledgeFolders,
  createKnowledgeFolder,
  updateKnowledgeFolder,
  deleteKnowledgeFolder,
};
