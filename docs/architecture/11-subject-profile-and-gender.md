# Subject profile и определение пола по фото

**Связано:** `docs/19-02-pack-0-gender-from-photo.md`, `src/lib/subject-profile.ts`, `src/index.ts`, `src/worker.ts`, миграция `sql/094_subject_gender.sql`.

## Назначение

- **subject_mode** — количество людей на фото: `single` | `multi` | `unknown` (используется для фильтра наборов пака и блоков в промпте).
- **subject_gender** / **object_gender** — пол при одном человеке: `male` | `female` | `unknown`. Сохраняется в сессию и используется при генерации паков: плейсхолдер `{subject}` в описаниях сцен подставляется как «man» или «woman».

## Источники данных

| Источник | Описание |
|----------|----------|
| Детектор (Gemini) | По буферу изображения возвращает `object_mode`, `object_count`, `subject_gender` (при single). Результат парсится и сохраняется в сессию. |
| Сессия | Колонки `sessions.subject_gender`, `sessions.object_gender` (и дублирующие subject_* / object_* для режима и счётчика). |
| Явный выбор | `session.pack_subject_gender` (если введён в UI) имеет приоритет над детекцией при подстановке в паки. |

## Когда запускается детекция (запись в БД)

Детекция вызывается через **`ensureSubjectProfileForGeneration(session, "style")`** (или в воркере — **`ensureSubjectProfileForSource`**). Включение: хотя бы один из `subject_profile_enabled`, `object_profile_enabled`, `object_profile_shadow_enabled` в `app_config` = `true`.

### Точки входа (index.ts)

| Событие | Обработчик / место | Лог при ошибке |
|--------|---------------------|-----------------|
| Первое фото в паке | `session.state === "wait_pack_photo"` → обновление сессии → вызов в фоне | `[pack_photo] subject profile on upload failed:` |
| Фото в single → wait_style | После обновления сессии при получении фото (ручной режим) | `[single_photo] subject profile on upload failed:` |
| «Новое фото» в паке | Callback `pack_new_photo` после переключения на `pending_photo_file_id` | `[pack_new_photo] subject profile failed:` |
| «Новое фото» в single | Callback `single_new_photo` после переключения на новое фото | `[single_new_photo] subject profile failed:` |
| Первое фото в ассистенте | `assistant_wait_photo` → обновление в `assistant_chat` | `[assistant_wait_photo] subject profile failed:` |
| «Новое фото» в ассистенте (идеи) | Callback `assistant_new_photo`, ветка `assistant_wait_idea` | `[assistant_new_photo ideas] subject profile failed:` |
| «Новое фото» в ассистенте (без aSession) | Callback `assistant_new_photo`, ветка `!aSession` | `[assistant_new_photo no-aSession] subject profile failed:` |
| «Новое фото» в ассистенте (чат) | Callback `assistant_new_photo`, ветка чата (успех и catch) | `[assistant_new_photo chat]` / `[assistant_new_photo chat catch]` |
| Прогрев при входе в карусель/пак | При показе карусели пака, если уже есть фото | `[pack_entry]` / `[pack_show_carousel]` / `[pack_try]` warmup failed |

Все вызовы — в фоне (`void ... .catch(...)`), чтобы не блокировать ответ пользователю.

### Воркер (worker.ts)

- **Pack preview:** при сборке промпта пака вызывается `ensureSubjectProfileForSource(session, photoFileId, "photo", ...)` при отсутствии профиля для текущего фото; затем **`getSubjectWordForPrompt(packSubjectProfile)`** → подстановка `{subject}` → «man» / «woman» в `scene_descriptions`.
- **Single/emotion/motion:** при генерации при необходимости вызывается `ensureSubjectProfileForSource` для текущего source (photo или sticker).

## База данных

- **sessions.subject_gender** — text, CHECK (`male` | `female` | `unknown`). Детекция одного человека: пол для подстановки в паки.
- **sessions.object_gender** — text, тот же CHECK. Зеркало для object-profile flow.

Миграция: `sql/094_subject_gender.sql`.

## Приоритет пола для паков

1. `session.pack_subject_gender` (явный выбор пользователя), если есть.
2. Детекция: `session.subject_gender` / `session.object_gender`.
3. Иначе дефолт (например `"man"`).

Реализация: `getSubjectWordForPrompt(profile)` в `subject-profile.ts`; в воркере — построение `packSubjectProfile` из сессии и вызов перед заменой `{subject}` в сценах.

## Конфиг (app_config)

| Ключ | Влияние |
|------|--------|
| `subject_profile_enabled` | Включить детекцию и запись subject_* (и при необходимости object_*). |
| `object_profile_enabled` | Object-profile: детекция и запись object_*. |
| `object_profile_shadow_enabled` | Тень object: тоже участвует в решении «запускать ли детекцию». |

Если все три выключены — детекция при смене фото не запускается (в логах при попытке: `[subject-profile] skipped (subject_profile_enabled/object_profile* off)`).
