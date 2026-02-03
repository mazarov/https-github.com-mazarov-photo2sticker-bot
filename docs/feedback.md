# Сбор фидбека — Требования

## Цель

Собирать обратную связь от пользователей для улучшения бота:
- Качество генерации
- Удобство использования
- Идеи и предложения
- Баги и проблемы

---

## Триггеры

| Триггер | Условие |
|---------|---------|
| `/feedback` | Команда, всегда доступна |
| Авто | 2 часа после последнего взаимодействия, не чаще 1 раз в 7 дней |

---

## Флоу

### Шаг 1 — Выбор категории

```
🗣 Расскажите, что вам понравилось или что можно улучшить?

[🎨 Качество стикеров]  [⚡ Скорость]
[🖌 Стили]  [🎯 Удобство]
[💬 Другое]

Или просто напишите своими словами 👇
```

### Шаг 2 — Ввод текста

После выбора категории ИЛИ если пользователь сразу пишет текст:

```
✍️ Напишите ваш отзыв:
```

### Шаг 3 — Подтверждение

```
Спасибо за отзыв! 🙏 Он поможет сделать бота лучше.
```

---

## БД: таблица `feedback`

```sql
CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  category text,           -- 'quality'|'speed'|'styles'|'ux'|'other'|null
  text text NOT NULL,
  trigger text NOT NULL,   -- 'command'|'auto'
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_feedback_user_id ON feedback(user_id);
CREATE INDEX idx_feedback_created_at ON feedback(created_at);
```

---

## БД: таблица `feedback_categories`

Редактируемые категории:

```sql
CREATE TABLE feedback_categories (
  id text PRIMARY KEY,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  emoji text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true
);

INSERT INTO feedback_categories (id, name_ru, name_en, emoji, sort_order) VALUES
  ('quality', 'Качество стикеров', 'Sticker quality', '🎨', 1),
  ('speed', 'Скорость', 'Speed', '⚡', 2),
  ('styles', 'Стили', 'Styles', '🖌', 3),
  ('ux', 'Удобство', 'Usability', '🎯', 4),
  ('other', 'Другое', 'Other', '💬', 5);
```

---

## БД: поля в `users`

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_interaction_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_feedback_request_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_feedback_at timestamptz;
```

---

## Логика авто-запроса

### Условия отправки

```
ЕСЛИ:
  now() - last_interaction_at >= 2 часа
  И (last_feedback_request_at IS NULL ИЛИ now() - last_feedback_request_at >= 7 дней)
  И user активен (не заблокировал бота)
ТО:
  Отправить запрос фидбека
  Обновить last_feedback_request_at = now()
```

### SQL запрос для выборки

```sql
SELECT id, telegram_id, lang
FROM users
WHERE last_interaction_at IS NOT NULL
  AND last_interaction_at < NOW() - INTERVAL '2 hours'
  AND (last_feedback_request_at IS NULL OR last_feedback_request_at < NOW() - INTERVAL '7 days')
LIMIT 100;
```

### Реализация

Отдельный cron-job или worker, который:
1. Раз в 30 минут проверяет пользователей по условиям
2. Отправляет запрос фидбека
3. Обновляет `last_feedback_request_at`
4. Обрабатывает ошибки (бот заблокирован и т.д.)

---

## Локализация

### bot_texts_new

| key | ru | en |
|-----|----|----|
| feedback.ask | 🗣 Расскажите, что вам понравилось или что можно улучшить? | 🗣 Tell us what you liked or what can be improved? |
| feedback.hint | Или просто напишите своими словами 👇 | Or just write in your own words 👇 |
| feedback.write | ✍️ Напишите ваш отзыв: | ✍️ Write your feedback: |
| feedback.thanks | Спасибо за отзыв! 🙏 Он поможет сделать бота лучше. | Thanks for your feedback! 🙏 It will help make the bot better. |

---

## Изменения в коде

### index.ts

1. **Команда `/feedback`**
   - Показать клавиатуру с категориями
   - Установить состояние сессии `wait_feedback_category` или `wait_feedback_text`

2. **Обработчик категорий** `feedback_*`
   - Сохранить выбранную категорию
   - Попросить написать текст

3. **Обработчик текста в состоянии `wait_feedback_text`**
   - Сохранить фидбек в БД
   - Обновить `last_feedback_at`
   - Отправить подтверждение

4. **Обновление `last_interaction_at`**
   - При любом действии пользователя (фото, команда, callback)

### feedback-worker.ts (или cron в существующем worker)

1. Раз в 30 минут выбирать пользователей для авто-запроса
2. Отправлять сообщение с клавиатурой
3. Обновлять `last_feedback_request_at`
4. Ловить ошибки "bot was blocked by the user"

---

## Состояния сессии

Добавить в таблицу `sessions`:

| state | Описание |
|-------|----------|
| wait_feedback_category | Ждём выбор категории |
| wait_feedback_text | Ждём текст фидбека |

Или использовать отдельное поле `feedback_state` в `users`.

---

## SQL миграция

```sql
-- 014_feedback.sql

-- Таблица фидбека
CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  category text,
  text text NOT NULL,
  trigger text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);

-- Таблица категорий
CREATE TABLE IF NOT EXISTS feedback_categories (
  id text PRIMARY KEY,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  emoji text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true
);

INSERT INTO feedback_categories (id, name_ru, name_en, emoji, sort_order) VALUES
  ('quality', 'Качество стикеров', 'Sticker quality', '🎨', 1),
  ('speed', 'Скорость', 'Speed', '⚡', 2),
  ('styles', 'Стили', 'Styles', '🖌', 3),
  ('ux', 'Удобство', 'Usability', '🎯', 4),
  ('other', 'Другое', 'Other', '💬', 5)
ON CONFLICT (id) DO NOTHING;

-- Поля в users
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_interaction_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_feedback_request_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_feedback_at timestamptz;

-- Локализация
INSERT INTO bot_texts_new (key, lang, value) VALUES
  ('feedback.ask', 'ru', '🗣 Расскажите, что вам понравилось или что можно улучшить?'),
  ('feedback.ask', 'en', '🗣 Tell us what you liked or what can be improved?'),
  ('feedback.hint', 'ru', 'Или просто напишите своими словами 👇'),
  ('feedback.hint', 'en', 'Or just write in your own words 👇'),
  ('feedback.write', 'ru', '✍️ Напишите ваш отзыв:'),
  ('feedback.write', 'en', '✍️ Write your feedback:'),
  ('feedback.thanks', 'ru', 'Спасибо за отзыв! 🙏 Он поможет сделать бота лучше.'),
  ('feedback.thanks', 'en', 'Thanks for your feedback! 🙏 It will help make the bot better.')
ON CONFLICT (key, lang) DO UPDATE SET value = EXCLUDED.value;
```

---

## Чеклист

- [ ] SQL миграция `014_feedback.sql`
- [ ] index.ts: команда `/feedback`
- [ ] index.ts: обработчик `feedback_*` callbacks
- [ ] index.ts: обработчик текста в состоянии `wait_feedback_text`
- [ ] index.ts: обновление `last_interaction_at` при действиях
- [ ] worker или cron: авто-запрос фидбека
- [ ] Тестирование команды `/feedback`
- [ ] Тестирование авто-запроса
- [ ] Проверка локализации ru/en
