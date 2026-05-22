// Relative storage paths (e.g. "items/abc.jpg") → https://athleat.com/storage/items/abc.jpg
// Absolute https://, http://, and data: URLs are left unchanged.

const STORAGE_BASE_URL = (
  process.env.STORAGE_BASE_URL ||
  process.env.NEXT_PUBLIC_STORAGE_BASE_URL ||
  "https://athleat.com/storage"
).replace(/\/+$/, "");

function resolveStorageUrl(path) {
  if (!path) return "";
  const s = String(path).trim();
  if (!s) return "";
  if (s.startsWith("data:")) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return `${STORAGE_BASE_URL}/${s.replace(/^\/+/, "")}`;
}

module.exports = { STORAGE_BASE_URL, resolveStorageUrl };
