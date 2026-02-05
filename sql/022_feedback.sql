-- Поле для триггера в users
ALTER TABLE users ADD COLUMN IF NOT EXISTS feedback_trigger_at timestamptz;

-- Таблица feedback
CREATE TABLE IF NOT EXISTS user_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) UNIQUE,
  telegram_id bigint NOT NULL,
  username text,
  question_sent_at timestamptz DEFAULT now(),
  answer_text text,
  answer_at timestamptz,
  admin_reply_text text,
  admin_reply_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Индекс для cron-запроса
CREATE INDEX IF NOT EXISTS users_feedback_trigger_idx 
  ON users(feedback_trigger_at) 
  WHERE feedback_trigger_at IS NOT NULL;
