-- Update text template: chroma-key background + smart subject extraction (consistent with emotion/motion from 055)
UPDATE prompt_templates
SET template = 'Create a high-quality messenger sticker with text.
Text: "{input}" — add this text EXACTLY as written, do NOT translate or change it.
The input image is an existing sticker. Add text while preserving the exact same style, colors, and ALL characters. If the input has one person, keep one. If it has multiple people (couple, group), keep ALL of them.
Subject: Use the character(s) from the input sticker. Preserve their style, positions, and expressions.
Text placement: Integrate naturally — on a sign, banner, speech bubble, or creatively placed within the image. Text must be clearly readable.
Composition: Character(s) occupy maximum canvas area, clear silhouette, bold uniform border (25–35% outline width).
Visual design: Preserve the input sticker''s style exactly. High contrast, strong edge separation.
Background: Solid bright green (#00FF00) for clean background removal. NEVER use black or white.
Requirements: No watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.',
  description = 'Prompt template for text overlay generation (sticker-to-sticker, preserves couples)',
  updated_at = now()
WHERE id = 'text';
