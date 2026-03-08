-- Update emotion and motion templates: preserve couples/groups, clarify input is sticker
-- Fix: "ONLY the main subject" caused loss of second person when changing emotion or motion

UPDATE prompt_templates
SET template = 'Create a high-contrast messenger sticker.
Emotion: {input} — show this emotion clearly on the character''s face and body language.
The input image is an existing sticker. Change ONLY the emotion/expression — preserve the exact same style, colors, and ALL characters. If the input has one person, keep one. If it has multiple people (couple, group), keep ALL of them — only change their expressions.
Subject: Use the character(s) from the input sticker. If one person — change only that person''s expression. If multiple people — change ALL their expressions to the requested emotion while preserving their positions and style.
Composition: Character(s) occupy maximum canvas area, clear silhouette, bold uniform border (25–35% outline width).
Visual design: Preserve the input sticker''s style exactly. High contrast, strong edge separation.
Background: Solid bright green (#00FF00) for clean background removal.
Requirements: No watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.',
  description = 'Prompt template for emotion generation (sticker-to-sticker, preserves couples)',
  updated_at = now()
WHERE id = 'emotion';

UPDATE prompt_templates
SET template = 'Create a high-contrast messenger sticker.
Action: {input} — show this pose/action clearly.
The input image is an existing sticker. Change ONLY the pose/action — preserve the exact same style, colors, and ALL characters. If the input has one person, keep one. If it has multiple people (couple, group), keep ALL of them — only change their poses together.
Subject: Use the character(s) from the input sticker. If one person — change only that person''s pose. If multiple people — change ALL their poses to the requested action while preserving their positions relative to each other.
Composition: Character(s) occupy maximum canvas area, clear silhouette, bold uniform border (25–35% outline width).
Visual design: Preserve the input sticker''s style exactly. High contrast, strong edge separation.
Background: Solid bright green (#00FF00) for clean background removal.
Requirements: No watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.',
  description = 'Prompt template for motion/pose generation (sticker-to-sticker, preserves couples)',
  updated_at = now()
WHERE id = 'motion';
