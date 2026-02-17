# Prompt Templates — вынос промптов в базу данных

## Цель
Перенести промпты для emotion/motion/text из кода в базу данных для гибкого обновления без редеплоя.

## Текущее состояние

| Тип | Где хранится | Проблема |
|-----|--------------|----------|
| Style | БД (`agents.system_prompt`) | ✅ Гибко |
| Emotion | Код (`buildEmotionPrompt`) | ❌ Требует редеплой |
| Motion | Код (`buildMotionPrompt`) | ❌ Требует редеплой |
| Text | Код (`buildTextPrompt`) | ❌ Требует редеплой |

## Решение

### Новая таблица `prompt_templates`

```sql
CREATE TABLE prompt_templates (
  id text PRIMARY KEY,
  template text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

### Шаблоны промптов

**emotion:**
```
Create a high-contrast messenger sticker.
Emotion: {input} — show this emotion clearly on the character's face and body language.
Character: ISOLATE and extract ONLY the main subject (person, animal, character) from the photo. Ignore all background elements, furniture, surroundings, and environmental context. Preserve recognizable facial features, style, and colors.
Composition: Character occupies maximum canvas area, clear silhouette, bold uniform border around the character (thick, approx 25–35% outline width), smooth and consistent outline.
Visual design: High contrast, strong edge separation, simplified shapes, no soft edges.
Requirements: Solid black background, no watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.
```

**motion:**
```
Create a high-contrast messenger sticker.
Action: {input} — show this pose/action clearly.
Character: ISOLATE and extract ONLY the main subject (person, animal, character) from the photo. Ignore all background elements, furniture, surroundings, and environmental context. Preserve recognizable facial features, style, and colors.
Composition: Character occupies maximum canvas area, clear silhouette, bold uniform border around the character (thick, approx 25–35% outline width), smooth and consistent outline.
Visual design: High contrast, strong edge separation, simplified shapes, no soft edges.
Requirements: Solid black background, no watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.
```

**text:**
```
Create a high-contrast messenger sticker with text.
Text: "{input}" — add this text EXACTLY as written, do NOT translate or change it.
Character: ISOLATE and extract ONLY the main subject (person, animal, character) from the photo. Ignore all background elements, furniture, surroundings, and environmental context. Preserve recognizable facial features, style, and colors.
Text placement: Integrate naturally — on a sign, banner, speech bubble, or creatively placed within the image.
Composition: Character occupies maximum canvas area, clear silhouette, bold uniform border around the character (thick, approx 25–35% outline width), smooth and consistent outline.
Visual design: High contrast, strong edge separation, simplified shapes, no soft edges. Text must be clearly readable.
Requirements: Solid black background, no watermark, no logo, no frame.
Quality: Optimized for clean background removal and messenger sticker use.
```

## Ключевые улучшения

1. **Изоляция персонажа** — явная инструкция игнорировать фон (решает проблему со стиральной машиной)
2. **Единый формат** — все промпты структурированы одинаково
3. **Гибкость** — можно менять через SQL без редеплоя

## Реализация

### SQL миграция `sql/025_prompt_templates.sql`

```sql
CREATE TABLE IF NOT EXISTS prompt_templates (
  id text PRIMARY KEY,
  template text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

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
```

### Код `src/index.ts`

```typescript
// Кеш для prompt_templates
let promptTemplatesCache: { data: Map<string, string>; timestamp: number } | null = null;
const PROMPT_TEMPLATES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getPromptTemplate(id: string): Promise<string> {
  const now = Date.now();
  
  if (promptTemplatesCache && now - promptTemplatesCache.timestamp < PROMPT_TEMPLATES_CACHE_TTL) {
    return promptTemplatesCache.data.get(id) || "";
  }
  
  const { data } = await supabase
    .from("prompt_templates")
    .select("id, template");
  
  if (data) {
    const map = new Map<string, string>();
    for (const row of data) {
      map.set(row.id, row.template);
    }
    promptTemplatesCache = { data: map, timestamp: now };
    return map.get(id) || "";
  }
  
  return "";
}

function buildPromptFromTemplate(template: string, input: string): string {
  return template.replace(/{input}/g, input);
}

// Заменяем старые функции:
// buildEmotionPrompt(text) → buildPromptFromTemplate(await getPromptTemplate('emotion'), text)
// buildMotionPrompt(text) → buildPromptFromTemplate(await getPromptTemplate('motion'), text)
// buildTextPrompt(text) → buildPromptFromTemplate(await getPromptTemplate('text'), text)
```

## Также обновить prompt_generator

Добавить инструкцию изоляции персонажа в агент `prompt_generator`:

```sql
UPDATE agents
SET system_prompt = REPLACE(
  system_prompt,
  'Character: Use the character from the provided photo as the base. Preserve recognizable facial features and overall likeness.',
  'Character: ISOLATE and extract ONLY the main subject (person, animal, character) from the provided photo. Ignore all background elements, furniture, surroundings, and environmental context. Preserve recognizable facial features and overall likeness.'
)
WHERE name = 'prompt_generator';
```

## Checklist

- [x] Создать миграцию `sql/025_prompt_templates.sql`
- [x] Применить миграцию в Supabase
- [x] Обновить `src/index.ts` — добавить `getPromptTemplate`, `buildPromptFromTemplate`
- [x] Удалить старые функции `buildEmotionPrompt`, `buildMotionPrompt`, `buildTextPrompt`
- [x] Обновить `prompt_generator` agent (изоляция персонажа) — в миграции
- [ ] Редеплой API
- [ ] Тестирование
