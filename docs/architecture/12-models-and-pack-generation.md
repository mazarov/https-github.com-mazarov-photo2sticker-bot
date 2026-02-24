# Модели и провайдеры (AI Chat, Worker, Pack pipeline)

Документ фиксирует, какие модели используются в проекте, где они задаются, и какие модели (в т.ч. OpenAI) подходят для пайплайна генерации паков при переносе в тестового бота.

---

## 1. Текущее использование моделей

| Назначение | Провайдер | Модель (дефолт) | Где задаётся |
|------------|-----------|------------------|--------------|
| **AI-ассистент (чат)** | Gemini или OpenAI | `gemini-2.0-flash` / `gpt-4o-mini` | `AI_CHAT_PROVIDER`, `AI_CHAT_MODEL` (env), см. [03-ai-assistant.md](./03-ai-assistant.md) |
| **Генерация стикера (style)** | Gemini | `gemini_model_style` из БД | `app_config` (ключ `gemini_model_style`), дефолт в коде worker |
| **Генерация emotion/motion** | Gemini | `gemini_model_emotion` / `gemini_model_motion` | `app_config` |
| **Генерация сетки пака (превью)** | Gemini | `gemini_model_pack` | `app_config`, дефолт `gemini-2.5-flash-image` |
| **Размер изображения пака** | — | `gemini_image_size_pack` | `app_config`, напр. `1K` |
| **Детектор субъекта (фото → single/couple)** | Gemini | `gemini_model_subject_detector` | `app_config`, дефолт `gemini-2.0-flash` |
| **Идеи стикеров по фото** | OpenAI | `gpt-4o-mini` | Жёстко в коде (generateStickerIdeasFromPhoto) |

### Env и app_config

- **Env:** `GEMINI_API_KEY`, `OPENAI_API_KEY`, `AI_CHAT_PROVIDER` (gemini | openai), `AI_CHAT_MODEL` (опционально).
- **app_config (Supabase):** ключи вида `gemini_model_*`, `gemini_image_size_pack` — см. миграции в `sql/` и [02-worker.md](./02-worker.md).

---

## 2. Пайплайн генерации паков (логика в Cursor → перенос в test-бота)

Пайплайн описан в `docs/pack-multiagent-requirements.md` и правилах в `.cursor/rules/pack-*.mdc`:

1. **Concept** — запрос + контекст фото → бриф (JSON).
2. **Boss** — бриф → план пака (id, names, carousel, day_structure, moments[9]).
3. **Captions** — план → labels, labels_en (9 строк).
4. **Scenes** — план + подписи → scene_descriptions (9 строк с `{subject}`).
5. **Assembly** — сборка в формат `pack_content_sets`.
6. **Critic** — проверка спеки (pass/fail, suggestions); обязателен, при fail — итерация.

Все шаги 1–5 и 6 — **текстовые** (вход/выход JSON или текст). Генерация картинки по `scene_descriptions` уже есть в worker (Gemini, `gemini_model_pack`). Значит в бота нужно перенести вызовы LLM для агентов Concept, Boss, Captions, Scenes, Critic.

---

## 3. Какие модели использовать для агентов паков

Агенты паков — короткие промпты и строгий JSON на выходе. Важны скорость (5–6 вызовов подряд), структурированный вывод и стоимость.

Подходят модели с поддержкой **Structured Outputs** (JSON Schema), чтобы снизить количество ретраев из-за сломанного JSON.

| Модель | Плюсы | Минусы | Рекомендация |
|--------|--------|--------|----------------|
| **gpt-4o-mini** | Дёшево, быстро, поддерживает Structured Outputs | Может слабее держать сложные инструкции (Costume, Environment) | **Основной вариант** для всех агентов паков на test |
| **gpt-4o** | Лучше качество и следование инструкциям | Дороже, медленнее | Имеет смысл для Critic или при частых fail на gpt-4o-mini |
| **gpt-4.1-mini** (если доступен) | Более свежая мини-модель | Проверить наличие в API | Альтернатива gpt-4o-mini |

Рекомендация по умолчанию для test-бота: **один провайдер для паков — OpenAI, модель `gpt-4o-mini`** для Concept, Boss, Captions, Scenes и Critic. При желании Critic можно переключить на `gpt-4o` через конфиг (отдельный ключ в `app_config` или env).

Использовать **Structured Outputs** (`response_format: { type: "json_schema", json_schema: { ... } }`) для каждого агента, чтобы ответ всегда был валидным JSON с нужными полями.

### 3.2. Gemini

Уже используются в проекте для чата и детектора. Для паков можно оставить единый провайдер Gemini:

| Модель | Плюсы | Минусы |
|--------|--------|--------|
| **gemini-2.0-flash** | Уже стоит для чата, быстро, дёшево | Нет нативной JSON Schema — нужен парсинг и ретраи при сломанном JSON |
| **gemini-2.5-flash** (если доступен для text) | Лучше следование инструкциям | Проверить доступность и лимиты |

Если пайплайн паков в test-боте будет через **Gemini**: те же агенты (Concept, Boss, Captions, Scenes, Critic) вызывать как текстовые `generateContent` с жёстким промптом «верни только JSON, без markdown». Настройка модели — через `app_config` (например `pack_agent_model` или отдельный ключ на агента).

---

## 4. Предлагаемая конфигурация для test-бота (паки)

- **Провайдер агентов паков:** настраиваемый (env или app_config), например `PACK_PIPELINE_PROVIDER=openai` | `gemini`.
- **Модели (OpenAI):**
  - `PACK_PIPELINE_MODEL=gpt-4o-mini` — для всех агентов (Concept, Boss, Captions, Scenes, Critic), либо
  - Отдельные ключи: `pack_model_concept`, `pack_model_boss`, … (в app_config) для разведения по моделям позже.
- **Модели (Gemini):**
  - Ключ в app_config, напр. `pack_agent_model` = `gemini-2.0-flash` (или `gemini-2.5-flash` для text, если доступен).
- **Генерация картинки пака** уже в worker: `gemini_model_pack`, `gemini_image_size_pack` — без изменений.

Итог: в документе зафиксировано текущее использование моделей и то, что для пайплайна паков в test-боте лучше всего подходят **OpenAI gpt-4o-mini** (приоритет) с Structured Outputs, либо Gemini с явным указанием «только JSON» и при необходимости отдельной моделью для Critic (gpt-4o / более сильная Gemini).

---

## 5. Связь с кодом

| Компонент | Файл | Модель/конфиг |
|-----------|------|----------------|
| AI Chat | `src/lib/ai-chat.ts` | `config.aiChatProvider`, `config.aiChatModel`, дефолты `gemini-2.0-flash` / `gpt-4o-mini` |
| Worker (стикеры) | `src/worker.ts` | `getAppConfig("gemini_model_style" | "gemini_model_emotion" | "gemini_model_motion" | "gemini_model_pack", …)` |
| Worker (размер пака) | `src/worker.ts` | `getAppConfig("gemini_image_size_pack", "1K")` |
| Детектор субъекта | `src/lib/subject-profile.ts` | `getAppConfig("gemini_model_subject_detector", "gemini-2.0-flash")` |
| Идеи по фото | `src/index.ts` (generateStickerIdeasFromPhoto) | OpenAI, модель в коде |

После переноса пайплайна паков в test-бота добавить сюда строки для новых ключей (pack_agent_model / PACK_PIPELINE_MODEL и т.д.) и файлов вызова агентов.
