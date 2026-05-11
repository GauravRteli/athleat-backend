const { query } = require("../config/postgres");

const DEFAULT_CONFIG = {
  pal: {
    Lower: { low: 1.6, high: 1.75 },
    Moderate: { low: 1.8, high: 2.0 },
    High: { low: 2.0, high: 2.15 },
  },
  carb_gkg: {
    Lower: { low: 4.5, high: 5.0 },
    Moderate: { low: 5.0, high: 6.0 },
    High: { low: 6.5, high: 7.0 },
  },
  protein_gkg: { low: 1.6, high: 2.2 },
  fat_gday: { low: 95, high: 115 },
  // Kerry-tunable: how many cards the V3 carousel returns per request.
  // Default lines up with the V3 mission UI, which presents one slot at a
  // time and benefits from a tighter "DB pick + 1 AI" trio.
  carousel_settings: { suggestion_count: 3 },
};

function normalizeCarouselSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_CONFIG.carousel_settings };
  }
  const n = Number(value.suggestion_count);
  return {
    suggestion_count: Number.isFinite(n) && n >= 1 && n <= 12
      ? Math.round(n)
      : DEFAULT_CONFIG.carousel_settings.suggestion_count,
  };
}

function shape(row) {
  return {
    id: row.id,
    pal: row.pal,
    carb_gkg: row.carb_gkg,
    protein_gkg: row.protein_gkg,
    fat_gday: row.fat_gday,
    carousel_settings: normalizeCarouselSettings(row.carousel_settings),
    updated_at: row.updated_at,
  };
}

async function getEerConfig() {
  const result = await query(
    `SELECT id, pal, carb_gkg, protein_gkg, fat_gday, carousel_settings, updated_at
     FROM public.eer_config WHERE id = 1 LIMIT 1`,
  );
  if (!result.rows[0]) {
    await query(
      `INSERT INTO public.eer_config (id, pal, carb_gkg, protein_gkg, fat_gday, carousel_settings)
       VALUES (1, $1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [
        JSON.stringify(DEFAULT_CONFIG.pal),
        JSON.stringify(DEFAULT_CONFIG.carb_gkg),
        JSON.stringify(DEFAULT_CONFIG.protein_gkg),
        JSON.stringify(DEFAULT_CONFIG.fat_gday),
        JSON.stringify(DEFAULT_CONFIG.carousel_settings),
      ],
    );
    return { id: 1, ...DEFAULT_CONFIG, updated_at: new Date().toISOString() };
  }
  return shape(result.rows[0]);
}

async function updateEerConfig(payload) {
  const result = await query(
    `INSERT INTO public.eer_config (id, pal, carb_gkg, protein_gkg, fat_gday, carousel_settings, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       pal = EXCLUDED.pal,
       carb_gkg = EXCLUDED.carb_gkg,
       protein_gkg = EXCLUDED.protein_gkg,
       fat_gday = EXCLUDED.fat_gday,
       carousel_settings = EXCLUDED.carousel_settings,
       updated_at = now()
     RETURNING *`,
    [
      JSON.stringify(payload.pal || DEFAULT_CONFIG.pal),
      JSON.stringify(payload.carb_gkg || DEFAULT_CONFIG.carb_gkg),
      JSON.stringify(payload.protein_gkg || DEFAULT_CONFIG.protein_gkg),
      JSON.stringify(payload.fat_gday || DEFAULT_CONFIG.fat_gday),
      JSON.stringify(normalizeCarouselSettings(payload.carousel_settings)),
    ],
  );
  return shape(result.rows[0]);
}

module.exports = { getEerConfig, updateEerConfig, DEFAULT_CONFIG };
