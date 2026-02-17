# Background Removal — конфигурация

## Архитектура

Удаление фона работает в два этапа:
1. **Primary** сервис пробует удалить фон
2. Если primary упал — **fallback** сервис подхватывает

Доступные сервисы:
- **rembg** — бесплатный, self-hosted (контейнер `p2s-rembg`)
- **pixian** — платный API, лучшее качество

## app_config ключи

Воркер выбирает ключ в зависимости от `APP_ENV`:

| Ключ | Окружение | Описание | Значение по умолчанию |
|------|-----------|----------|-----------------------|
| `bg_removal_primary` | prod | Какой сервис удаления фона использовать первым | `pixian` |
| `bg_removal_primary_test` | test | То же для тестового стенда | `rembg` |
| `rembg_model` | prod | Модель rembg для прода | `isnet-general-use` |
| `rembg_model_test` | test | Модель rembg для теста | `isnet-anime` |

### Как работает выбор ключа (worker.ts)

```typescript
// Выбор primary сервиса
const bgConfigKey = config.appEnv === "test"
  ? "bg_removal_primary_test"
  : "bg_removal_primary";
const bgPrimary = await getAppConfig(bgConfigKey, "rembg");

// Выбор модели rembg
const modelConfigKey = config.appEnv === "test"
  ? "rembg_model_test"
  : "rembg_model";
const rembgModel = await getAppConfig(modelConfigKey, "isnet-general-use");
```

## Доступные модели rembg

| Модель | Описание | Качество для стикеров |
|--------|----------|-----------------------|
| `isnet-general-use` | Универсальная, стабильная | Среднее |
| `isnet-anime` | Оптимизирована для аниме/мультяшных стилей | Лучше для стикеров |
| `u2net` | Классическая U2-Net | Среднее |
| `birefnet-general` | Новая архитектура BiRefNet | Хорошее |
| `birefnet-portrait` | BiRefNet для портретов | Хорошее для лиц |
| `bria-rmbg` | BRIA RMBG | Хорошее |

## Переменные окружения

| Переменная | Где | Описание |
|------------|-----|----------|
| `APP_ENV` | worker контейнер | `test` или `production` — определяет какие ключи app_config читать |
| `REMBG_URL` | worker контейнер | URL rembg сервиса (например `http://p2s-rembg:5000`) |
| `REMBG_MODEL` | rembg контейнер | Модель для загрузки при старте (`isnet-anime` и т.д.) |
| `PIXIAN_API_KEY` | worker контейнер | API ключ для Pixian |

## Rembg контейнер (p2s-rembg)

Сервер: `rembg_server.py` (Flask + gunicorn)

```python
MODEL_NAME = os.environ.get("REMBG_MODEL", "isnet-general-use")
session = new_session(MODEL_NAME)
```

### Эндпоинты

- `POST /` — удаление фона, принимает `file` (image) + `model` (опционально)
- `GET /health` — статус + текущая модель

### Проверка модели

```bash
curl http://localhost:5000/health
# {"model":"isnet-anime","status":"ok"}
```

## SQL миграция

Файл: `sql/075_bg_removal_config.sql`

```sql
-- Prod
INSERT INTO app_config (key, value) VALUES ('bg_removal_primary', 'pixian')
ON CONFLICT (key) DO UPDATE SET value = 'pixian';

-- Test
INSERT INTO app_config (key, value) VALUES ('bg_removal_primary_test', 'rembg')
ON CONFLICT (key) DO UPDATE SET value = 'rembg';

-- Prod model
INSERT INTO app_config (key, value) VALUES ('rembg_model', 'isnet-general-use')
ON CONFLICT (key) DO UPDATE SET value = 'isnet-general-use';

-- Test model
INSERT INTO app_config (key, value) VALUES ('rembg_model_test', 'isnet-anime')
ON CONFLICT (key) DO UPDATE SET value = 'isnet-anime';
```

## Как переключить

Все настройки меняются в runtime через Supabase (таблица `app_config`). Воркер подхватывает изменения в течение ~60 секунд (кеш).

Примеры:
```sql
-- Переключить тест на pixian
UPDATE app_config SET value = 'pixian' WHERE key = 'bg_removal_primary_test';

-- Поменять модель rembg на тесте
UPDATE app_config SET value = 'birefnet-general' WHERE key = 'rembg_model_test';

-- Переключить прод на rembg (осторожно!)
UPDATE app_config SET value = 'rembg' WHERE key = 'bg_removal_primary';
```
