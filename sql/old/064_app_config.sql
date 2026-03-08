-- App config: key-value settings changeable at runtime (no redeploy needed)
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Gemini model per generation type
INSERT INTO app_config (key, value, description) VALUES
  ('gemini_model_style',   'gemini-3-pro-image-preview', 'Модель для генерации стикера из фото (style)'),
  ('gemini_model_emotion', 'gemini-2.5-flash-image',     'Модель для изменения эмоции (emotion)'),
  ('gemini_model_motion',  'gemini-2.5-flash-image',     'Модель для изменения движения (motion)')
ON CONFLICT (key) DO NOTHING;
