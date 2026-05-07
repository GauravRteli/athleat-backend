const { query } = require("../config/postgres");

const VALID_TYPES = ["knowledge", "correction", "never", "file"];

function shape(row) {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    content: row.content,
    wrong_answer: row.wrong_answer,
    right_answer: row.right_answer,
    folder_id: row.folder_id,
    file_name: row.file_name,
    file_url: row.file_url,
    file_public_id: row.file_public_id,
    file_size: row.file_size,
    file_size_bytes: row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
    file_type: row.file_type,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listKnowledgeEntries({ activeOnly = true } = {}) {
  const where = activeOnly ? "WHERE is_active = true" : "";
  const result = await query(
    `SELECT * FROM public.knowledge_entries ${where} ORDER BY created_at DESC`,
  );
  return result.rows.map(shape);
}

async function createKnowledgeEntry(payload) {
  if (!VALID_TYPES.includes(payload.type)) {
    throw new Error(`Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`);
  }
  const result = await query(
    `INSERT INTO public.knowledge_entries
      (type, category, content, wrong_answer, right_answer,
       folder_id, file_name, file_url, file_public_id,
       file_size, file_size_bytes, file_type, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, true))
     RETURNING *`,
    [
      payload.type,
      payload.category || null,
      payload.content || null,
      payload.wrong_answer || null,
      payload.right_answer || null,
      payload.folder_id || null,
      payload.file_name || null,
      payload.file_url || null,
      payload.file_public_id || null,
      payload.file_size || null,
      payload.file_size_bytes != null ? Number(payload.file_size_bytes) : null,
      payload.file_type || null,
      payload.is_active,
    ],
  );
  return shape(result.rows[0]);
}

async function updateKnowledgeEntry(id, payload) {
  const fields = [];
  const values = [];
  let i = 1;
  [
    "category", "content", "wrong_answer", "right_answer",
    "folder_id", "file_name", "file_url", "file_public_id",
    "file_size", "file_size_bytes", "file_type", "is_active",
  ].forEach((f) => {
    if (payload[f] !== undefined) {
      fields.push(`${f} = $${i++}`);
      values.push(payload[f]);
    }
  });
  if (!fields.length) return null;
  fields.push("updated_at = now()");
  values.push(id);
  const result = await query(
    `UPDATE public.knowledge_entries SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ? shape(result.rows[0]) : null;
}

async function deleteKnowledgeEntry(id) {
  await query(
    `UPDATE public.knowledge_entries SET is_active = false, updated_at = now() WHERE id = $1`,
    [id],
  );
}

module.exports = {
  listKnowledgeEntries,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
};
