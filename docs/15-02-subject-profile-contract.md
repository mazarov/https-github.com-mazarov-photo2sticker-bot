# Subject Profile Contract: единый контроль количества персонажей

**Дата:** 15.02.2026  
**Проект:** photo2sticker-bot  
**Статус:** proposed  
**Цель:** системно убрать плавающие ошибки, когда модель добавляет/удаляет персонажей между генерациями в `assistant` / `single` / `pack`.

---

## 1. Проблема

Сейчас количество персонажей в результате задается неявно:

- частично из текста промпта (`if ONE person ... if MULTIPLE people ...`);
- частично из `scene_descriptions` (особенно в pack);
- частично из стохастики модели (Gemini image).

Из-за этого:
- в одном прогоне появляется лишний персонаж;
- в следующем прогоне при тех же входных данных результат уже корректный.

Это архитектурный дефект: нет единого источника правды о том, сколько персонажей должно быть в генерации.

---

## 2. Что считаем правильным поведением

1. Количество персонажей определяется **один раз** по рабочему source.
2. Это решение сохраняется как `subject profile`.
3. Все режимы (`assistant`, `single`, `pack`) используют один и тот же контракт.
4. Промпты и наборы сцен не могут конфликтовать с профилем.
5. При замене фото (`new photo`) профиль пересчитывается.

---

## 3. Архитектурный принцип

Вводим единый контракт:

- **Source for subject profile**: реальный `source_file_id` текущей генерации + `source_kind`.
- **Subject Profile**: данные о количестве персонажей, привязанные к `(source_file_id, source_kind)`.
- **Subject Lock Block**: обязательный блок в каждом prompt для image generation.

Любой генерационный поток обязан пройти через этот контракт.

---

## 4. Источник правды для source (обязательно)

Ключевое правило: profile нельзя привязывать только к `sessions.current_photo_file_id`.

| Тип генерации | Input для генерации | `source_kind` | Какой profile использовать |
|---|---|---|---|
| `style` | исходное фото пользователя | `photo` | profile от фото |
| `emotion` | предыдущий стикер | `sticker` | profile от стикера |
| `motion` | предыдущий стикер | `sticker` | profile от стикера |
| `text` | предыдущий стикер (поверх оверлей) | `sticker` | profile от стикера |

Это гарантирует отсутствие конфликта lock-инструкций между режимами.

---

## 5. Модель данных

### 5.1 `sessions` (новые поля)

- `subject_mode text` — `single | multi | unknown`
- `subject_count int` — фактическое количество (если удалось определить)
- `subject_confidence numeric` — confidence детектора (0..1)
- `subject_source_file_id text` — file_id, по которому считали профиль
- `subject_source_kind text` — `photo | sticker`
- `subject_detected_at timestamptz` — когда профиль обновили

### 5.2 `pack_content_sets` (совместимость по субъекту)

- `subject_mode text default 'any'` — `single | multi | any`

`single` — только для фото с одним человеком  
`multi` — только для групп/пар  
`any` — универсально

---

## 6. Единый жизненный цикл (для всех flow)

1. Пользователь отправил фото или flow выбрал source-стикер.
2. Роутер определяет `(source_file_id, source_kind)` по текущему `generation_type`.
3. Если source изменился -> пересчитать `subject profile`.
4. Сохранить профиль в `sessions`.
5. Любая генерация использует `subject lock` из профиля.

---

## 7. Unified Subject Lock (обязательный блок промпта)

Пример для `single`:

- "Source contains EXACTLY ONE person."
- "Never add extra persons, background people, couples, reflections as separate persons."
- "Preserve the same identity across all outputs."

Пример для `multi`:

- "Source contains MULTIPLE persons."
- "Include all persons from the source. Do not drop or add persons."
- "Preserve relative composition and interactions."

Этот блок добавляется:
- в `startGeneration` (single + assistant final generation),
- в pack preview prompt,
- при pack regenerate.

---

## 8. Pack-specific правила

1. На этапе карусели фильтровать `pack_content_sets` по `subject_mode`:
   - `single` -> показываем `single` + `any`
   - `multi` -> показываем `multi` + `any`
2. Если выбран set, несовместимый с профилем:
   - reject с user-friendly сообщением + предложить совместимые наборы.
3. В worker: финальная проверка совместимости перед генерацией.

---

## 9. Guard после генерации (опционально, флагом)

Пост-валидация результата:
- дешево оцениваем число персонажей на итоговом изображении;
- если mismatch с `subject_mode`:
  - один auto-regenerate с усиленным lock;
  - затем fail с логом и понятным сообщением пользователю.

### Важные ограничения post-check (обязательно)

- Auto-regenerate не должен повторно списывать кредиты.
- Auto-regenerate не должен создавать дублирующие `jobs`.
- Используем idempotency key (например, на уровне `pack_batch_id + session_id + phase`).
- Лимит: максимум 1 auto-regenerate на одну пользовательскую попытку.

---

## 10. Feature flags (rollout-safe)

В `app_config`:

- `subject_profile_enabled` — включить профиль субъекта
- `subject_lock_enabled` — добавлять lock в промпты
- `subject_mode_pack_filter_enabled` — фильтр карусели наборов
- `subject_postcheck_enabled` — пост-проверка результата

Rollout:
1) enable `subject_profile_enabled`  
2) enable `subject_lock_enabled`  
3) enable `subject_mode_pack_filter_enabled`  
4) enable `subject_postcheck_enabled` (последним)

---

## 11. Изменения по коду

### `src/index.ts`
- `resolveWorkingPhoto(session, user)` — единый источник working photo для `style`
- `resolveGenerationSource(session, user, generationType)` — единый source selector
- `resolveSubjectProfile(session, sourceFileId, sourceKind)` — пересчет/чтение профиля
- `buildSubjectLock(profile)` — формирует lock block
- добавлять lock в:
  - single generation
  - assistant confirm flow
  - pack preview/regenerate entry

### `src/worker.ts`
- pack preview prompt: использовать `subject lock`
- optional postcheck: валидация количества персонажей
- postcheck regenerate: строго идемпотентно, без второго списания кредита

### `src/lib/...`
- helper для lightweight person count detector (Gemini vision JSON / fallback)

---

## 12. Миграция (минимум)

1. Добавить поля в `sessions` (subject_*).
2. Добавить `subject_mode` в `pack_content_sets` (`default 'any'`).
3. Backfill:
   - текущие наборы пометить `any` (без функционального риска),
   - затем вручную/поэтапно размечать `single/multi`.
4. Добавить feature flags в `app_config`.

---

## 13. Безопасный rollout `pack_content_sets.subject_mode`

Чтобы не "обнулить" карусель наборов:

1. Миграция с `default 'any'` и заполнением существующих строк `any`.
2. Включить `subject_mode_pack_filter_enabled` только после шага 1.
3. Разметку `single/multi` делать постепенно, оставляя fallback `any`.
4. Мониторить долю пустых каруселей; при росте сразу откатить только флаг фильтра.

---

## 14. Тест-план (smoke)

### Assistant
- one-person source -> assistant style/emotion/pose -> generate -> всегда 1 персонаж
- new photo replacement -> профиль обновляется

### Single
- one-person source -> style generation -> всегда 1 персонаж
- repeat generation with same session -> стабильно 1 персонаж

### Pack
- one-person source + set с `single/any` -> preview #1/#2 без "второго лишнего"
- regenerate preview -> не меняет число персонажей
- несовместимый set (если `multi`) -> корректный reject/suggestion
- postcheck regenerate (если включен) -> без повторного списания кредита

---

## 15. Критерии приемки

1. Для one-person source в 10 подряд генерациях (single/assistant/pack preview) не появляется второй персонаж.
2. Для multi-source не пропадает ни один человек.
3. В логах есть `subject_mode`, `subject_count`, `subject_source_file_id`, `subject_source_kind` для каждой генерации.
4. Нельзя запустить pack set, несовместимый с `subject_mode` (при включенном флаге фильтра).
5. При postcheck auto-regenerate кредиты списываются ровно один раз.

---

## 16. Риски

- Ошибка детектора на сложных входах -> `subject_mode=unknown`.
- Для `unknown` применяем fallback:
  - не блокировать flow,
  - использовать более мягкий lock + явный лог для мониторинга.
- Временная стоимость: +1 lightweight анализ на новый source.

---

## 17. Почему это системно

Потому что мы перестаем разруливать "сколько людей" в каждом flow отдельно и переносим это в единый контракт:

`source_file_id/source_kind -> subject profile -> subject lock`.

Именно это убирает повторяющиеся баги "в одном месте починили, в другом сломалось".
