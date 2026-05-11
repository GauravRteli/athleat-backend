const { query } = require("../../config/postgres");

function normalizeToHttpsIfPossible(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (t.startsWith("https://")) return t;
  if (t.startsWith("http://")) return `https://${t.slice(7)}`;
  return t;
}

function parseMissionVersion(json) {
  if (json == null) return null;
  if (typeof json === "object") return json;
  if (typeof json === "string") {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Virtual Kez should use the same hosted image the athlete upload flow saved
 * on `public.missions` (v1/v2 JSON per slot: `{ url, localUrl, desc }`).
 * The dashboard often still has a browser `data:` / blob URL in `localUrl`;
 * prefer the persisted `url` (Cloudinary HTTPS) when present.
 */
async function resolveMealImageUrlForVision({ student_id, mission_id, slot_id, version, client_image_url }) {
  const clientRaw = String(client_image_url || "").trim();

  const { rows } = await query(
    `SELECT v1, v2 FROM public.missions WHERE student_id = $1 AND mission_id = $2 LIMIT 1`,
    [student_id, mission_id],
  );
  const row = rows?.[0];
  const verKey = version === "v2" ? "v2" : "v1";
  const verObj = row ? parseMissionVersion(row[verKey]) : null;
  const pic = verObj && typeof verObj === "object" ? verObj[slot_id] : null;
  const dbUrlRaw = pic && String(pic.url || "").trim();

  const dbHttps = normalizeToHttpsIfPossible(dbUrlRaw);
  if (dbHttps.startsWith("https://")) return dbHttps;

  const clientHttps = normalizeToHttpsIfPossible(clientRaw);
  if (clientHttps.startsWith("https://")) return clientHttps;

  if (clientRaw.startsWith("data:image/")) return clientRaw;
  const dbData = dbUrlRaw && String(dbUrlRaw).startsWith("data:image/") ? dbUrlRaw : "";
  if (dbData) return dbData;

  return clientRaw || dbUrlRaw || "";
}

module.exports = { resolveMealImageUrlForVision, normalizeToHttpsIfPossible };
