# Object Profile Contract v2: единый контроль количества главных объектов

**Дата:** 17.02.2026  
**Проект:** photo2sticker-bot  
**Статус:** proposed  
**Связано:** [15-02-subject-profile-contract.md](15-02-subject-profile-contract.md), [architecture/01-api-bot.md](architecture/01-api-bot.md), [architecture/02-worker.md](architecture/02-worker.md), [architecture/04-database.md](architecture/04-database.md)

---

## 1. Контекст и проблема

Текущий `Subject Profile Contract` хорошо закрывает базовые кейсы, но нестабилен на сложных входах:

- один главный субъект + обрезанный второй по краю кадра -> ложный `multi`;
- животные и другие не-человеческие сцены -> нестабильная интерпретация через human-centric правила.

Корневая причина: модель и пост-обработка ориентированы на "people count", а не на устойчивое понятие "главные объекты сцены".

---

## 2. Цель

Ввести object-first контракт:

1. детектор считает **главные объекты**, а не только людей;
2. генерация и фильтрация паков опираются на кардинальность объектов (`single/multi/unknown`);
3. edge-фрагменты по краям не должны уводить в `multi`;
4. rollout должен быть без поломки текущего `subject_*` пайплайна.

---

## 3. Принцип v2

Новый источник правды:

`source_file_id/source_kind -> object profile -> object lock`.

Без деления на "люди/животные" в core-логике.  
Тип объекта может храниться как вторичный сигнал, но не является обязательным для принятия решения о кардинальности.

---

## 4. Контракт данных (v2)

### 4.1 Новые поля в `sessions` (additive)

- `object_mode text` — `single | multi | unknown`
- `object_count int` — число главных объектов
- `object_confidence numeric` — confidence итогового решения
- `object_source_file_id text` — source file_id
- `object_source_kind text` — `photo | sticker`
- `object_detected_at timestamptz` — timestamp расчета
- `object_instances_json jsonb` — детекторные кандидаты (bbox/area/edge/confidence), после нормализации

### 4.2 Совместимость с текущими полями

Поля `subject_*` остаются рабочими на период миграции.  
В v2 допускается dual-write:

- записывать `object_*` как primary;
- заполнять `subject_*` как backward-compatible mirror.

---

## 5. Детектор v2: формат и правила

### 5.1 Требование к выходу детектора

Детектор возвращает JSON по инстансам объектов, минимум:

- `bbox` (нормализованный прямоугольник 0..1),
- `confidence`,
- `area_ratio`,
- `edge_touch` (касается края кадра),
- `is_primary_candidate` (опционально).

### 5.2 Policy layer (deterministic, обязателен)

После raw-детекции применяется единый policy:

1. dedup кандидатов (overlap suppression);
2. отфильтровать шум и микрокандидаты (`area_ratio` ниже порога);
3. edge-fragment suppression:
   - если объект касается края и слишком мал, не считать главным;
4. выбрать primary objects;
5. вычислить `object_mode/object_count/object_confidence`.

Именно policy layer, а не LLM-ответ напрямую, принимает финальное решение.

---

## 6. Prompt-lock v2 (object-based)

### 6.1 Для `single`

- "Source contains EXACTLY ONE main object."
- "Do not add extra objects or duplicates."
- "Preserve identity/appearance of the main object."

### 6.2 Для `multi`

- "Source contains MULTIPLE main objects."
- "Do not add or remove main objects."
- "Preserve relative composition."

### 6.3 Для `unknown`

- мягкий lock:
  - "Preserve visible main objects as-is."
  - "Do not invent additional prominent objects."

---

## 7. Pack-specific совместимость

На первом этапе не ломаем существующий `pack_content_sets.subject_mode`:

- трактуем его как cardinality-совместимость (`single/multi/any`);
- сравниваем с `object_mode` (или fallback в `subject_mode` пока v2 не включен полностью).

Таким образом текущая схема БД и контент-наборов сохраняется.

---

## 8. Feature flags и rollout

Новые флаги:

- `object_profile_enabled`
- `object_lock_enabled`
- `object_mode_pack_filter_enabled`
- `object_profile_shadow_enabled`
- `object_edge_filter_enabled`
- `object_multi_confidence_min`
- `object_multi_low_confidence_fallback`

### Rollout-порядок (безопасный)

1. `object_profile_shadow_enabled=true` (считаем v2 в фоне, не влияем на генерацию);
2. `object_profile_enabled=true` (dual-write в `object_*`, read еще старый);
3. `object_lock_enabled=true`;
4. `object_mode_pack_filter_enabled=true`;
5. при стабильности метрик переключить read-путь с `subject_*` на `object_*`.

---

## 9. Архитектурная совместимость (проверка)

### 9.1 API (`architecture/01-api-bot.md`)

Совместимо:

- source resolution (`style` from photo, `emotion/motion/text` from sticker) не меняется;
- `startGeneration` и pack-preview используют тот же hook для lock-инъекции, меняется только профильный источник;
- reject/session-router логика не затрагивается.

### 9.2 Worker (`architecture/02-worker.md`)

Совместимо:

- worker уже имеет точку `ensureSubjectProfileForSource`; расширяется до object-profile без изменения очереди job;
- server-side pack compatibility check остается, меняется источник mode;
- postcheck флоу сохраняется, но получает object-based критерии.

### 9.3 Database (`architecture/04-database.md`)

Совместимо:

- только additive migration новых `object_*` колонок;
- `subject_*` не удаляются на первом этапе;
- `pack_content_sets.subject_mode` остается валидным.

Итог: внедрение возможно без breaking schema/flow changes.

---

## 10. Неблокирующие ограничения (чтобы не сломать прод)

- Не включать `object_mode_pack_filter_enabled` до прогрева `object_*` профилей.
- При `object_mode=unknown` не блокировать flow (fallback на `any` + мягкий lock).
- Не списывать кредиты повторно в retry/postcheck ветках.

---

## 11. Тест-план (обязательные кейсы)

1. **One main + edge fragment**: главный объект один, на краю частичный второй -> итог `single`.
2. **Single animal**: один животный объект -> итог `single`, без деградации в `unknown`.
3. **Two clear objects**: два полноценных объекта в центре -> `multi`.
4. **Low-confidence clutter**: шумный фон, нет явных primary -> `unknown`.
5. **Pack filter**:
   - `single` source не показывает `multi-only` наборы;
   - `unknown` source не приводит к пустой карусели (через `any` fallback).
6. **Stability**:
   - повторные генерации из одного source не скачут между `single/multi`.

---

## 12. Критерии приемки

1. Кейс "один + обрезанный второй по краю" не уходит в ложный `multi` в серии тестов.
2. Кейс с одним животным стабильно классифицируется как `single` (object-based).
3. Rollout проходит без регрессий в existing flow (`assistant/single/pack`).
4. При отключении object-флагов система полностью возвращается к текущему `subject_*` поведению.

---

## 13. Почему это не ломает текущую систему

- additive schema, без destructive миграций;
- флаги позволяют staged rollout и быстрый rollback;
- существующий routing/payment/job lifecycle не меняется;
- `subject_*` и текущие pack-set правила остаются как fallback до полной стабилизации v2.

