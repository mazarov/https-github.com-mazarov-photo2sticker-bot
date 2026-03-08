-- Pack pipeline: Brief & Plan agent (Concept + Boss merged). Add app_config key.
-- Run after 117. Set value to the same model you used for concept/boss (e.g. gpt-5-mini).
INSERT INTO app_config (key, value, description) VALUES
  ('pack_openai_model_brief_and_plan', 'gpt-5-mini', 'Pack pipeline: Brief & Plan (concept + plan in one call)')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  updated_at = now();
