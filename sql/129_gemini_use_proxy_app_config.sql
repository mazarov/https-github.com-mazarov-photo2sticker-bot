-- Runtime switch for Gemini transport route:
-- true  -> use configured proxy base URL (GEMINI_PROXY_BASE_URL)
-- false -> call Google Gemini API directly
INSERT INTO app_config (key, value, description)
VALUES (
  'gemini_use_proxy',
  'true',
  'Use Gemini proxy route when true; call direct Google API when false'
)
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    updated_at = now();
