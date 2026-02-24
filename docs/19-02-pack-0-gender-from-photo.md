# 0. Логика определения пола по фото

**Дата:** 2026-02-19  
**Связано:** subject-profile.ts, pack_content_sets, воркер pack preview/assemble, плейсхолдер {subject}.

---

## Цель

Определять **пол человека на фото** при одном субъекте (`subject_mode === single`) и сохранять его в сессию, чтобы при генерации паков подставлять «man» или «woman» в сцены (плейсхолдер `{subject}`) без дублирования наборов «для него»/«для неё».

---

## Роль subject_mode vs пол

- **subject_mode** (в `pack_content_sets` и сессии) — про **количество** людей: `single` | `multi` | `unknown`. Не про пол.
- **Пол** (мужчина/женщина) задаётся отдельно: детектор при `object_mode === single` возвращает **`subject_gender`** (`male` | `female` | `unknown`). Сохраняется в **`sessions.subject_gender`** и **`sessions.object_gender`**.

---

## Детектор (subject-profile.ts)

1. **Промпт Gemini** расширен: в JSON-схему ответа добавлено поле **`subject_gender`**. В инструкциях: при `object_mode === single` и объект — человек возвращать `male` | `female` | `unknown`; иначе не передавать или null.

2. **Парсинг и пайплайн:** `parseDetectorPayload` читает `subject_gender` (и алиасы), `hardenDetectedProfile` прокидывает его только для `single`, `detectSubjectProfileFromImageBuffer` возвращает **`subjectGender: SubjectGender | null`**.

3. **Типы:** `SubjectGender = "male" | "female" | "unknown"`. В `SubjectProfile` добавлено поле **`subjectGender`** (для `single`; для `multi` — null).

4. **Хелпер для паков:** **`getSubjectWordForPrompt(profile)`** → `"man"` | `"woman"` по `profile.subjectMode` и `profile.subjectGender` (для подстановки в сцены).

5. **Сохранение в сессию:** при вызове `persistSubjectAndObjectProfile` и в `ensureSubjectProfileForSource` / `ensureSubjectProfileForGeneration` записываются **`subject_gender`** и **`object_gender`** в таблицу `sessions`.

---

## Миграция БД

**094_subject_gender.sql:** в `sessions` добавлены колонки **`subject_gender`** и **`object_gender`** (text, CHECK: `male` | `female` | `unknown`).

---

## Использование в воркере (паки)

- Перед сборкой списка сцен для блока `[TASK — PACK GRID ONLY]` воркер берёт слово для подстановки: по `session.pack_subject_gender` (явный выбор пользователя), при отсутствии — по **`getSubjectWordForPrompt(packSubjectProfile)`** (из детекции: `session.subject_gender` / `session.object_gender`).
- В каждой строке из `scene_descriptions` выполняется замена плейсхолдера: **`{subject}`** → «man» или «woman». Итоговый массив подставляется в промпт Gemini.

---

## Приоритет источника пола

1. Явный выбор пользователя **`pack_subject_gender`** в сессии (`male` | `female`), если есть.
2. Детекция по фото: **`session.subject_gender`** / **`session.object_gender`**.
3. При отсутствии или `unknown` — дефолт (например `"man"`).

См. реализацию: `src/lib/subject-profile.ts`, `src/worker.ts`, `src/index.ts`, миграция `sql/094_subject_gender.sql`.
