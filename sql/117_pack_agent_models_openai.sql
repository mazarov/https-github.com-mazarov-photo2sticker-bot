-- Pack agents: Concept/Boss/Captions gpt-4.1, Scenes gpt-4.1-vision, Critic gpt-3.5-turbo
INSERT INTO app_config (key, value, description) VALUES
  ('pack_openai_model_concept',  'gpt-4.1', 'Pack pipeline: Concept agent'),
  ('pack_openai_model_boss',     'gpt-4.1', 'Pack pipeline: Boss planner'),
  ('pack_openai_model_captions', 'gpt-4.1', 'Pack pipeline: Captions writer'),
  ('pack_openai_model_scenes',   'gpt-4.1', 'Pack pipeline: Scenes writer'),
  ('pack_openai_model_critic',   'gpt-3.5-turbo', 'Pack pipeline: Critic quality gate')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  updated_at = now();
