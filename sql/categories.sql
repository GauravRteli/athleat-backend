-- public.categories — meal timing slots (Data Upload/categories.csv)
-- Run: psql "$DATABASE_URL" -f backend/sql/categories.sql
-- If you previously created public.meal_time_categories, migrate or drop that table separately.

CREATE TABLE IF NOT EXISTS public.categories (
  id              bigint        NOT NULL,
  title           varchar(255)  NOT NULL,
  description     text          NULL,
  scheduled_time  time          NULL,
  sort_order      integer       NOT NULL,
  image           varchar(512)  NULL,
  created_at      timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT categories_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS categories_sort_order_idx
  ON public.categories (sort_order);

COMMENT ON TABLE public.categories IS 'Meal timing slots (Breakfast, Lunch, Training, etc.) from legacy categories export.';

INSERT INTO public.categories (id, title, description, scheduled_time, sort_order, image, created_at, updated_at)
VALUES
  (2, 'Breakfast', 'Consume all Meals in the Breakfast plan together to maximise muscle protein signalling', '08:30:00', 1, 'meal_times/tUKBVYgJ0jG8DdTjmGLtnQR8anCvRMkcZUaY6Ono.jpg', '2024-12-11 05:16:12', '2025-05-31 23:48:25'),
  (3, 'Lunch', NULL, '12:00:00', 6, 'meal_times/HLZkNYCZ9l1uYZpjWrI0g6jqbwIDVwRSNUXrX5w9.jpg', '2024-12-11 05:16:28', '2025-10-12 04:09:05'),
  (4, 'Dinner', NULL, '19:00:00', 12, 'meal_times/GqhYZzlpRmqzWgP0jw61OssulTqttOZyBZAZZt6G.jpg', '2024-12-11 05:16:48', '2025-10-12 04:48:44'),
  (5, 'Training - AM', 'Surfing', '08:30:00', 4, 'meal_times/eUdgDovTGJxmyFv72vOS2U9NsyzQVSuAo6WDlgY7.jpg', '2024-12-12 13:24:04', '2025-10-12 04:45:21'),
  (12, 'Dessert', NULL, '20:30:00', 13, NULL, '2025-03-11 03:03:10', '2025-10-12 04:48:54'),
  (13, 'Afternoon snack', NULL, '15:29:00', 8, NULL, '2025-03-11 03:16:16', '2025-10-12 04:47:43'),
  (14, 'Morning snack', NULL, '09:00:00', 2, NULL, '2025-03-11 03:16:49', '2025-10-12 04:07:21'),
  (16, 'Pre-Training AM', NULL, '10:00:00', 3, 'meal_times/zuzZb57k2jwRgKIy5FNU9NuW5ovsQlhob8YnXYJS.jpg', '2025-05-31 23:17:10', '2025-10-12 04:08:12'),
  (17, 'Post-Training AM', NULL, '14:00:00', 5, 'meal_times/hefRPuXsiMEfl3dkVU4hz25NYrtm5QzkERjWojjx.jpg', '2025-05-31 23:18:28', '2025-10-12 04:08:40'),
  (20, 'Pre-Training PM', NULL, NULL, 9, NULL, '2025-10-12 04:11:12', '2025-10-12 04:47:57'),
  (21, 'Post-Training PM', NULL, NULL, 11, NULL, '2025-10-12 04:11:40', '2025-10-12 04:48:22'),
  (22, 'Lunch - 2nd Break', NULL, NULL, 7, NULL, '2025-10-12 04:44:45', '2025-10-12 04:47:19'),
  (23, 'Training - PM', NULL, NULL, 10, NULL, '2025-10-12 04:45:54', '2025-10-12 04:48:08')
ON CONFLICT (id) DO UPDATE SET
  title           = EXCLUDED.title,
  description     = EXCLUDED.description,
  scheduled_time  = EXCLUDED.scheduled_time,
  sort_order      = EXCLUDED.sort_order,
  image           = EXCLUDED.image,
  updated_at      = EXCLUDED.updated_at;
