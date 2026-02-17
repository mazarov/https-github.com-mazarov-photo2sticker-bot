# Обновление стилей и промпта v2

## Цель
Улучшить качество генерации стикеров за счёт:
1. Оптимизации промпта для лучшего вырезания фона
2. Обновления списка стилей (убрать неиспользуемые, добавить новые)

## Изменения

### 1. Новый список стилей

| # | ID | Emoji | Название RU | Name EN | prompt_hint |
|---|-----|-------|-------------|---------|-------------|
| 1 | simpsons | 📺 | Симпсоны | Simpsons | The Simpsons cartoon style, yellow skin, overbite, bold outlines, flat colors |
| 2 | anime | 🎌 | Аниме | Anime | anime style, clean lines, expressive eyes, detailed hair |
| 3 | animals | 🐾 | Звери как люди | Animals Like Humans | anthropomorphic animal style, animal with human expression and posture, expressive eyes |
| 4 | meme | 😂 | Мемы | Meme | internet meme style, exaggerated expression, reaction face |
| 5 | potter | ⚡ | Гарри Поттер | Harry Potter | Harry Potter wizard style, Hogwarts aesthetic, magical robes, wand, mystical aura |
| 6 | love | 💕 | История любви | Love Story | romantic illustration style, soft pink lighting, heart motifs, dreamy atmosphere |
| 7 | cute | 🥰 | Милый | Cute | cute kawaii style, soft pastel colors, rounded shapes |
| 8 | chibi | 🍡 | Чиби | Chibi | chibi style, big head, tiny body, adorable proportions |
| 9 | tv | 🎬 | Мультсериал | TV Cartoon | tv cartoon style, simplified shapes, flat colors, limited shading, clean outlines |

### 2. Скрытые стили (is_active = false)

- 3d
- pixel
- simpsons
- watercolor
- comic
- minimal
- flat
- text
- emoji
- sketch
- custom

### 3. Новый промпт-шаблон агента

```
Create a high-contrast messenger sticker.
Style: {style_hint}.
Character: Use the character from the provided photo as the base. Preserve recognizable facial features and overall likeness. Adapt proportions to match the style while keeping facial identity.
Composition: Character occupies maximum canvas area, clear silhouette, bold uniform border around the character (thick, approx 25–35% outline width), smooth and consistent outline.
Visual design: High contrast, strong edge separation, simplified shapes, no soft edges, color palette consistent with the selected style.
Requirements: Solid black background, no watermark, no logo, no frame, no text unless style requires it.
Quality: Optimized for clean background removal and messenger sticker use.
```

### 4. Ключевые изменения в промпте

| Было | Стало |
|------|-------|
| high-quality | high-contrast |
| Preserve proportions | Adapt proportions to match the style |
| flat/soft/cel-shaded shading | no soft edges, strong edge separation |
| black background | Solid black background |
| white border | bold uniform border (убрали "white") |
| no text unless explicitly requested | no text unless style requires it |
| Expressive, visually appealing | Optimized for clean background removal |

## Что НЕ затрагивается

- ✅ `emotion_presets` — без изменений
- ✅ `motion_presets` — без изменений
- ✅ `buildEmotionPrompt()` — без изменений
- ✅ `buildMotionPrompt()` — без изменений
- ✅ `buildTextPrompt()` — без изменений

## Реализация

### SQL миграция `sql/023_update_styles_and_prompt.sql`

```sql
-- 1. Деактивируем старые стили
UPDATE style_presets SET is_active = false;

-- 2. Вставляем/обновляем новые стили
INSERT INTO style_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order, is_active) VALUES
  ('simpsons', '📺', 'Симпсоны', 'Simpsons', 'The Simpsons cartoon style, yellow skin, overbite, bold outlines, flat colors', 1, true),
  ('anime', '🎌', 'Аниме', 'Anime', 'anime style, clean lines, expressive eyes, detailed hair', 2, true),
  ('animals', '🐾', 'Звери как люди', 'Animals Like Humans', 'anthropomorphic animal style, animal with human expression and posture, expressive eyes', 3, true),
  ('meme', '😂', 'Мемы', 'Meme', 'internet meme style, exaggerated expression, reaction face', 4, true),
  ('potter', '⚡', 'Гарри Поттер', 'Harry Potter', 'Harry Potter wizard style, Hogwarts aesthetic, magical robes, wand, mystical aura', 5, true),
  ('love', '💕', 'История любви', 'Love Story', 'romantic illustration style, soft pink lighting, heart motifs, dreamy atmosphere', 6, true),
  ('cute', '🥰', 'Милый', 'Cute', 'cute kawaii style, soft pastel colors, rounded shapes', 7, true),
  ('chibi', '🍡', 'Чиби', 'Chibi', 'chibi style, big head, tiny body, adorable proportions', 8, true),
  ('tv', '🎬', 'Мультсериал', 'TV Cartoon', 'tv cartoon style, simplified shapes, flat colors, limited shading, clean outlines', 9, true)
ON CONFLICT (id) DO UPDATE SET
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active;

-- 3. Обновляем system_prompt агента prompt_generator
UPDATE agents 
SET system_prompt = 'You are a prompt-generation agent.
Your task is to generate a single, ready-to-use image prompt for Gemini Flash to create a high-quality messenger sticker.

You do NOT generate images.
You ONLY generate the final image prompt for Gemini Flash.

## INPUT:
- user_text (style + idea + optional message)

## RULES OF INTERPRETATION:
- The visual style must be defined by the user''s text
- The generated prompt must instruct to preserve recognizable facial features while adapting proportions to match the style
- Do not invent a new character or significantly alter identity

## VALID INPUT:
User text is valid if it contains:
- a visual art style (anime, cartoon, comic, pixel art, 3D, chibi, etc.)
- and/or visual attributes (emotion, mood, accessories, colors)

Short inputs like "anime" or "cartoon" are valid.

## INVALID INPUT:
User text is invalid if:
- it contains no visual meaning
- it is abstract or meaningless (e.g. "make it nice", "any style", "you decide")

Do NOT invent a style if input is invalid.

## PROMPT TEMPLATE (use when input is valid):
Create a high-contrast messenger sticker.
Style: [describe the visual style from user text].
Character: Use the character from the provided photo as the base. Preserve recognizable facial features and overall likeness. Adapt proportions to match the style while keeping facial identity.
Composition: Character occupies maximum canvas area, clear silhouette, bold uniform border around the character (thick, approx 25–35% outline width), smooth and consistent outline.
Visual design: High contrast, strong edge separation, simplified shapes, no soft edges, color palette consistent with the selected style.
Requirements: Solid black background, no watermark, no logo, no frame, no text unless style requires it.
Quality: Optimized for clean background removal and messenger sticker use.

## OUTPUT FORMAT (STRICTLY ENFORCED):

If prompt CAN be created:
{"ok": true, "prompt": "...", "retry": false}

If prompt CANNOT be created (invalid input):
{"ok": false, "prompt": null, "retry": true}

## OUTPUT RULES:
- Exactly one JSON object
- No markdown, no extra text, no explanations
- prompt must be in English only
- All fields required',
    updated_at = now()
WHERE name = 'prompt_generator';
```

## Checklist

- [x] Создать миграцию `sql/023_update_styles_and_prompt.sql`
- [x] Применить миграцию в Supabase
- [ ] Очистить кеш стилей (перезапустить API)
- [ ] Тестирование новых стилей
- [ ] Проверить качество вырезания фона
