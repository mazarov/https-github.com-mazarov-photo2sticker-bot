# Тестовая среда (Test Environment)

## 1. Проблема

Нет возможности безопасно тестировать новые фичи — любое изменение сразу идёт в прод.
Нужна изолированная тестовая среда без лишних затрат на серверы и базы.

---

## 2. Решение: Локальный запуск + общая база с env-флагом

| Компонент | Production | Test |
|-----------|-----------|------|
| Telegram бот | `@photo2sticker_bot` | `@photo2sticker_test_bot` (новый) |
| Сервер | Cloud (Docker) | Локально (`npm run dev:test`) |
| База данных | Supabase (та же) | Supabase (та же) |
| Изоляция данных | `env = 'prod'` | `env = 'test'` |
| Алерты | Prod alert channel | Отдельный test channel (или отключены) |
| Webhook | Cloud URL | Long polling (без webhook) |

---

## 3. Что нужно создать

### 3.1 Тестовый Telegram бот

1. Зайти в @BotFather
2. `/newbot` → создать `photo2sticker_test_bot`
3. Получить токен
4. Сохранить в `.env.test`

### 3.2 Файл `.env.test`

Копия `.env`, но с подменой:

```env
# Telegram — тестовый бот
TELEGRAM_BOT_TOKEN=<TEST_BOT_TOKEN>
BOT_USERNAME=photo2sticker_test_bot

# Supabase — та же база, но env-флаг
SUPABASE_SUPABASE_PUBLIC_URL=<тот же>
SUPABASE_SERVICE_ROLE_KEY=<тот же>

# API ключи — те же (или тестовые если есть)
GEMINI_API_KEY=<тот же>
PIXIAN_USERNAME=<тот же>
PIXIAN_PASSWORD=<тот же>

# Env flag — ключевое отличие
APP_ENV=test

# Алерты — отдельный канал или пусто
ALERT_CHANNEL_ID=<test_channel_id или пусто>

# Порт — другой чтобы не конфликтовать
PORT=3002

# Без webhook — используем long polling
PUBLIC_BASE_URL=
```

### 3.3 Столбец `env` в таблицах

Добавить `env` в таблицы, которые создают данные:

```sql
-- users
ALTER TABLE users ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_users_env ON users(env);

-- sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_sessions_env ON sessions(env);

-- jobs
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_jobs_env ON jobs(env);

-- transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_transactions_env ON transactions(env);

-- stickers
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_stickers_env ON stickers(env);
```

**Справочники НЕ меняем** (общие для обоих сред):
- `style_groups`
- `style_presets_v2`
- `style_presets`
- `bot_texts_new`
- `prompt_templates`

### 3.4 Изменения в коде

#### `config.ts`

```typescript
export const config = {
  // ...existing...
  appEnv: process.env.APP_ENV || "prod",  // "prod" | "test"
};
```

#### `supabase.ts` — автоматическое добавление env

Все `INSERT` операции должны включать `env: config.appEnv`.

Варианты реализации:
- **A) Вручную** — добавить `env` в каждый insert (просто, но надо не забыть)
- **B) Helper-функция** — обёртка `insertWithEnv(table, data)` (надёжнее)
- **C) Supabase RLS** — Row Level Security с фильтром по env (самое надёжное)

**Рекомендуется вариант A** для начала, с переходом на C позже.

#### `index.ts` — фильтрация при чтении

Ключевые запросы должны фильтровать по `env`:

```typescript
// Пример: getUser
const { data } = await supabase
  .from("users")
  .select("*")
  .eq("telegram_id", telegramId)
  .eq("env", config.appEnv)       // <-- фильтр
  .maybeSingle();

// Пример: getActiveSession
const { data } = await supabase
  .from("sessions")
  .select("*")
  .eq("user_id", userId)
  .eq("is_active", true)
  .eq("env", config.appEnv)       // <-- фильтр
  .maybeSingle();
```

#### `worker.ts` — фильтрация jobs

```typescript
// Worker берёт только свои jobs
const { data: jobs } = await supabase
  .from("jobs")
  .select("*")
  .eq("state", "pending")
  .eq("env", config.appEnv)       // <-- фильтр
  .order("created_at")
  .limit(1);
```

### 3.5 Скрипты запуска

```json
{
  "scripts": {
    "dev:api": "tsx src/index.ts",
    "dev:worker": "tsx src/worker.ts",
    "dev:test:api": "dotenv -e .env.test -- tsx src/index.ts",
    "dev:test:worker": "dotenv -e .env.test -- tsx src/worker.ts",
    "dev:test": "concurrently \"npm run dev:test:api\" \"npm run dev:test:worker\""
  }
}
```

Альтернатива без доп. зависимостей:

```json
{
  "scripts": {
    "dev:test:api": "DOTENV_CONFIG_PATH=.env.test tsx src/index.ts",
    "dev:test:worker": "DOTENV_CONFIG_PATH=.env.test tsx src/worker.ts"
  }
}
```

---

## 4. Очистка тестовых данных

```sql
-- Удалить все тестовые данные одним запросом
WITH d1 AS (DELETE FROM stickers WHERE env = 'test'),
     d2 AS (DELETE FROM jobs WHERE env = 'test'),
     d3 AS (DELETE FROM sessions WHERE env = 'test'),
     d4 AS (DELETE FROM transactions WHERE env = 'test')
DELETE FROM users WHERE env = 'test';
```

---

## 5. Как работать

```
┌──────────────────────────────────────────────────┐
│  Разработка новой фичи                           │
│                                                  │
│  1. Пишешь код                                   │
│  2. npm run dev:test:api (локально)              │
│  3. Тестируешь через @photo2sticker_test_bot     │
│  4. Данные пишутся в Supabase с env='test'       │
│  5. Prod бот не затронут                         │
│  6. Всё ок → git push → деплой в прод           │
│  7. Чистишь тестовые данные (при необходимости)  │
└──────────────────────────────────────────────────┘
```

---

## 6. Безопасность

- `.env.test` добавить в `.gitignore`
- Тестовый бот НЕ должен отправлять алерты в прод-канал
- Worker в тесте берёт ТОЛЬКО `env='test'` jobs
- Тестовый пользователь в проде не увидит тестовые данные и наоборот

---

## 7. Ограничения

- **Справочники общие** — изменение стилей/текстов влияет на обе среды
- **Триггеры Supabase** — работают для обоих env (триггер `add_credits_on_transaction` не знает про env)
- **Rate limits** — Gemini/Pixian API общие, тесты расходуют лимиты

---

## 8. Чеклист

- [ ] Создать тестовый бот через @BotFather
- [ ] Создать `.env.test`
- [ ] SQL миграция: столбец `env` в таблицы
- [ ] Добавить `appEnv` в `config.ts`
- [ ] Добавить `env` во все INSERT операции
- [ ] Добавить фильтр `.eq("env", config.appEnv)` во все SELECT
- [ ] Фильтр env в worker при получении jobs
- [ ] Скрипты `dev:test:api` и `dev:test:worker` в package.json
- [ ] Добавить `.env.test` в `.gitignore`
- [ ] Тестирование: полный флоу через тестовый бот
