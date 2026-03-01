# Изменение флоу пака: с 9 до 16 стикеров

**Дата:** 19.02.2026  
**Статус:** Спецификация изменений  
**Связано:** `docs/pack-batch-flow-9-scenes-rules.md`, `docs/final-promt-16.md`, `src/lib/pack-multiagent.ts`, `src/worker.ts`, `docs/architecture/02-worker.md`

Документ описывает **все изменения**, необходимые для перехода с 9 стикеров в паке на 16 стикеров: БД, мультиагент, воркер, разрешение листа, кредиты и документация.

**Источник промптов:** `docs/final-promt-16.md` — финальные промпты Brief & Plan, Captions, Scenes, Critic для 16 стикеров.

---

## 1. Цель

- В паке по умолчанию **16 стикеров** вместо 9.
- Сетка: **4×4** (вместо 3×3).
- Сохранить единый флоу: Brief & Plan → Captions ∥ Scenes → Assembly → Critic.
- **Структура 4 эмоциональных блоков** (1–4, 5–8, 9–12, 13–16) — ключевое требование для всех агентов (см. `docs/final-promt-16.md`).

---

## 2. Области изменений

| Область | Что менять |
|--------|------------|
| **БД** | Дефолт и сиды: `sticker_count` = 16; миграция для существующих паков (опционально). |
| **Pack multiagent** | Все «9» → параметр (16): план (moments), captions, scenes, assembleSpec, валидация, rework slices. |
| **Worker** | Промпт превью: «9» → переменная (например `${stickerCount}`); сборка сетки уже считает cols/rows из `template.sticker_count`. |
| **Разрешение листа** | 1024×1024 при 4×4 даёт 256 px на ячейку — мало. Нужно **2K** (2048×2048): `gemini_image_size_pack` = `"2K"`. |
| **Кредиты/оплата** | Стоимость пака и логика refund при assemble (N-1 и т.д.) привязать к 16. |
| **Документация** | Этот документ; обновить `pack-batch-flow-9-scenes-rules.md` (или вариант для 16); `docs/architecture/02-worker.md` (pack assemble / resize). |

---

## 3. База данных

- **Таблица:** `pack_content_sets.sticker_count` (уже есть, миграция 085, дефолт 9).
- **Новая миграция:**
  - Поменять дефолт на 16: `ALTER TABLE pack_content_sets ALTER COLUMN sticker_count SET DEFAULT 16;`
  - Опционально: один раз обновить существующие активные content sets на 16 или оставить старые паки с 9 (решение продукта).
- **Сиды** в `sql/packs/*.sql`: в новых сидах указывать `sticker_count: 16` (и 16 элементов в `labels` / `scene_descriptions` где они заданы).

---

## 4. Pack multiagent (`src/lib/pack-multiagent.ts`)

**Источник промптов:** заменить текущие промпты на текст из `docs/final-promt-16.md`.

### 4.1. Параметризация (рекомендация: параметр, не константа)

- Предпочтительно: **прокидывать `stickerCount` в `runPackGenerationPipeline`** из `template.sticker_count` (или опций), а не хардкодить 16. Это позволит иметь паки разного размера (9, 16) одновременно.
- Альтернатива: константа `PACK_STICKER_COUNT = 16` — проще, но менее гибко.

### 4.2. Brief & Plan

- Промпт из `docs/final-promt-16.md` — **16 моментов**, структура 4 блоков (1–4 Low-intensity, 5–8 Everyday, 9–12 Expressive, 13–16 Decisive).
- **Важно:** в финальных промптах **убрано ограничение 600 символов** на JSON — можно не увеличивать лимит.
- Anti-Postcard: «At least 3 moments» (было 2 для 9).
- Holiday: «At least HALF of scenes» = 8 из 16.

### 4.3. Captions

- 16 подписей; структура 4 блоков (1–4 calm, 5–8 conversational, 9–12 expressive, 13–16 decisive).
- «At least 3 captions must be non-hesitant and final».
- «Do NOT use hesitation words in more than half of captions».
- `slice(0, 9)` → `slice(0, 16)`; валидация на 16.

### 4.4. Scenes

- 16 сцен; структура 4 блоков (1–4 minimal movement, 5–8 everyday gestures, 9–12 stronger body language, 13–16 resolved posture).
- «Do NOT reuse the same posture across blocks».
- `slice(0, 9)` → `slice(0, 16)`; валидация на 16.

### 4.5. Critic — Structural Check (НОВОЕ)

В финальных промптах Critic проверяет **наличие всех 4 эмоциональных блоков**:

- Low-intensity (1–4)
- Everyday (5–8)
- Expressive (9–12)
- Decisive / closure (13–16)

**Fail если:** flat intensity по всем 16; финальный блок без confident/resolved реакций; сцены повторяют позу между блоками.

### 4.6. parseCriticIndices и rework

- **toZeroBased:** диапазон 1..9 / 0..8 → **1..16 / 0..15**.
- **Partial rework limit:** сейчас `captionIndices.length <= 6` и `sceneIndices.length <= 6`. Для 16 стикеров: 6 из 16 = 37%. Рекомендация: поднять до **10** (или оставить 6 — решать по тестам).
- **Блоки в feedback:** Critic может вернуть «blocks 9–12 need more expressive body language». Добавить парсинг диапазонов `(\d+)\s*[-–]\s*(\d+)` → развернуть в индексы (например «9–12» → [8,9,10,11] 0-based). Опционально в первой итерации.

### 4.7. assembleSpec и specToMinimalPlan

- `sticker_count: 9` → `sticker_count: 16` (или из параметра).
- `labels.length >= 9` → `>= 16`; `Array(9).fill("moment")` → `Array(16).fill("moment")`.

---

## 5. Worker (`src/worker.ts`)

**Примечание:** промпт генерации сетки пака (PackPreview) — в `worker.ts`, не в `docs/final-promt-16.md`. Финальные промпты покрывают только multiagent (Brief, Captions, Scenes, Critic).

- **Превью пака (PackPreview):**
  - Размер сетки уже берётся из `template.sticker_count` (cols/rows через `Math.ceil(Math.sqrt(stickerCount))` и т.д.) — менять не нужно.
  - В промпте есть жёсткая фраза про «between the **9** images» (около строки 654): заменить на переменную по `stickerCount`, например «between the **${stickerCount}** images» в шаблоне.
- **Сборка (PackAssemble):**
  - Ячейки считаются из `template.sticker_count` и размеров листа (`sheetW`, `sheetH`) — уже универсально для 4×4.
  - Resize после rembg: `fitStickerIn512WithMargin` вызывается на каждую ячейку — без изменений логики.
- **Разрешение листа:** в конфиге приложения задать `gemini_image_size_pack` = `"2K"` (2048×2048), чтобы при 4×4 каждая ячейка была 512×512 px и не было апскейла 256→512. См. раздел 7.

---

## 6. Разрешение листа (1024 vs 2K vs 4K)

- **1024×1024 при 4×4:** ячейка 256×256 px → в финале стикер 512×512 получается из 256 px детали → мягко/мыльно.
- **2048×2048 (2K) при 4×4:** ячейка 512×512 px → после `fitStickerIn512WithMargin` лёгкий даунскейл до ~460 px в контенте — **достаточно для качества**.
- **4096×4096 (4K):** не обязательно; у API Gemini часто только 1K/2K; 2K достаточно.

**Итог:** переключить генерацию листа пака на **2K** (`gemini_image_size_pack` = `"2K"`). 4K не требуется.

---

## 7. Resize после rembg (кратко)

Флоу без изменений:

1. Лист (например 2048×2048) скачивается; `sheetW` / `sheetH` из метаданных (или fallback 1024).
2. Сетка: `cols = ceil(sqrt(sticker_count))`, `rows = ceil(sticker_count / cols)`; для 16 → 4×4.
3. Ячейки режутся: `cellW = sheetW / cols`, `cellH = sheetH / rows`; каждая ячейка — rembg (и при необходимости fallback на другой сервис).
4. Для каждой ячейки: `fitStickerIn512WithMargin(cellBuf, 0.05)` → 512×512; затем подпись и белая обводка.

Изменение только в размере листа (2K), не в логике нарезки или фита.

**Почему 2K обязательно:** `fitStickerIn512WithMargin` использует `resize` без `withoutEnlargement`. При 1K (ячейка 256×256) sharp апскейлит до ~460 px → мягко. При 2K (ячейка 512×512) — даунскейл 512→460 → резкость сохраняется.

---

## 8. Кредиты и оплата

- Стоимость пака (сколько кредитов списывается за превью и за сборку) привести в соответствие с 16 стикерами (продуктовое решение).
- Refund при провале assemble: сейчас `assembleRefundAmount = Math.max(0, stickerCount - 1)` — остаётся корректным при `sticker_count = 16`.

---

## 9. Существующие паки

- **Вариант A:** только новые паки создаются с 16; старые content sets остаются с 9 (миграция не трогает существующие строки).
- **Вариант B:** однажды обновить все активные content sets на 16 и перегенерировать контент (сложнее, нужна отдельная задача).

В первой итерации разумно **Вариант A**; в миграции — только смена дефолта и при необходимости явное проставление 16 в новых сидах.

---

## 10. Чеклист внедрения

- [ ] Миграция: дефолт `pack_content_sets.sticker_count` = 16; при необходимости сиды.
- [ ] `pack-multiagent.ts`: промпты из `docs/final-promt-16.md`; параметр/константа 16; все `slice(0, 9)` → `slice(0, 16)`; `toZeroBased` 1..16; partial rework limit; опционально парсинг блоков в parseCriticIndices.
- [ ] `worker.ts`: в промпте превью «9» → переменная по `stickerCount`; `gemini_image_size_pack` = `"2K"`.
- [ ] Конфиг/приложение: ключ `gemini_image_size_pack` = `"2K"` (в БД или env).
- [ ] Кредиты: обновить логику стоимости пака под 16.
- [ ] Документация: обновить `pack-batch-flow-9-scenes-rules.md` (или добавить раздел для 16 сцен); обновить `docs/architecture/02-worker.md`; обновить `docs/pack-multiagent-prompts-current.md` на финальные промпты.

---

## 11. Порядок внедрения (рекомендация)

1. **Сначала:** проверить 2K на тесте — выставить `gemini_image_size_pack` = `"2K"` в `app_config`, сгенерировать 2–3 пака с 9 стикерами, убедиться что API поддерживает и качество ОК.
2. **Затем:** код multiagent — промпты из `docs/final-promt-16.md`, параметризация, `toZeroBased`, slices.
3. **Затем:** миграция дефолта `sticker_count` = 16.
4. **Затем:** worker — промпт «9» → `${stickerCount}`.
5. **Тест:** 5 паков с 16 стикерами на тесте; оценить likeness, консистентность стиля, работу Critic Structural Check.
6. **Последнее:** кредиты/прайсинг, прод.

---

## 12. Риски

- **Качество:** без перехода на 2K при 16 стикерах качество будет низким (256 px на ячейку). Обязательно включить 2K.
- **Лимиты API:** проверить, что Gemini поддерживает `imageSize: "2K"` и возвращает 2048×2048.
- **Размер payload:** лист 2K больше 1K — лимиты на размер ответа и время обработки.
- **Генерация 16 в одном вызове:** сложнее держать likeness и консистентность стиля, чем для 9. При деградации — рассмотреть два листа по 8 (отдельная задача).
- **Critic Structural Check:** новая проверка может чаще фейлить паки; мониторить rate rework/fail после внедрения.

---

## 13. Рекомендации из финальных промптов (`docs/final-promt-16.md`)

| Аспект | Что в промптах | Импликация для кода |
|-------|----------------|---------------------|
| **4 блока** | Brief, Captions, Scenes, Critic — все используют 1–4, 5–8, 9–12, 13–16 | Валидация и rework должны понимать блоки; Critic может фейлить по блокам |
| **Anti-Postcard** | At least 3 moments | Уже в промпте; Critic проверяет |
| **Hesitation words** | Do NOT use in more than half of captions | Новое правило Captions; Critic может фейлить |
| **Non-hesitant final** | At least 3 captions must be non-hesitant and final | Новое правило Captions |
| **Posture across blocks** | Do NOT reuse the same posture across blocks | Scenes + Critic; «Fail if scenes repeat posture across blocks» |
| **JSON limit** | Убрано «600 characters» | Не нужно увеличивать лимит в коде |
