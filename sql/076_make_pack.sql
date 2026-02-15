-- 076_make_pack.sql
-- Feature: "Сделать пак" — sticker pack generation for credits

-- 1. New session states
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_pack_photo';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_pack_preview_payment';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'generating_pack_preview';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_pack_approval';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'processing_pack';

-- 2. Pack templates
CREATE TABLE IF NOT EXISTS pack_templates (
  id text PRIMARY KEY,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  description_ru text,
  description_en text,
  preview_file_id text,
  preview_url text,
  collage_file_id text,
  collage_url text,
  sticker_count int NOT NULL DEFAULT 4,
  labels jsonb NOT NULL,
  labels_en jsonb,
  scene_descriptions jsonb NOT NULL,
  style_prompt_base text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 3. Pack batches
CREATE TABLE IF NOT EXISTS pack_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id),
  user_id uuid NOT NULL REFERENCES users(id),
  template_id text NOT NULL REFERENCES pack_templates(id),
  size int NOT NULL,
  completed_count int DEFAULT 0,
  failed_count int DEFAULT 0,
  status text DEFAULT 'preview',
  credits_spent int DEFAULT 0,
  sticker_set_name text,
  env text DEFAULT 'prod',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pack_batches_user ON pack_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_pack_batches_status ON pack_batches(status);

-- 4. New columns in sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pack_template_id text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pack_batch_id uuid;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pack_sheet_file_id text;

-- 5. New column in jobs
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pack_batch_id uuid REFERENCES pack_batches(id);

-- 6. Pack columns in stickers
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS pack_batch_id uuid REFERENCES pack_batches(id);
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS pack_index int;

-- 7. deduct_credits RPC already exists in 030_atomic_credit_deduction.sql

-- 8. Seed: first template (test — 4 stickers)
INSERT INTO pack_templates (
  id, name_ru, name_en, description_ru, description_en,
  sticker_count,
  labels, labels_en, scene_descriptions,
  style_prompt_base, sort_order
) VALUES (
  'couple_v1',
  'Пара',
  'Couple',
  'Уникальные телеграм стикеры для вашей пары 💖',
  'Unique Telegram stickers for your couple 💖',
  4,
  '["Моя 💕", "Люблю 😘", "Спим? 😴", "Вкусно? 🍕"]'::jsonb,
  '["Mine 💕", "Love 😘", "Sleep? 😴", "Yummy? 🍕"]'::jsonb,
  '["romantic, hugging tenderly", "blowing a kiss, hearts flying around", "sleeping together, cozy and peaceful", "eating pizza together, happy and playful"]'::jsonb,
  'Cute couple sticker in cartoon style. The character(s) should be recognizable from the reference photo. White outline around the character. Clean, expressive, suitable for Telegram sticker pack.',
  1
) ON CONFLICT (id) DO NOTHING;
