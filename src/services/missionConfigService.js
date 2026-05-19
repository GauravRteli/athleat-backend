const { query } = require("../config/postgres");

async function getMissionConfig() {
  const result = await query(
    `SELECT id, name, sidebar_label, icon, module, "desc", next_step, slots, updated_at
     FROM public.mission_config
     ORDER BY id`,
  );

  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    sidebarLabel: r.sidebar_label || deriveSidebarLabel(r.name),
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
       SET name = $1, sidebar_label = $2, icon = $3, module = $4, "desc" = $5,
           next_step = $6, slots = $7, updated_at = now()
       WHERE id = $8`,
      [
        c.name,
        c.sidebarLabel || deriveSidebarLabel(c.name),
        c.icon,
        c.module,
        c.desc,
        c.nextStep,
        JSON.stringify(c.slots),
        c.id,
      ],
    );
  }
}

// Best-effort fallback for legacy rows where sidebar_label hasn't been set
// yet — strips the "Mission- " / "Mission N — " prefix off the name.
function deriveSidebarLabel(name) {
  if (!name) return "";
  return String(name)
    .replace(/^mission[\s-]*\d*[\s—-]*/i, "")
    .replace(/\s+pics$/i, "")
    .trim();
}

module.exports = {
  getMissionConfig,
  saveMissionConfig,
};
