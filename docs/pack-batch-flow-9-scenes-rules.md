# Текущий флоу пака: 9 сцен — правила агентов и требования

**Дата:** 26.02.2026  
**Статус:** Обязательные требования для batch-режима  
**Связано:** `docs/20-02-interactive-pack-final-requirements-v2.md`, `docs/26-02-pack-agents-slim-context-tz.md`, `src/lib/pack-multiagent.ts`

Документ описывает **текущий пайплайн** генерации пака целиком (batch):

```
Brief & Plan  →  Captions ∥ Scenes (по 9)  →  Assembly  →  Critic  →  [rework при необходимости]
```

Все требования ниже **обязательны** для этого флоу.

---

## 1. Scenes Agent — FINAL RULES (CRITICAL)

### Language
- ✅ **ENGLISH ONLY**
- ❌ **NO RU SCENES** в пайплайне генерации изображений (RU — только для UI/превью при необходимости)
- Сцены используются только для image generation.

### Subject Lock
- Каждая сцена **должна** начинаться с `{subject}`
- `{subject}` встречается **ровно один раз** в каждой сцене
- Без местоимений вместо `{subject}`
- Без новых людей

### Scene Content Rules
Каждая сцена:
- **Ровно одно** предложение
- **12–18 слов** макс.
- Одно тело-действие
- Одна поза
- Макс. 1 проп (полностью видимый)
- Простой фон (flat / gradient / wall)

### Forbidden in Scenes
- ❌ эмоции словами
- ❌ метафоры
- ❌ кинематографичный язык
- ❌ наречия: suddenly, awkwardly, nervously
- ❌ объяснения или юмор

Сцены описывают **только видимое состояние тела**.

---

## 2. Captions Agent — правила для batch (9 подписей)

- **Ровно 9 подписей** (по одной на сцену)
- **15–20 символов** на подпись (включая пробелы)
- First-person
- Без эмодзи
- Только внутренняя реакция
- Self-check длины перед выводом
- Output: labels (RU), labels_en (EN) — по 9 элементов

---

## 3. Critic Agent — использование в batch

- Critic вызывается **после** сборки spec (9 captions + 9 scenes).
- Роль: финальный гейт по формату и качеству.
- Лимиты вывода:
  - Max 3 пункта в Reasons
  - Max 3 пункта в Suggestions
  - Max 12 слов на пункт
  - Без прозы и объяснений
- При провале — rework только затронутых индексов (captions/scenes), не всего пака.

---

## 4. Token Efficiency Rules (MANDATORY)

- **Никогда** не передавать полный JSON между агентами — только минимальные плоские контракты (MOMENTS, TONE, OUTFIT и т.д.).
- Не дублировать правила в downstream-промптах (NOTE вместо полного повторения Anti-Postcard и т.п.).
- Кэшировать system prompts, если платформа позволяет (system message первым).
- Регенерировать **только** проваленные сцены/подписи по индексам, не весь пак.

---

## 5. Risk Management (Product Safety)

### Moment Risk Levels (внутренние)
Каждый момент может быть помечен:
- safe
- medium
- awkward

Правила (для интерактива; в batch опционально для сортировки моментов):
- Первые 1–2 сцены — только safe или medium
- Awkward-моменты — позже
- Цель: не оттолкнуть пользователя в начале.

В текущем batch-флоу порядок моментов задаётся Brief & Plan; при внедрении интерактива risk используется для выбора следующего момента.

---

## 6. Non-Goals (Explicit)

- Нет полной перегенерации пака из-за одной проваленной сцены
- Нет RU-текста в пайплайне генерации изображений (сцены только EN)
- Нет дублирования одних и тех же правил в промптах всех агентов

---

## 7. Success Criteria (batch)

- Консистентность стиля по всем 9 сценам
- Без повторяющихся поз
- Caption length 15–20, scene_descriptions с ровно одним `{subject}` и 12–18 words
- Токен-эффективность: slim/flat контракты, без полного JSON между агентами

---

## 8. Key Principle

Batch-флоу — это один проход: Brief & Plan задаёт стиль и 9 моментов; Captions и Scenes генерируют 9 подписей и 9 сцен параллельно; Critic проверяет формат. При провале — точечный rework, не перегенерация всего пака.

---

# Привязка к коду (batch)

| Тема | Как сейчас | Где |
|------|------------|-----|
| Scenes: EN only, 12–18 words, Subject Lock, Forbidden | Промпт SCENES_SYSTEM; flat contract (MOMENTS, SUBJECT_MODE, OUTFIT) | `pack-multiagent.ts` |
| Captions: 9 подписей, 15–20 символов | Промпт CAPTIONS_SYSTEM; formatCaptionsUserMessage (flat MOMENTS + TONE) | `pack-multiagent.ts` |
| Critic: только в batch | Вызывается в runPackGenerationPipeline после assembleSpec | `pack-multiagent.ts` |
| Token efficiency | Flat contracts (Level 2), NOTE вместо дублирования (Level 4), system first (Level 3) | `pack-multiagent.ts` |
| Валидация | После агентов: количество сцен/подписей, длина; при rework — parseCriticIndices, runCaptionsForIndices / runScenesForIndices | `pack-multiagent.ts` |

Дальнейшие доработки по требованиям выше (например, явный блок Forbidden в промпте Scenes, 12–18 words) вносятся в `src/lib/pack-multiagent.ts` и при необходимости в `docs/26-02-pack-agents-slim-context-tz.md`.
