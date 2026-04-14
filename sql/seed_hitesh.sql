-- ============================================================================
-- ATHLEAT — Sample Data for Hitesh Pampaniya
-- Run in Supabase SQL Editor after athleat_schema.sql is already applied.
-- ============================================================================

DO $$ BEGIN

-- ── STUDENT ───────────────────────────────────────────────────────────────
INSERT INTO public.students (id, thinkific_user_id, full_name, email, created_at, quest_xp, best_streak, badges_earned, feedback_status, kerry_feedback)
VALUES
  ('a0000000-0000-0000-0000-000000000004', 'thk_hitesh_004', 'Hitesh Pampaniya', 'hitesh.pampaniya@example.com', '2025-04-06T07:30:00Z',
   710, 6,
   ARRAY['Breakfast Champion','Plant Power','Protein Pro','Recovery Boss','Hydration Hero','Habit Builder','Body Aware'],
   'draft',
   'Hitesh is very consistent with his meals. Needs to add more variety to his vegetable intake and increase carbs on high training days.');

-- ── PRESCREEN ─────────────────────────────────────────────────────────────
INSERT INTO public.prescreen (student_id, dob, school_year, referral, ethnicity, blood_test, medical, medical_dates,
  supplements, sex, height_cm, weight_kg, weight_trend, living_with, cooking, cooking_skills,
  fav_foods, dislike_foods, dietary_reqs, eating_style, takeaway_frequency, takeaway_foods,
  goals, biggest_challenges, meal_priority, top_questions, info_sources,
  activity_type, days_low, days_med, days_high, session_length, completed_at)
VALUES
  ('a0000000-0000-0000-0000-000000000004',
   '2009-03-15', 'Year 10', 'Coach', 'Indian', 'No',
   ARRAY['None of the above'], NULL,
   'Multivitamin', 'Male', 175, 74.0, 'Stable / consistent',
   ARRAY['Mum','Dad','Siblings'], 'Mum', 'Good — I can follow most recipes',
   'Dal, rice, chicken curry, roti, paneer, eggs, bananas', 'Beetroot, capsicum',
   ARRAY['Vegetarian options preferred'], ARRAY['High protein','High carb on training days'],
   '1 to 2 days a week', 'Subway, butter chicken from local takeaway',
   ARRAY['Improve performance and recovery','Build muscle / gain mass','Learn to meal prep'],
   ARRAY['Lack of planning','Not enough variety'],
   '1. Nutritional value, 2. Taste and flavour, 3. Convenience',
   'How do I get enough protein from vegetarian meals? What should I eat before morning training? How much water do I really need?',
   ARRAY['Coach','YouTube','Parents'],
   ARRAY['Rugby league','Cricket','Gym / weights'], 1, 2, 3, '60 to 90 minutes', '2025-04-06T07:30:00Z');

-- ── BLUEPRINT ANSWERS ─────────────────────────────────────────────────────
INSERT INTO public.blueprint_answers (student_id, answers, xp_earned, badges, completed_at) VALUES
  ('a0000000-0000-0000-0000-000000000004',
   '{"Breakfast 1":"3 eggs scrambled + 2 slices wholegrain toast + glass of milk","Breakfast 2":"Overnight oats + banana + honey + chia seeds","Breakfast 3":"Paneer paratha + yoghurt + OJ","Favourite Fruits":"Banana, mango, apple, pomegranate","Iron-Rich Food":"Spinach dal + chicken liver","Calcium-Rich Food":"Paneer and yoghurt","Protein 1":"Chicken thigh 150g","Protein 2":"2 boiled eggs + glass of milk","Recovery Snack":"Banana smoothie with protein powder","Bottle Size":"1L","Hydration Check":"Yes, well hydrated","Habit to Improve":"Prep lunch the night before","Warning Signs Noted":"1 sign noted"}'::jsonb,
   710, ARRAY['Breakfast Champion','Plant Power','Protein Pro','Recovery Boss','Hydration Hero','Habit Builder','Body Aware'],
   '2025-04-06T07:30:00Z');

-- ── MISSIONS ──────────────────────────────────────────────────────────────
INSERT INTO public.missions (student_id, mission_id, status, v1, v2, v3, submitted_at, kerry_feedback, feedback_status) VALUES
  -- M1 Breakfast — submitted with V1
  ('a0000000-0000-0000-0000-000000000004', 'm1', 'submitted',
   '{"b1":{"url":"","desc":"3 eggs scrambled + toast + milk"},"b2":{"url":"","desc":"Overnight oats + banana + honey"},"b3":{"url":"","desc":"Paneer paratha + yoghurt"}}'::jsonb,
   NULL,
   '{"b1":{"url":"","desc":""},"b2":{"url":"","desc":""},"b3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   '2025-04-07T08:15:00Z', '', 'pending'),
  -- M2 Lunch — submitted with V1
  ('a0000000-0000-0000-0000-000000000004', 'm2', 'submitted',
   '{"l1":{"url":"","desc":"Chicken curry + rice + salad"},"l2":{"url":"","desc":"Dal + roti + raita + apple"},"l3":{"url":"","desc":"Subway footlong chicken teriyaki"}}'::jsonb,
   NULL,
   '{"l1":{"url":"","desc":""},"l2":{"url":"","desc":""},"l3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   '2025-04-08T12:45:00Z', '', 'pending'),
  -- M3 Dinner — submitted with V1 and V2
  ('a0000000-0000-0000-0000-000000000004', 'm3', 'submitted',
   '{"d1":{"url":"","desc":"Butter chicken + basmati rice"},"d2":{"url":"","desc":"Grilled chicken + sweet potato + steamed broccoli"},"d3":{"url":"","desc":"Paneer tikka + naan + dal"}}'::jsonb,
   '{"d1":{"url":"","desc":"Grilled chicken breast 200g + brown rice + roasted vegetables"},"d2":{"url":"","desc":"Salmon fillet + quinoa + spinach salad"},"d3":{"url":"","desc":"Egg curry + wholegrain roti + raita + side salad"}}'::jsonb,
   '{"d1":{"url":"","desc":""},"d2":{"url":"","desc":""},"d3":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   '2025-04-09T19:00:00Z', '', 'pending'),
  -- M4 Training — not started
  ('a0000000-0000-0000-0000-000000000004', 'm4', 'not_started', NULL, NULL,
   '{"pre":{"url":"","desc":""},"post":{"url":"","desc":""},"snk":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none'),
  -- M5 Game Day — not started
  ('a0000000-0000-0000-0000-000000000004', 'm5', 'not_started', NULL, NULL,
   '{"pre":{"url":"","desc":""},"half":{"url":"","desc":""},"post":{"url":"","desc":""},"recipe":"","shoppingList":"","blueprintNote":""}'::jsonb,
   NULL, '', 'none');

-- ── QUESTIONS ─────────────────────────────────────────────────────────────
INSERT INTO public.questions (student_id, text, asked_at, status, reply, replied_at) VALUES
  ('a0000000-0000-0000-0000-000000000004',
   'How do I get enough protein on days when I eat vegetarian?', '2025-04-07T09:20:00Z', 'answered',
   'Great question Hitesh. On veg days, combine dal with rice or roti for complete protein. Add paneer, yoghurt, eggs and a glass of milk — that alone gets you close to 80g. Top up with a protein shake post-training and you will hit your target.',
   '2025-04-07T15:10:00Z'),
  ('a0000000-0000-0000-0000-000000000004',
   'Is it okay to train in the morning before eating?', '2025-04-08T06:45:00Z', 'pending',
   NULL, NULL),
  ('a0000000-0000-0000-0000-000000000004',
   'What snacks can I keep in my school bag that won''t go off?', '2025-04-09T11:00:00Z', 'pending',
   NULL, NULL);

END $$;
