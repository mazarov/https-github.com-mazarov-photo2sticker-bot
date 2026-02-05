-- Таблица шаблонов промптов
CREATE TABLE IF NOT EXISTS prompt_templates (
  id text PRIMARY KEY,
  template text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Вставляем шаблоны промптов
INSERT INTO prompt_templates (id, template, description) VALUES
('emotion', 'Create a high-contrast messenger sticker.
Emotion: {input} — show this emotion clearly on the character''s face and body language.
Character: ISOLATE and extract ONLY the main subject (person, animal, character) from the photo. Ignore all background elements, furniture, surroundings, and environmental context. Preserve recognizable facial features, style, and colors.
Composition: Character occupies maximum canvas area, clear silhouette, bold uniform border around the character (thick, approx 25–35% outline width), smooth and consistent outline.
Visual design: High contrast, strong edge separation, simplified shapes, no soft edges.
Requirements: Solid black background, no watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.', 'Prompt template for emotion generation'),

('motion', 'Create a high-contrast messenger sticker.
Action: {input} — show this pose/action clearly.
Character: ISOLATE and extract ONLY the main subject (person, animal, character) from the photo. Ignore all background elements, furniture, surroundings, and environmental context. Preserve recognizable facial features, style, and colors.
Composition: Character occupies maximum canvas area, clear silhouette, bold uniform border around the character (thick, approx 25–35% outline width), smooth and consistent outline.
Visual design: High contrast, strong edge separation, simplified shapes, no soft edges.
Requirements: Solid black background, no watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.', 'Prompt template for motion/pose generation'),

('text', 'Create a high-contrast messenger sticker with text.
Text: "{input}" — add this text EXACTLY as written, do NOT translate or change it.
Character: ISOLATE and extract ONLY the main subject (person, animal, character) from the photo. Ignore all background elements, furniture, surroundings, and environmental context. Preserve recognizable facial features, style, and colors.
Text placement: Integrate naturally — on a sign, banner, speech bubble, or creatively placed within the image.
Composition: Character occupies maximum canvas area, clear silhouette, bold uniform border around the character (thick, approx 25–35% outline width), smooth and consistent outline.
Visual design: High contrast, strong edge separation, simplified shapes, no soft edges. Text must be clearly readable.
Requirements: Solid black background, no watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.', 'Prompt template for text overlay generation')
ON CONFLICT (id) DO UPDATE SET
  template = EXCLUDED.template,
  description = EXCLUDED.description,
  updated_at = now();

-- Обновляем prompt_generator agent — добавляем изоляцию персонажа
UPDATE agents
SET system_prompt = REPLACE(
  system_prompt,
  'Character: Use the character from the provided photo as the base. Preserve recognizable facial features and overall likeness.',
  'Character: ISOLATE and extract ONLY the main subject (person, animal, character) from the provided photo. Ignore all background elements, furniture, surroundings, and environmental context. Preserve recognizable facial features and overall likeness.'
),
updated_at = now()
WHERE name = 'prompt_generator';
