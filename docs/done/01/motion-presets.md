# Изменить движение — Требования

## Цель

Добавить инлайн-кнопку "Изменить движение" для изменения позы/жеста/действия стикера. Логика аналогична "Изменить эмоцию".

---

## UI

### Кнопки после генерации стикера

```
[Стикер]

[➕ Добавить в пак]
[🎨 Изменить стиль] [😊 Изменить эмоцию]
[🏃 Изменить движение]
```

### Меню выбора движения

```
🏃 Выберите движение:

[👋 Машет рукой]  [👍 Класс]
[🤦 Фейспалм]    [🙏 Молится]
[💪 Сила]        [🏃 Бежит]
[💃 Танцует]     [🤷 Пожимает плечами]
[✌️ Мир]        [🫶 Сердечко]
[🙈 Закрывает глаза]  [🎉 Празднует]
[✍️ Своё движение]
```

---

## Список движений (12 + custom)

| id | emoji | name_ru | name_en | prompt_hint | sort_order |
|----|-------|---------|---------|-------------|------------|
| waving | 👋 | Машет рукой | Waving | waving hand, greeting gesture, friendly wave | 1 |
| thumbs_up | 👍 | Показывает класс | Thumbs up | thumbs up gesture, approval, like sign | 2 |
| facepalm | 🤦 | Фейспалм | Facepalm | facepalm gesture, hand on face, frustrated | 3 |
| praying | 🙏 | Молится | Praying | hands together, praying or pleading gesture | 4 |
| flexing | 💪 | Показывает силу | Flexing | flexing arm, showing bicep, strong pose | 5 |
| running | 🏃 | Бежит | Running | running pose, dynamic movement, legs in motion | 6 |
| dancing | 💃 | Танцует | Dancing | dancing pose, joyful movement, party dance | 7 |
| shrugging | 🤷 | Пожимает плечами | Shrugging | shrugging shoulders, palms up, uncertain | 8 |
| peace | ✌️ | Знак мира | Peace sign | peace sign gesture, two fingers up, victory | 9 |
| heart_hands | 🫶 | Сердечко руками | Heart hands | hands forming heart shape, love gesture | 10 |
| covering_eyes | 🙈 | Закрывает глаза | Covering eyes | hands covering eyes, shy, peek-a-boo | 11 |
| celebrating | 🎉 | Празднует | Celebrating | celebrating pose, arms up, party, cheering | 12 |
| custom | ✍️ | Своё движение | Custom pose | (user input) | 13 |

---

## Логика генерации

1. Берём текущий стикер (`last_sticker_file_id`) как базу
2. Формируем промпт: `Update the sticker to show this pose/action: {motion_text}. Keep the same character, style, and colors.`
3. Отправляем в Gemini
4. Результат — новый стикер

---

## БД: таблица `motion_presets`

```sql
CREATE TABLE IF NOT EXISTS motion_presets (
  id text PRIMARY KEY,
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  prompt_hint text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true
);

CREATE INDEX IF NOT EXISTS motion_presets_active_idx ON motion_presets (is_active, sort_order);

INSERT INTO motion_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('waving', '👋', 'Машет рукой', 'Waving', 'waving hand, greeting gesture, friendly wave', 1),
  ('thumbs_up', '👍', 'Показывает класс', 'Thumbs up', 'thumbs up gesture, approval, like sign', 2),
  ('facepalm', '🤦', 'Фейспалм', 'Facepalm', 'facepalm gesture, hand on face, frustrated', 3),
  ('praying', '🙏', 'Молится', 'Praying', 'hands together, praying or pleading gesture', 4),
  ('flexing', '💪', 'Показывает силу', 'Flexing', 'flexing arm, showing bicep, strong pose', 5),
  ('running', '🏃', 'Бежит', 'Running', 'running pose, dynamic movement, legs in motion', 6),
  ('dancing', '💃', 'Танцует', 'Dancing', 'dancing pose, joyful movement, party dance', 7),
  ('shrugging', '🤷', 'Пожимает плечами', 'Shrugging', 'shrugging shoulders, palms up, uncertain', 8),
  ('peace', '✌️', 'Знак мира', 'Peace sign', 'peace sign gesture, two fingers up, victory', 9),
  ('heart_hands', '🫶', 'Сердечко руками', 'Heart hands', 'hands forming heart shape, love gesture', 10),
  ('covering_eyes', '🙈', 'Закрывает глаза', 'Covering eyes', 'hands covering eyes, shy, peek-a-boo', 11),
  ('celebrating', '🎉', 'Празднует', 'Celebrating', 'celebrating pose, arms up, party, cheering', 12),
  ('custom', '✍️', 'Своё движение', 'Custom pose', '', 13)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  emoji = EXCLUDED.emoji,
  sort_order = EXCLUDED.sort_order;
```

---

## Изменения в sessions

Добавить состояния:
- `wait_motion` — ждём выбор движения
- `wait_custom_motion` — ждём текст своего движения

Добавить поля:
```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS selected_motion text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS motion_prompt text;
```

---

## Локализация

```sql
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'btn.change_motion', '🏃 Изменить движение'),
  ('en', 'btn.change_motion', '🏃 Change pose'),
  ('ru', 'motion.choose', '🏃 Выберите движение:'),
  ('en', 'motion.choose', '🏃 Choose a pose:'),
  ('ru', 'motion.custom_prompt', '✍️ Опишите желаемое движение или позу:'),
  ('en', 'motion.custom_prompt', '✍️ Describe the desired pose or action:')
ON CONFLICT (key, lang) DO UPDATE SET text = EXCLUDED.text;
```

---

## Изменения в коде

### worker.ts

Добавить `generation_type: "motion"`:

```typescript
const generationType = session.generation_type || 
  (session.state === "processing_emotion" ? "emotion" : 
   session.state === "processing_motion" ? "motion" : "style");
```

### index.ts

1. **Кнопка в replyMarkup** — добавить `change_motion:${stickerId}`

2. **Обработчик `change_motion:ID`** — аналогично `change_emotion:ID`

3. **Обработчик `motion_*`** — выбор движения из пресетов

4. **Обработчик текста в `wait_custom_motion`** — своё движение

5. **Функция `buildMotionPrompt`**:
```typescript
function buildMotionPrompt(motionText: string) {
  return `Update the sticker to show this pose/action: ${motionText}. Keep the same character, style, and colors.`;
}
```

6. **Функция `sendMotionKeyboard`** — показать клавиатуру с движениями

---

## SQL миграция

```sql
-- 016_motion_presets.sql

-- Таблица пресетов движений
CREATE TABLE IF NOT EXISTS motion_presets (
  id text PRIMARY KEY,
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  prompt_hint text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true
);

CREATE INDEX IF NOT EXISTS motion_presets_active_idx ON motion_presets (is_active, sort_order);

INSERT INTO motion_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('waving', '👋', 'Машет рукой', 'Waving', 'waving hand, greeting gesture, friendly wave', 1),
  ('thumbs_up', '👍', 'Показывает класс', 'Thumbs up', 'thumbs up gesture, approval, like sign', 2),
  ('facepalm', '🤦', 'Фейспалм', 'Facepalm', 'facepalm gesture, hand on face, frustrated', 3),
  ('praying', '🙏', 'Молится', 'Praying', 'hands together, praying or pleading gesture', 4),
  ('flexing', '💪', 'Показывает силу', 'Flexing', 'flexing arm, showing bicep, strong pose', 5),
  ('running', '🏃', 'Бежит', 'Running', 'running pose, dynamic movement, legs in motion', 6),
  ('dancing', '💃', 'Танцует', 'Dancing', 'dancing pose, joyful movement, party dance', 7),
  ('shrugging', '🤷', 'Пожимает плечами', 'Shrugging', 'shrugging shoulders, palms up, uncertain', 8),
  ('peace', '✌️', 'Знак мира', 'Peace sign', 'peace sign gesture, two fingers up, victory', 9),
  ('heart_hands', '🫶', 'Сердечко руками', 'Heart hands', 'hands forming heart shape, love gesture', 10),
  ('covering_eyes', '🙈', 'Закрывает глаза', 'Covering eyes', 'hands covering eyes, shy, peek-a-boo', 11),
  ('celebrating', '🎉', 'Празднует', 'Celebrating', 'celebrating pose, arms up, party, cheering', 12),
  ('custom', '✍️', 'Своё движение', 'Custom pose', '', 13)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  emoji = EXCLUDED.emoji,
  sort_order = EXCLUDED.sort_order;

-- Поля в sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS selected_motion text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS motion_prompt text;

-- Локализация
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'btn.change_motion', '🏃 Изменить движение'),
  ('en', 'btn.change_motion', '🏃 Change pose'),
  ('ru', 'motion.choose', '🏃 Выберите движение:'),
  ('en', 'motion.choose', '🏃 Choose a pose:'),
  ('ru', 'motion.custom_prompt', '✍️ Опишите желаемое движение или позу:'),
  ('en', 'motion.custom_prompt', '✍️ Describe the desired pose or action:')
ON CONFLICT (key, lang) DO UPDATE SET text = EXCLUDED.text;
```

---

## Чеклист

- [ ] SQL миграция `016_motion_presets.sql`
- [ ] index.ts: кэш и функция `getMotionPresets()`
- [ ] index.ts: функция `sendMotionKeyboard()`
- [ ] index.ts: функция `buildMotionPrompt()`
- [ ] index.ts: обработчик `change_motion:ID`
- [ ] index.ts: обработчики `motion_*` callbacks
- [ ] index.ts: обработчик текста в `wait_custom_motion`
- [ ] worker.ts: добавить кнопку `change_motion` в replyMarkup
- [ ] worker.ts: поддержка `generation_type: "motion"`
- [ ] Тестирование всех движений
- [ ] Проверка локализации ru/en
