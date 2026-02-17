# Таблица `assistant_sessions` — вынос AI-ассистента из `sessions`

**Дата:** 08.02.2026  
**Статус:** TODO  

---

## Проблема

Сейчас данные AI-ассистента хранятся в 4 колонках таблицы `sessions`:

| Колонка | Тип | Назначение |
|---------|-----|-----------|
| `assistant_messages` | jsonb | История чата `[{role, content}]` |
| `assistant_params` | jsonb | `{style, emotion, pose, text, confirmed, step}` |
| `assistant_error_count` | integer | Счётчик ошибок Gemini |
| `pending_photo_file_id` | text | Временное хранение нового фото |

**Проблемы:**
1. Цель пользователя (Step 0) не выделена — закопана в `assistant_messages`
2. Все поля — jsonb, неудобно для аналитики (`assistant_params->>'style'` вместо `style`)
3. Колонки null для ~90% обычных (не assistant) сессий — засоряют таблицу
4. Нет связи 1:N — нельзя хранить несколько assistant-диалогов

---

## Решение

Создать отдельную таблицу `assistant_sessions` с плоскими колонками.

### Схема таблицы

```sql
CREATE TABLE assistant_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  
  -- Диалог
  goal text,                       -- Цель пользователя (Step 0)
  style text,                      -- Выбранный стиль (Step 2)
  emotion text,                    -- Эмоция (Step 3)
  pose text,                       -- Поза / жест (Step 4)
  sticker_text text,               -- Текст на стикере (Step 5), null = без текста
  confirmed boolean DEFAULT false, -- Пользователь подтвердил параметры
  current_step integer DEFAULT 0,  -- Текущий шаг диалога (0-7)
  
  -- Чат
  messages jsonb DEFAULT '[]',     -- История чата [{role, content}]
  error_count integer DEFAULT 0,   -- Счётчик ошибок AI (для fallback)
  
  -- Фото
  pending_photo_file_id text,      -- Временное хранение нового фото (swap flow)
  
  -- Мета
  status text DEFAULT 'active',    -- active | completed | abandoned | error
  env text DEFAULT 'prod',
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  
  -- Индексы будут ниже
  CONSTRAINT valid_status CHECK (status IN ('active', 'completed', 'abandoned', 'error'))
);

-- Индексы
CREATE INDEX idx_assistant_sessions_user ON assistant_sessions(user_id);
CREATE INDEX idx_assistant_sessions_status ON assistant_sessions(status) WHERE status = 'active';
CREATE INDEX idx_assistant_sessions_env ON assistant_sessions(env);
CREATE INDEX idx_assistant_sessions_created ON assistant_sessions(created_at);
```

### Статусы

| Статус | Когда |
|--------|-------|
| `active` | Диалог в процессе |
| `completed` | Пользователь подтвердил → генерация запущена |
| `abandoned` | Таймаут 30 мин / пользователь ушёл в ручной режим |
| `error` | 3 ошибки AI подряд → fallback в ручной режим |

---

## Рефакторинг `index.ts`

### Что меняется

| Было (sessions) | Стало (assistant_sessions) |
|-----------------|---------------------------|
| `session.assistant_messages` | `assistantSession.messages` |
| `session.assistant_params` | `assistantSession.style`, `.emotion`, `.pose`, `.sticker_text`, `.confirmed`, `.current_step` |
| `session.assistant_params.text` | `assistantSession.sticker_text` |
| `session.assistant_error_count` | `assistantSession.error_count` |
| `session.pending_photo_file_id` | `assistantSession.pending_photo_file_id` |

### Функции для работы с таблицей

```typescript
// Создать assistant session
async function createAssistantSession(userId: string, sessionId: string, env: string): Promise<AssistantSessionRow>

// Получить активную assistant session
async function getActiveAssistantSession(userId: string): Promise<AssistantSessionRow | null>

// Обновить параметры
async function updateAssistantSession(id: string, data: Partial<AssistantSessionRow>): Promise<void>

// Завершить (completed / abandoned / error)
async function closeAssistantSession(id: string, status: string): Promise<void>
```

### Места в `index.ts` для обновления (~15 точек)

1. **`startAssistantDialog()`** — создание: `INSERT INTO assistant_sessions` вместо записи в `sessions.assistant_messages`
2. **`bot.on("photo")` (assistant_wait_photo)** — обновление: `assistantSession.messages` + `pending_photo_file_id`
3. **`bot.on("text")` (assistant_wait_photo)** — обновление чата
4. **`bot.on("text")` (assistant_chat)** — обновление: `messages`, `style/emotion/pose/sticker_text`, `current_step`
5. **`bot.action("assistant_confirm")`** — обновление: `confirmed=true`, `status='completed'`
6. **`bot.action("assistant_new_photo")`** — чтение `pending_photo_file_id`
7. **`bot.action("assistant_keep_photo")`** — очистка `pending_photo_file_id`
8. **`bot.action("assistant_restart")`** — закрытие старой + создание новой
9. **`bot.hears("🎨 Стили")`** — закрытие: `status='abandoned'`
10. **`handleAssistantConfirm()`** — чтение `style/emotion/pose/sticker_text`
11. **`processExpiredAssistantSessions()`** — запрос по `assistant_sessions.status='active'` + `created_at`
12. **Платёж после paywall** — чтение `style/emotion/pose/sticker_text` из `assistant_sessions`

### Связь с `sessions`

- `sessions` остаётся основной таблицей для генерации (фото, промпт, стиль, job)
- `assistant_sessions.session_id` ссылается на `sessions.id`
- Состояния `assistant_wait_photo`, `assistant_chat`, `wait_assistant_confirm` остаются в `sessions.state` (для роутинга сообщений)
- При подтверждении: данные из `assistant_sessions` → `sessions.prompt_final` → генерация

---

## Удаление старых колонок (после миграции)

```sql
-- Выполнить ПОСЛЕ полного перехода на assistant_sessions
ALTER TABLE sessions DROP COLUMN IF EXISTS assistant_messages;
ALTER TABLE sessions DROP COLUMN IF EXISTS assistant_params;
ALTER TABLE sessions DROP COLUMN IF EXISTS assistant_error_count;
ALTER TABLE sessions DROP COLUMN IF EXISTS pending_photo_file_id;
```

---

## Аналитика (примеры запросов)

```sql
-- Топ целей
SELECT goal, count(*) as cnt
FROM assistant_sessions
WHERE goal IS NOT NULL
GROUP BY goal ORDER BY cnt DESC LIMIT 20;

-- Топ стилей
SELECT style, count(*) as cnt
FROM assistant_sessions
WHERE confirmed = true
GROUP BY style ORDER BY cnt DESC;

-- Воронка по шагам
SELECT
  count(*) as started,
  count(*) FILTER (WHERE goal IS NOT NULL) as set_goal,
  count(*) FILTER (WHERE style IS NOT NULL) as chose_style,
  count(*) FILTER (WHERE emotion IS NOT NULL) as chose_emotion,
  count(*) FILTER (WHERE pose IS NOT NULL) as chose_pose,
  count(*) FILTER (WHERE confirmed) as confirmed,
  count(*) FILTER (WHERE status = 'completed') as completed
FROM assistant_sessions;

-- Среднее число шагов до подтверждения
SELECT avg(current_step) FROM assistant_sessions WHERE confirmed = true;

-- Причины отвала
SELECT status, count(*) FROM assistant_sessions GROUP BY status;

-- Популярные комбинации стиль + эмоция
SELECT style, emotion, count(*) as cnt
FROM assistant_sessions
WHERE confirmed = true
GROUP BY style, emotion ORDER BY cnt DESC LIMIT 20;
```

---

## План реализации

| # | Задача | Сложность |
|---|--------|-----------|
| 1 | SQL миграция: CREATE TABLE assistant_sessions | Низкая |
| 2 | Вспомогательные функции CRUD в `src/lib/assistant-db.ts` | Средняя |
| 3 | Рефакторинг `index.ts`: заменить 15 точек | Высокая |
| 4 | Рефакторинг `processExpiredAssistantSessions()` | Низкая |
| 5 | Тестирование полного флоу | Средняя |
| 6 | SQL миграция: DROP старых колонок из sessions | Низкая |

**Общая оценка:** ~2-3 часа работы.
