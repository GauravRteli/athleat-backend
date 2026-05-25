/**
 * Format a Postgres `date` / ISO string for HTML <input type="date"> (YYYY-MM-DD).
 */
function toYyyyMmDd(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string") {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

module.exports = { toYyyyMmDd };
