-- Универсальная таблица триггеров уведомлений
CREATE TABLE IF NOT EXISTS notification_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  telegram_id bigint NOT NULL,
  trigger_type text NOT NULL,  -- 'feedback_zero_credits', 'inactive_7d', etc.
  trigger_at timestamptz DEFAULT now(),
  fire_after timestamptz NOT NULL,  -- когда отправить (trigger_at + delay)
  fired_at timestamptz,  -- когда реально отправили
  status text DEFAULT 'pending',  -- pending, fired, cancelled
  metadata jsonb,  -- доп. данные
  created_at timestamptz DEFAULT now()
);

-- Индекс для cron-запроса pending триггеров
CREATE INDEX IF NOT EXISTS idx_triggers_pending 
ON notification_triggers(fire_after) 
WHERE status = 'pending';

-- Уникальность: один pending триггер на пользователя и тип
CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_unique_pending
ON notification_triggers(user_id, trigger_type)
WHERE status = 'pending';

-- Удаляем старую колонку из users (если есть данные — они уже не нужны)
ALTER TABLE users DROP COLUMN IF EXISTS feedback_trigger_at;
