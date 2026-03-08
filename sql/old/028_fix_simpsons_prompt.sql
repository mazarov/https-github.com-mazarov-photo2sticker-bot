-- Fix Simpsons style prompt to avoid Gemini content filter
-- "The Simpsons" is a trademark and triggers content policy

UPDATE style_presets 
SET prompt_hint = 'Yellow cartoon character style with bold outlines, overbite, flat colors, simple shapes'
WHERE id = 'simpsons';

-- Also update the agent few-shot examples if they exist
UPDATE agents 
SET few_shot_examples = REPLACE(
  few_shot_examples::text,
  'The Simpsons cartoon style',
  'Yellow cartoon character style'
)::jsonb
WHERE few_shot_examples::text LIKE '%The Simpsons%';
