-- ============================================================================
-- KERRY DASHBOARD v5.1 MIGRATION
-- ----------------------------------------------------------------------------
-- 1. mission_config.sidebar_label  (short label shown in the Meal Missions
--    sidebar within the student detail panel — distinct from `name`).
-- 2. Re-seed the 5 mission rows with v5.1 naming:
--      "Mission- Breakfast 1/2/3", "Mission- Lunch 1/2/3", etc.
--    Mission 4 (Training) gains a 4th slot — `dur` (During Training).
-- 3. Existing `missions.v1/v2/v3` JSONB rows are untouched. The new `dur`
--    slot simply appears empty for historical missions; athletes get the
--    extra slot prompt next time the mission is opened.
-- ============================================================================

-- 1) sidebar_label column ------------------------------------------------------
ALTER TABLE public.mission_config
  ADD COLUMN IF NOT EXISTS sidebar_label text;

-- 2) Re-seed (UPDATE; not INSERT — primary keys already exist) -----------------
UPDATE public.mission_config SET
  name          = 'Mission- Breakfast',
  sidebar_label = 'Breakfast',
  icon          = '🌅',
  module        = 'After completing your Blueprint',
  "desc"        = 'Upload 3 pics of your breakfast on 3 different training days.',
  next_step     = 'Head back to Thinkific to complete the breakfast modules.',
  slots = '[
    {"id":"b1","label":"Mission- Breakfast 1","hint":"e.g. 2 Weet-Bix + 200ml full cream milk + 1 banana"},
    {"id":"b2","label":"Mission- Breakfast 2","hint":"e.g. 2 eggs scrambled + 2 slices wholegrain toast + 250ml OJ"},
    {"id":"b3","label":"Mission- Breakfast 3","hint":"e.g. 3/4 cup Chobani Greek yoghurt + berries + granola"}
  ]'::jsonb,
  updated_at = now()
WHERE id = 'm1';

UPDATE public.mission_config SET
  name          = 'Mission- Lunch',
  sidebar_label = 'Lunch',
  icon          = '☀️',
  module        = 'After Module 2: Carbohydrates and Fuel',
  "desc"        = 'Upload 3 pics of your lunch on 3 different training days.',
  next_step     = 'Head back to complete the carbohydrates module.',
  slots = '[
    {"id":"l1","label":"Mission- Lunch 1","hint":"e.g. 2 wholegrain rolls + shaved chicken + salad + water"},
    {"id":"l2","label":"Mission- Lunch 2","hint":"e.g. 1 cup pasta + tuna + corn + capsicum + light mayo"},
    {"id":"l3","label":"Mission- Lunch 3","hint":"e.g. 2 slices Burgen bread + avocado + 2 poached eggs + spinach"}
  ]'::jsonb,
  updated_at = now()
WHERE id = 'm2';

UPDATE public.mission_config SET
  name          = 'Mission- Dinner',
  sidebar_label = 'Dinner',
  icon          = '🌙',
  module        = 'After Module 3: Protein and Recovery',
  "desc"        = 'Upload 3 pics of your dinner on 3 different evenings.',
  next_step     = 'Head back to complete the protein and recovery modules.',
  slots = '[
    {"id":"d1","label":"Mission- Dinner 1","hint":"e.g. 150g grilled chicken + rice + 2 fists roasted veg"},
    {"id":"d2","label":"Mission- Dinner 2","hint":"e.g. 150g beef mince bolognese + 1.5 cups penne + side salad"},
    {"id":"d3","label":"Mission- Dinner 3","hint":"e.g. 2 basa fillets (baked) + sweet potato + steamed broccoli"}
  ]'::jsonb,
  updated_at = now()
WHERE id = 'm3';

-- Mission 4 gets a 4th slot: `dur` (During Training). Stored between `pre`
-- and `post` so it reads naturally in the UI (pre → dur → post → snk).
UPDATE public.mission_config SET
  name          = 'Mission- Training',
  sidebar_label = 'Training',
  icon          = '⚡',
  module        = 'After Module 4: Training Nutrition',
  "desc"        = 'Upload your pre-training, during training, post-training and daytime snack.',
  next_step     = 'Head back to complete the training nutrition modules.',
  slots = '[
    {"id":"pre", "label":"Pre Training",    "hint":"e.g. banana + toast with peanut butter — 90 min before training"},
    {"id":"dur", "label":"During Training", "hint":"e.g. sports drink + banana — sip during session if over 60 min"},
    {"id":"post","label":"Post Training",   "hint":"e.g. 300ml chocolate milk + yoghurt — within 20 min of finishing"},
    {"id":"snk", "label":"Daytime Snack",   "hint":"e.g. Greek yoghurt + blueberries + nuts — at 3pm"}
  ]'::jsonb,
  updated_at = now()
WHERE id = 'm4';

UPDATE public.mission_config SET
  name          = 'Mission- Game Day',
  sidebar_label = 'Game Day',
  icon          = '🏉',
  module        = 'After Module 5: Game Day Nutrition',
  "desc"        = 'Upload your full game day nutrition — pre-game, half-time and post-game.',
  next_step     = 'Head back to complete the game day module.',
  slots = '[
    {"id":"pre", "label":"Mission- Game Day Pre-Game",  "hint":"e.g. pasta + chicken + salad — 3 hours before kick-off"},
    {"id":"half","label":"Mission- Game Day Half-Time", "hint":"e.g. orange quarters + Gatorade + muesli bar"},
    {"id":"post","label":"Mission- Game Day Post-Game", "hint":"e.g. chicken burger + banana + chocolate milk — 45 min after full-time"}
  ]'::jsonb,
  updated_at = now()
WHERE id = 'm5';
