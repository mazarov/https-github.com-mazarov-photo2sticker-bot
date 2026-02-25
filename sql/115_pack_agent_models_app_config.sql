-- Pack multi-agent pipeline: default models in app_config (Concept/Scenes → gpt-5.2, Boss/Captions/Critic → gpt-4.1)
INSERT INTO app_config (key, value, description) VALUES
  ('pack_openai_model_concept',  'gpt-5.2', 'Pack pipeline: Concept agent'),
  ('pack_openai_model_boss',     'gpt-4.1', 'Pack pipeline: Boss planner'),
  ('pack_openai_model_captions', 'gpt-4.1', 'Pack pipeline: Captions writer'),
  ('pack_openai_model_scenes',   'gpt-5.2', 'Pack pipeline: Scenes writer'),
  ('pack_openai_model_critic',   'gpt-4.1', 'Pack pipeline: Critic quality gate')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  updated_at = now();
