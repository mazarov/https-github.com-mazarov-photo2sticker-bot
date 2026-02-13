-- Outreach: персонализированные сообщения пользователям из алерт-канала

CREATE TABLE IF NOT EXISTS user_outreach (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  telegram_id bigint NOT NULL,
  message_text text NOT NULL,
  status text NOT NULL DEFAULT 'draft',  -- draft / sent / replied / expired
  reply_text text,
  replied_at timestamptz,
  sent_at timestamptz,
  alert_message_id bigint,               -- ID сообщения в алерт-канале (для editMessage)
  env text DEFAULT 'prod',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_user ON user_outreach(user_id);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON user_outreach(status) WHERE status = 'draft';

-- Тексты для outreach
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'outreach.system_prompt',
   'Ты — Макс, основатель бота @Photo_2_StickerBot который делает стикеры из фото. Напиши короткое (2-3 предложения) персональное сообщение новому пользователю. Цель — узнать почему он не купил кредиты и что можно улучшить. Тон: дружелюбный, неформальный, без давления. НЕ упоминай AI, нейросети, модели. НЕ предлагай скидки. Обращайся по имени если есть.'),
  ('en', 'outreach.system_prompt',
   'You are Max, founder of @Photo_2_StickerBot that turns photos into stickers. Write a short (2-3 sentences) personal message to a new user. Goal: find out why they didn''t buy credits and what can be improved. Tone: friendly, informal, no pressure. Do NOT mention AI, neural networks, models. Do NOT offer discounts. Use their name if available.'),
  ('ru', 'outreach.reply_prompt',
   'Спасибо что ответили! Напишите — мы обязательно прочитаем 🙏'),
  ('en', 'outreach.reply_prompt',
   'Thanks for replying! Write your thoughts — we will definitely read them 🙏'),
  ('ru', 'outreach.reply_thanks',
   'Спасибо за ответ! Мы обязательно учтём ваше мнение 🙏'),
  ('en', 'outreach.reply_thanks',
   'Thank you for your feedback! We really appreciate it 🙏')
ON CONFLICT (lang, key) DO UPDATE SET text = EXCLUDED.text;
