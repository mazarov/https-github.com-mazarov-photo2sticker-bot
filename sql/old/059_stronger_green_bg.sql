-- Strengthen green background requirement in all prompt templates
-- Move CRITICAL requirement to the END of prompts for better LLM adherence

UPDATE prompt_templates
SET template = 'Create a high-contrast messenger sticker.
Emotion: {input} — show this emotion clearly on the character''s face and body language.
The input image is an existing sticker. Change ONLY the emotion/expression — preserve the exact same style, colors, and ALL characters. If the input has one person, keep one. If it has multiple people (couple, group), keep ALL of them — only change their expressions.
Subject: Use the character(s) from the input sticker. If one person — change only that person''s expression. If multiple people — change ALL their expressions to the requested emotion while preserving their positions and style.
Composition: Character(s) occupy maximum canvas area, clear silhouette, bold uniform border (25–35% outline width).
Visual design: Preserve the input sticker''s style exactly. High contrast, strong edge separation.
Requirements: No watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.
CRITICAL REQUIREMENT: The background MUST be a solid uniform bright green color (#00FF00). Do NOT use any other background color regardless of the style. This is essential for automated background removal. The ENTIRE area behind the character(s) must be filled with exactly #00FF00 green — no gradients, no style-specific backgrounds, no dark colors.',
  updated_at = now()
WHERE id = 'emotion';

UPDATE prompt_templates
SET template = 'Create a high-contrast messenger sticker.
Action: {input} — show this pose/action clearly.
The input image is an existing sticker. Change ONLY the pose/action — preserve the exact same style, colors, and ALL characters. If the input has one person, keep one. If it has multiple people (couple, group), keep ALL of them — only change their poses together.
Subject: Use the character(s) from the input sticker. If one person — change only that person''s pose. If multiple people — change ALL their poses to the requested action while preserving their positions relative to each other.
Composition: Character(s) occupy maximum canvas area, clear silhouette, bold uniform border (25–35% outline width).
Visual design: Preserve the input sticker''s style exactly. High contrast, strong edge separation.
Requirements: No watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.
CRITICAL REQUIREMENT: The background MUST be a solid uniform bright green color (#00FF00). Do NOT use any other background color regardless of the style. This is essential for automated background removal. The ENTIRE area behind the character(s) must be filled with exactly #00FF00 green — no gradients, no style-specific backgrounds, no dark colors.',
  updated_at = now()
WHERE id = 'motion';

UPDATE prompt_templates
SET template = 'Create a high-contrast messenger sticker with text.
Text: "{input}" — add this text EXACTLY as written, do NOT translate or change it.
The input image is an existing sticker. Add text while preserving the exact same style, colors, and ALL characters.
Subject: Use the character(s) from the input sticker. Preserve all characters, positions, and style.
Text placement: Integrate naturally — on a sign, banner, speech bubble, or creatively placed within the image.
Composition: Character(s) occupy maximum canvas area, clear silhouette, bold uniform border (25–35% outline width).
Visual design: Preserve the input sticker''s style exactly. High contrast, strong edge separation. Text must be clearly readable.
Requirements: No watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.
CRITICAL REQUIREMENT: The background MUST be a solid uniform bright green color (#00FF00). Do NOT use any other background color regardless of the style. This is essential for automated background removal. The ENTIRE area behind the character(s) must be filled with exactly #00FF00 green — no gradients, no style-specific backgrounds, no dark colors.',
  updated_at = now()
WHERE id = 'text';
