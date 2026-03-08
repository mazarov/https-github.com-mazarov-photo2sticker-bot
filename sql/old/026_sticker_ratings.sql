-- Таблица для оценок стикеров
CREATE TABLE IF NOT EXISTS sticker_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sticker_id uuid REFERENCES stickers(id),
  session_id uuid REFERENCES sessions(id),
  user_id uuid REFERENCES users(id),
  telegram_id bigint NOT NULL,
  
  -- Параметры генерации
  generation_type text,
  style_id text,
  emotion_id text,
  prompt_final text,
  
  -- Оценка
  rating smallint CHECK (rating >= 1 AND rating <= 5),
  rated_at timestamptz,
  
  -- Метаданные
  message_id bigint,
  chat_id bigint,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ratings_user ON sticker_ratings(user_id);
CREATE INDEX IF NOT EXISTS idx_ratings_style ON sticker_ratings(style_id) WHERE style_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ratings_pending ON sticker_ratings(user_id) WHERE rating IS NULL;

-- Таблица для жалоб/предложений по стикерам
CREATE TABLE IF NOT EXISTS sticker_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sticker_id uuid REFERENCES stickers(id),
  telegram_id bigint NOT NULL,
  username text,
  issue_text text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_issues_sticker ON sticker_issues(sticker_id);
