# Настройка моделей Gemini через БД (app_config)

**Дата:** 13.02.2026  
**Статус:** Готово к реализации

## Цель

Вынести выбор модели Gemini в таблицу `app_config` в Supabase.
Позволяет менять модели **на лету** — без редеплоя и рестарта контейнеров.

## Текущее состояние

Модель выбирается в `worker.ts` хардкодом:

```typescript
const model = generationType === "style" 
  ? "gemini-3-pro-image-preview" 
  : "gemini-2.5-flash-image";
```

## Решение

### 1. SQL миграция — таблица `app_config`

```sql
CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO app_config (key, value, description) VALUES
  ('gemini_model_style',   'gemini-3-pro-image-preview', 'Модель для генерации стикера из фото (style)'),
  ('gemini_model_emotion', 'gemini-2.5-flash-image',     'Модель для изменения эмоции (emotion)'),
  ('gemini_model_motion',  'gemini-2.5-flash-image',     'Модель для изменения движения (motion)');
```

### 2. `src/lib/app-config.ts` — хелпер с кешем (TTL 60с)

```typescript
import { supabase } from "./supabase";

const cache = new Map<string, { value: string; expiresAt: number }>();
const TTL_MS = 60_000; // 1 минута

export async function getAppConfig(key: string, defaultValue: string): Promise<string> {
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  const value = data?.value ?? defaultValue;
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}
```

- 1 запрос к БД **раз в минуту** на каждый ключ (не на каждую генерацию)
- Если запись не найдена — возвращает дефолт (fallback)
- Кеш в памяти — нулевой оверхед между обновлениями

### 3. `worker.ts` — заменить выбор модели

```typescript
import { getAppConfig } from "./lib/app-config";

const model = 
  generationType === "emotion" ? await getAppConfig("gemini_model_emotion", "gemini-2.5-flash-image") :
  generationType === "motion"  ? await getAppConfig("gemini_model_motion",  "gemini-2.5-flash-image") :
  await getAppConfig("gemini_model_style", "gemini-3-pro-image-preview");
```

### 4. Как менять модель

В Supabase SQL Editor:
```sql
UPDATE app_config SET value = 'gemini-3-pro-image-preview', updated_at = now()
WHERE key = 'gemini_model_motion';
```

Применится автоматически в течение 60 секунд (TTL кеша).

## Файлы для изменения

| Файл | Что менять |
|------|-----------|
| `sql/006_app_config.sql` | Новая таблица + начальные значения |
| `src/lib/app-config.ts` | Новый файл — хелпер с кешем |
| `src/worker.ts` | Заменить хардкод модели на `getAppConfig()` |

## Чеклист

- [ ] Создать SQL миграцию `sql/006_app_config.sql`
- [ ] Создать `src/lib/app-config.ts`
- [ ] Обновить `worker.ts` — выбор модели через `getAppConfig()`
- [ ] Применить SQL в Supabase
- [ ] Проверить билд
- [ ] Задеплоить
