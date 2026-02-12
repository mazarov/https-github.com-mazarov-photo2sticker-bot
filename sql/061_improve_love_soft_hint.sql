-- Improve ALL love style hints:
-- 1. Add STYLE OVERRIDE for soft/romantic styles (no bold border, softer visual)
-- 2. Fix love_couple: add fallback for single person photos
-- 3. Better descriptions for Gemini image generation

-- love_soft: watercolor style — needs soft edges, no bold border
UPDATE style_presets_v2
SET prompt_hint = 'Soft romantic watercolor sticker style. Delicate brushstrokes with visible watercolor bleeding and soft edges. Warm pastel palette: blush pink, peach, lavender, soft coral. Gentle dreamy expression with soft smile. Subtle warm backlight glow. Skin tones soft and peachy. Hair flowing and delicate. No floating hearts, no decorations, no background elements. STYLE OVERRIDE: No bold border — use thin delicate outline or no outline. Soft edges, gentle blending, low contrast. No sharp outlines, no strong edge separation.'
WHERE id = 'love_soft';

-- love_couple: romantic pair OR single person with romantic vibe
UPDATE style_presets_v2
SET prompt_hint = 'Romantic couple illustration style, warm pink tones, sweet loving atmosphere. If TWO people in photo — draw both close together, preserving positions and interaction. If ONE person — draw them in a romantic pose with dreamy loving expression, as if thinking about someone. Soft warm lighting, gentle smiles. Clean composition. STYLE OVERRIDE: Use medium outline (not bold 25-35%), softer edges, warm color palette. No harsh contrast.'
WHERE id = 'love_couple';

-- love_heart: romantic with heart accents — works for any number of people
UPDATE style_presets_v2
SET prompt_hint = 'Romantic sticker style with heart accents. Pink and red warm palette, sweet cheerful expression. Small hearts as part of clothing pattern, accessories, or hair clips — NOT floating in the air. Clean composition, no background clutter. STYLE OVERRIDE: Use medium outline, warm soft contrast. No harsh edge separation.'
WHERE id = 'love_heart';

-- love_passion: dramatic romantic — works for any number of people
UPDATE style_presets_v2
SET prompt_hint = 'Passionate romantic illustration style. Intense loving expression, confident pose. Rich deep color palette: crimson red, burgundy, warm gold. Dramatic warm lighting with soft shadows. If TWO people — draw them in an intimate close pose. If ONE person — draw them with passionate confident expression, slight smirk. Detailed rendering, expressive eyes. STYLE OVERRIDE: Use medium-bold outline, rich saturated colors. Keep some contrast but softer than cartoon style.'
WHERE id = 'love_passion';
