-- ============================================================================
-- ATHLEAT — Sample Data Seed
-- Derived from SAMPLE_STUDENTS in KerryDashboard_v2 JSX.
-- Run AFTER athleat_schema.sql.
-- ============================================================================

-- Fixed UUIDs so foreign keys line up within this script
DO $$ BEGIN

-- ── STUDENTS ──────────────────────────────────────────────────────────────
INSERT INTO public.students (id, thinkific_user_id, full_name, email, created_at, quest_xp, best_streak, badges_earned, feedback_status, kerry_feedback)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'thk_jake_001', 'Jake Taufa', 'jake.taufa@example.com', '2025-04-03T08:14:00Z',
   820, 5,
   ARRAY['Breakfast Champion','Plant Power','Protein Pro','Pre-Game Fuelled','Recovery Boss','Hydration Hero','Game Day Ready','Habit Builder','Body Aware'],
   'draft',
   'Jake is making solid progress. Main focus: breakfast consistency and spreading protein across the day.'),
  ('a0000000-0000-0000-0000-000000000002', 'thk_lachlan_002', 'Lachlan Smith', 'lachlan.smith@example.com', '2025-04-03T09:42:00Z',
   640, 3,
   ARRAY['Breakfast Champion','Plant Power','Protein Pro','Hydration Hero','Habit Builder'],
   'none',
   NULL),
  ('a0000000-0000-0000-0000-000000000003', 'thk_tyler_003', 'Tyler Parata', 'tyler.parata@example.com', '2025-04-02T15:22:00Z',
   760, 4,
   ARRAY['Breakfast Champion','Plant Power','Protein Pro','Pre-Game Fuelled','Recovery Boss','Hydration Hero','Game Day Ready','Habit Builder','Body Aware'],
   'approved',
   'Tyler is the strongest profile in the cohort. Focus on game day carb loading and muscle gain periodisation.');

-- ── PRESCREEN ─────────────────────────────────────────────────────────────
INSERT INTO public.prescreen (student_id, dob, school_year, referral, ethnicity, blood_test, medical, medical_dates,
  supplements, sex, height_cm, weight_kg, weight_trend, living_with, cooking, cooking_skills,
  fav_foods, dislike_foods, dietary_reqs, eating_style, takeaway_frequency, takeaway_foods,
  goals, biggest_challenges, meal_priority, top_questions, info_sources,
  activity_type, days_low, days_med, days_high, session_length, completed_at)
VALUES
  -- Jake Taufa
  ('a0000000-0000-0000-0000-000000000001',
   '2009-06-12', 'Year 10', 'Rugby club', 'Maori', 'No',
   ARRAY['Sports-related injury'], '{"Sports-related injury":"2024-08"}'::jsonb,
   'Protein powder', 'Male', 178, 82.0, 'Increased',
   ARRAY['Mum','Dad'], 'Mum', 'Average — I can make simple meals',
   'Chicken, rice, pasta, eggs, bananas', 'Mushrooms, fish',
   ARRAY['None'], ARRAY['High protein'], '1 to 2 days a week', 'Maccas, KFC',
   ARRAY['Improve performance and recovery','Build muscle / gain mass'],
   ARRAY['Lack of planning','No time to prepare meals'],
   '1. Taste and flavour, 2. Convenience, 3. Nutritional value',
   'How much protein do I need? What should I eat on game day? Is creatine safe at my age?',
   ARRAY['Parents','Social media (Instagram, TikTok)'],
   ARRAY['Rugby league','Gym / weights'], 1, 2, 3, '60 to 90 minutes', '2025-04-03T08:14:00Z'),
  -- Lachlan Smith
  ('a0000000-0000-0000-0000-000000000002',
   '2008-11-03', 'Year 11', 'School', 'Australian', 'Yes',
   ARRAY['Low iron / anaemia'], '{"Low iron / anaemia":"2024-03"}'::jsonb,
   'None', 'Male', 172, 70.0, 'Stable / consistent',
   ARRAY['Mum'], 'Mum', 'Poor — microwave meals are my speciality',
   'Pizza, pasta, cereal, toast', 'Salad, most vegetables',
   ARRAY['None'], ARRAY['No particular style'], '3 to 4 days a week', 'Maccas, pizza',
   ARRAY['Improve performance and recovery','Reduce fatigue'],
   ARRAY['No time to prepare meals','Sweet tooth or cravings'],
   '1. Convenience, 2. Taste and flavour, 3. Nutritional value',
   'Why am I always tired? What is the easiest meal to prep?',
   ARRAY['Social media (Instagram, TikTok)','Friends'],
   ARRAY['Rugby league','Running / cardio'], 1, 3, 2, '45 to 60 minutes', '2025-04-03T09:42:00Z'),
  -- Tyler Parata
  ('a0000000-0000-0000-0000-000000000003',
   '2009-02-28', 'Year 10', 'Parent', 'Pacific Islander', 'No',
   ARRAY['None of the above'], NULL,
   'Vitamin D', 'Male', 180, 88.0, 'Increased',
   ARRAY['Mum','Dad','Siblings'], 'We share it', 'Good — I can follow most recipes',
   'Chicken, rice, eggs, sweet potato, fruit', 'Oysters',
   ARRAY['None'], ARRAY['High protein'], 'Once a week or less', 'Sushi occasionally',
   ARRAY['Build muscle / gain mass','Improve performance and recovery','Game day nutrition'],
   ARRAY['Lack of planning'],
   '1. Nutritional value, 2. Taste and flavour, 3. Convenience',
   'How do I build muscle while staying lean? What should my game day meal look like?',
   ARRAY['Coach','Parents'],
   ARRAY['Rugby league','Rugby union','Gym / weights'], 1, 2, 4, '60 to 90 minutes', '2025-04-02T15:22:00Z');

-- ── BLUEPRINT ANSWERS ─────────────────────────────────────────────────────
INSERT INTO public.blueprint_answers (student_id, answers, xp_earned, badges, completed_at) VALUES
  ('a0000000-0000-0000-0000-000000000001',
   '{"Breakfast 1":"2 eggs scrambled + 2 slices wholegrain toast","Breakfast 2":"1 cup Weet-Bix + 250ml milk","Breakfast 3":"Yoghurt + banana + granola","Favourite Fruits":"Banana, apple, mango, watermelon","Iron-Rich Food":"Beef mince","Calcium-Rich Food":"Milk and yoghurt","Protein 1":"Chicken breast 150g","Protein 2":"2 eggs","Recovery Snack":"Flavoured milk","Bottle Size":"750ml","Habit to Improve":"Eat breakfast every training day","Warning Signs Noted":"1 sign noted"}'::jsonb,
   820, ARRAY['Breakfast Champion','Plant Power','Protein Pro','Pre-Game Fuelled','Recovery Boss','Hydration Hero','Game Day Ready','Habit Builder','Body Aware'],
   '2025-04-03T08:14:00Z'),
  ('a0000000-0000-0000-0000-000000000002',
   '{"Breakfast 1":"Cereal and milk","Breakfast 2":"Toast with vegemite","Favourite Fruits":"Apple, banana, grapes","Iron-Rich Food":"Chicken","Protein 1":"Chicken palm size","Recovery Snack":"Chocolate milk","Bottle Size":"600ml","Hydration Check":"No, need to drink more","Warning Signs Noted":"3 sign(s) noted","Habit to Improve":"Drink more water"}'::jsonb,
   640, ARRAY['Breakfast Champion','Plant Power','Protein Pro','Hydration Hero','Habit Builder'],
   '2025-04-03T09:42:00Z'),
  ('a0000000-0000-0000-0000-000000000003',
   '{"Breakfast 1":"2 eggs + toast","Breakfast 2":"Oats with banana","Breakfast 3":"Yoghurt bowl","Favourite Fruits":"Mango, banana, watermelon, strawberries","Iron-Rich Food":"Beef steak","Protein 1":"Chicken breast 150g","Recovery Snack":"Flavoured milk + banana","Bottle Size":"1L","Hydration Check":"Yes, well hydrated","Warning Signs Noted":"None noted","Habit to Improve":"Include protein at every meal"}'::jsonb,
   760, ARRAY['Breakfast Champion','Plant Power','Protein Pro','Pre-Game Fuelled','Recovery Boss','Hydration Hero','Game Day Ready','Habit Builder','Body Aware'],
   '2025-04-02T15:22:00Z');

-- ── MISSIONS ──────────────────────────────────────────────────────────────

-- Jake Taufa missions
INSERT INTO public.missions (student_id, mission_id, status, v1, v2, v3, submitted_at, kerry_feedback, feedback_status) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'm1', 'submitted',
   '{"b1":{"url":"","desc":"2 Weet-Bix + 250ml milk + banana"},"b2":{"url":"","desc":"2 eggs + toast + OJ"},"b3":{"url":"","desc":"Yoghurt + granola + berries"}}'::jsonb,
   NULL,
   '{"b1":{"url":"","desc":""},"b2":{"url":"","desc":""},"b3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   '2025-04-04T10:00:00Z', '', 'pending'),
  ('a0000000-0000-0000-0000-000000000001', 'm2', 'submitted',
   '{"l1":{"url":"","desc":"Maccas large meal"},"l2":{"url":"","desc":"Chicken roll + chips + apple"},"l3":{"url":"","desc":"Pasta with butter and cheese"}}'::jsonb,
   NULL,
   '{"l1":{"url":"","desc":""},"l2":{"url":"","desc":""},"l3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   '2025-04-05T11:30:00Z', '', 'pending'),
  ('a0000000-0000-0000-0000-000000000001', 'm3', 'not_started', NULL, NULL,
   '{"d1":{"url":"","desc":""},"d2":{"url":"","desc":""},"d3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none'),
  ('a0000000-0000-0000-0000-000000000001', 'm4', 'not_started', NULL, NULL,
   '{"pre":{"url":"","desc":""},"post":{"url":"","desc":""},"snk":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none'),
  ('a0000000-0000-0000-0000-000000000001', 'm5', 'not_started', NULL, NULL,
   '{"pre":{"url":"","desc":""},"half":{"url":"","desc":""},"post":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none');

-- Lachlan Smith missions
INSERT INTO public.missions (student_id, mission_id, status, v1, v2, v3, submitted_at, kerry_feedback, feedback_status) VALUES
  ('a0000000-0000-0000-0000-000000000002', 'm1', 'submitted',
   '{"b1":{"url":"","desc":"Cereal + milk"},"b2":{"url":"","desc":"Toast with vegemite + OJ"},"b3":{"url":"","desc":"Skipped — no time"}}'::jsonb,
   NULL,
   '{"b1":{"url":"","desc":""},"b2":{"url":"","desc":""},"b3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   '2025-04-05T08:00:00Z', '', 'pending'),
  ('a0000000-0000-0000-0000-000000000002', 'm2', 'not_started', NULL, NULL,
   '{"l1":{"url":"","desc":""},"l2":{"url":"","desc":""},"l3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none'),
  ('a0000000-0000-0000-0000-000000000002', 'm3', 'not_started', NULL, NULL,
   '{"d1":{"url":"","desc":""},"d2":{"url":"","desc":""},"d3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none'),
  ('a0000000-0000-0000-0000-000000000002', 'm4', 'not_started', NULL, NULL,
   '{"pre":{"url":"","desc":""},"post":{"url":"","desc":""},"snk":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none'),
  ('a0000000-0000-0000-0000-000000000002', 'm5', 'not_started', NULL, NULL,
   '{"pre":{"url":"","desc":""},"half":{"url":"","desc":""},"post":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none');

-- Tyler Parata missions
INSERT INTO public.missions (student_id, mission_id, status, v1, v2, v3, submitted_at, kerry_feedback, feedback_status) VALUES
  ('a0000000-0000-0000-0000-000000000003', 'm1', 'submitted',
   '{"b1":{"url":"","desc":"2 eggs on toast + OJ"},"b2":{"url":"","desc":"Oats + banana + honey + milk"},"b3":{"url":"","desc":"Chobani yoghurt + berries + granola"}}'::jsonb,
   '{"b1":{"url":"","desc":"3 eggs scrambled + wholegrain toast + full cream milk + banana"},"b2":{"url":"","desc":"Overnight oats + chia seeds + 2 scoops protein + blueberries"},"b3":{"url":"","desc":"Chobani plain yoghurt + granola + strawberries + honey"}}'::jsonb,
   '{"b1":{"url":"","desc":""},"b2":{"url":"","desc":""},"b3":{"url":"","desc":""},"recipe":"Overnight Oats — Performance Breakfast\n\nIngredients:\n1 cup rolled oats\n1 scoop vanilla protein powder\n1 cup full cream milk\n1 tbsp chia seeds\n1 tbsp honey\n\nMethod:\nMix everything in a jar the night before. Seal and refrigerate.\nIn the morning, top with 1 banana and a handful of blueberries.\nEat within 30 minutes of waking.","shoppingList":"[ ] Rolled oats (Carman''s or Uncle Tobys)\n[ ] Vanilla protein powder (WPI preferred)\n[ ] Full cream milk\n[ ] Chia seeds\n[ ] Honey\n[ ] Bananas\n[ ] Blueberries (fresh or frozen)","blueprintNote":"This breakfast gives you 40g of protein and slow-release carbs to fuel your morning session. Prep it the night before so you are not scrambling before school."}'::jsonb,
   '2025-04-03T18:00:00Z',
   'Big improvement Tyler. Your Version 2 breakfasts are significantly higher in protein and more nutrient-dense. The overnight oats with protein is exactly what I want to see — keep that in your regular rotation.',
   'approved'),
  ('a0000000-0000-0000-0000-000000000003', 'm2', 'submitted',
   '{"l1":{"url":"","desc":"Chicken rice bowl from canteen"},"l2":{"url":"","desc":"Tuna pasta salad"},"l3":{"url":"","desc":"Sushi rolls x8 + miso soup"}}'::jsonb,
   NULL,
   '{"l1":{"url":"","desc":""},"l2":{"url":"","desc":""},"l3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   '2025-04-04T14:00:00Z', '', 'pending'),
  ('a0000000-0000-0000-0000-000000000003', 'm3', 'not_started', NULL, NULL,
   '{"d1":{"url":"","desc":""},"d2":{"url":"","desc":""},"d3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none'),
  ('a0000000-0000-0000-0000-000000000003', 'm4', 'not_started', NULL, NULL,
   '{"pre":{"url":"","desc":""},"post":{"url":"","desc":""},"snk":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none'),
  ('a0000000-0000-0000-0000-000000000003', 'm5', 'not_started', NULL, NULL,
   '{"pre":{"url":"","desc":""},"half":{"url":"","desc":""},"post":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none');

-- ── QUESTIONS ─────────────────────────────────────────────────────────────
INSERT INTO public.questions (student_id, text, asked_at, status, reply, replied_at) VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'How much protein do I actually need each day?', '2025-04-03T09:00:00Z', 'answered',
   'Great question Jake. At your age and size, aim for around 1.6 to 2g of protein per kg of body weight — so roughly 130 to 165g per day spread across all your meals.',
   '2025-04-03T14:22:00Z'),
  ('a0000000-0000-0000-0000-000000000001',
   'Is creatine safe for someone my age?', '2025-04-04T10:15:00Z', 'pending',
   NULL, NULL),
  ('a0000000-0000-0000-0000-000000000002',
   'Why am I always tired after training?', '2025-04-04T08:30:00Z', 'pending',
   NULL, NULL);

END $$;
