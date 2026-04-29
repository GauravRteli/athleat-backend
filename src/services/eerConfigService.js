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
};

function shape(row) {
  return {
    id: row.id,
    pal: row.pal,
    carb_gkg: row.carb_gkg,
    protein_gkg: row.protein_gkg,
    fat_gday: row.fat_gday,
    updated_at: row.updated_at,
  };
}

async function getEerConfig() {
  const result = await query(
    `SELECT id, pal, carb_gkg, protein_gkg, fat_gday, updated_at FROM public.eer_config WHERE id = 1 LIMIT 1`,
  );
  if (!result.rows[0]) {
    await query(
      `INSERT INTO public.eer_config (id, pal, carb_gkg, protein_gkg, fat_gday)
       VALUES (1, $1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [
        JSON.stringify(DEFAULT_CONFIG.pal),
        JSON.stringify(DEFAULT_CONFIG.carb_gkg),
        JSON.stringify(DEFAULT_CONFIG.protein_gkg),
        JSON.stringify(DEFAULT_CONFIG.fat_gday),
      ],
    );
    return { id: 1, ...DEFAULT_CONFIG, updated_at: new Date().toISOString() };
  }
  return shape(result.rows[0]);
}

async function updateEerConfig(payload) {
  const result = await query(
    `INSERT INTO public.eer_config (id, pal, carb_gkg, protein_gkg, fat_gday, updated_at)
     VALUES (1, $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET
       pal = EXCLUDED.pal,
       carb_gkg = EXCLUDED.carb_gkg,
       protein_gkg = EXCLUDED.protein_gkg,
       fat_gday = EXCLUDED.fat_gday,
       updated_at = now()
     RETURNING *`,
    [
      JSON.stringify(payload.pal || DEFAULT_CONFIG.pal),
      JSON.stringify(payload.carb_gkg || DEFAULT_CONFIG.carb_gkg),
      JSON.stringify(payload.protein_gkg || DEFAULT_CONFIG.protein_gkg),
      JSON.stringify(payload.fat_gday || DEFAULT_CONFIG.fat_gday),
    ],
  );
  return shape(result.rows[0]);
}

module.exports = { getEerConfig, updateEerConfig, DEFAULT_CONFIG };
