const { query } = require("../config/postgres");

async function getMissionConfig() {
  const result = await query(
    `SELECT id, name, icon, module, "desc", next_step, slots, updated_at
     FROM public.mission_config
     ORDER BY id`,
  );

  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    module: r.module,
    desc: r.desc,
    nextStep: r.next_step,
    slots: r.slots,
    updatedAt: r.updated_at,
  }));
}

async function saveMissionConfig(configs) {
  for (const c of configs) {
    await query(
      `UPDATE public.mission_config
       SET name = $1, icon = $2, module = $3, "desc" = $4, next_step = $5, slots = $6, updated_at = now()
       WHERE id = $7`,
      [c.name, c.icon, c.module, c.desc, c.nextStep, JSON.stringify(c.slots), c.id],
    );
  }
}

module.exports = {
  getMissionConfig,
  saveMissionConfig,
};
