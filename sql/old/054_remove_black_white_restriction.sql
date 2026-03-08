-- Remove "NEVER use black or white background" from prompt_generator
-- Allows agent to suggest black/white when it fits the style better

UPDATE agents
SET
  system_prompt = REPLACE(system_prompt, '. NEVER use black or white background.', '.'),
  few_shot_examples = (
    SELECT jsonb_agg(
      jsonb_build_object(
        'human', e->>'human',
        'ai', REPLACE(e->>'ai', 'NEVER use black or white. ', '')
      )
    )
    FROM jsonb_array_elements(few_shot_examples) e
  ),
  updated_at = now()
WHERE name = 'prompt_generator'
  AND (system_prompt LIKE '%NEVER use black or white%' OR few_shot_examples::text LIKE '%NEVER use black or white%');
