-- Feature flag for replace_subject pipeline via Facemint API.
-- Default is disabled to allow safe rollout.

INSERT INTO app_config (key, value, description) VALUES
  (
    'facemint_replace_face_enabled',
    'false',
    'Enable Facemint API for replace_subject flow instead of Gemini'
  )
ON CONFLICT (key) DO NOTHING;
