-- Add emoji field to Food Preference "sub categories" (flags).
-- Safe to run multiple times.

ALTER TABLE IF EXISTS public.flags
  ADD COLUMN IF NOT EXISTS emoji text;

-- Optional: simple constraint to keep it reasonable (emoji / short string).
-- Uncomment if you want to enforce max length.
-- ALTER TABLE public.flags
--   ADD CONSTRAINT flags_emoji_length_chk CHECK (emoji IS NULL OR char_length(emoji) <= 16);

-- Optional examples for updating emojis:
-- UPDATE public.flags SET emoji = '🥣' WHERE name = 'Cereals';
-- UPDATE public.flags SET emoji = '🥛' WHERE name = 'Milk';
-- UPDATE public.flags SET emoji = '🍔' WHERE name = 'Fast Food & Takeaway';
