# Анализ флоу генерации стикеров: пак в стиле фото-реализм

**Дата:** 18.02.2025  
**Контекст:** проблемы — стикеры большие, часто есть обводка, при вырезании фона обводка страдает; на одних «пресетах» обводки нет, на других есть.

**Уточнение:** пользователь генерировал **только паки** стикеров. Одиночный флоу (один стикер → смена стиля/эмоции/движения) не использовался. Поэтому «по каждой генерации эмоции» здесь = по разным **сценам/контенту внутри пака** (content set: support, everyday, sass, humor, reactions и т.д.), а не пресеты happy/sad/angry из single flow.

---

## 1. Идентификация твоих сессий в логах

- **Твой пользователь (админ):** `chat_id` / `telegram_id` = **42269230**
- В логах твои паки видны по имени: `p2s_pack_42269230_*` (например `p2s_pack_42269230_1771353688_by_photo_2_stickerbot`).
- Другие пользователи: например `2103423537` (p2s_pack_2103423537_*).

**Файлы логов:**
- `docs/logs/c327532a-0a58-45d8-86fa-7904d890f22f.log` — в основном **PackPreview** и **PackAssemble** (пак целиком).
- `docs/logs/4faf714f-6b68-4e58-81a0-d05310901d26.log` — есть записи **runJob** с `generationType: style` (одиночный стикер), но **нет** записей `generationType: emotion`.

Вывод: пользователь использовал **только пак** (PackPreview → PackAssemble). Одиночных генераций стиля/эмоции не было. В логах только:
1. **Пак (фото-реализм):** PackPreview (лист 3×3) → PackAssemble (нарезка, Pixian, подписи, создание стикерпака).

---

## 2. Флоу пака в стиле фото-реализм (как он устроен)

### 2.1 PackPreview (генерация листа)

- **Вход:** фото пользователя, `session.prompt_final` из БД (стиль «фото реализм» + subject lock при необходимости), выбранный content set (support, everyday, sass, humor, reactions и т.д.).
- **Промпт собирается так:**
  - `styleBlockWithSubject` = `session.prompt_final` (то же, что и для одиночного стикера: стиль + subject lock + composition rules, если они уже в prompt_final).
  - К нему добавляется **packTaskBlock** — правила сетки и сцен.

Фрагмент из кода (worker.ts):

```text
[TASK — PACK GRID ONLY]
Create a 3x3 grid sticker sheet (9 stickers total).
Each cell = ONE sticker with a DISTINCT pose/emotion from the list below.
...
CRITICAL RULES FOR THE GRID:
1. Background MUST be flat uniform BRIGHT MAGENTA (#FF00FF) in EVERY cell.
2. Each character must be fully visible within its cell ...
3. Leave at least 15% padding on every side of the character ...
4. Do NOT draw any visible lines, borders, or grid between cells. ...
5. Style must be IDENTICAL across all cells ...
6. Do NOT add any text, labels, or captions to the stickers.
```

Если используется **коллаж** (reference sticker pack), добавляется:

```text
Match its visual style (rendering, outline, proportions, colors).
```

- **Выход:** один лист 1024×1024 (9 ячеек), отправляется как превью; сохраняется `pack_sheet_file_id`.

### 2.2 PackAssemble (сборка пака)

- Скачивается лист, режется на ячейки **341×341** (при 9 стикерах — сетка 3×3).
- Для каждой ячейки: **Pixian** (или rembg) — удаление фона по маске.
- На каждый результат без фона накладывается **подпись** из content set (`addTextToSticker`).
- `addTextToSticker` делает **resize(512, 512, { fit: "contain" })** и отдаёт WebP → финальный размер стикера в паке **512×512**.
- **Белая обводка (addWhiteBorder) в пайплайне пака не вызывается** — только кнопка «Обводка» для одиночного стикера в боте.

---

## 3. Откуда берётся «обводка» и почему она страдает

### 3.1 Источник обводки

- В **паке** обводка не добавляется кодом: ни в PackPreview, ни в PackAssemble.
- Значит видимая обводка — это то, что **нарисовал Gemini** (контур/outline вокруг персонажа как часть картинки).
- В **single-sticker** промпте явно есть правило (COMPOSITION_SUFFIX в index.ts):  
  `Do NOT add any border, outline, stroke, or contour around the character. Clean raw edges only.`  
  Оно попадает в `session.prompt_final`, если пользователь шёл через обычный флоу выбора стиля (и этот суффикс был добавлен к стилю).
- В **pack** промпте:
  - Правило 4 говорит только: **не рисовать линии/сетку между ячейками**, а не «никакого контура вокруг персонажа».
  - Отдельного жёсткого «no outline around character» в **packTaskBlock** нет.
  - При использовании **коллажа** мы явно пишем: «Match its visual style (rendering, **outline**, proportions, colors)» — то есть можем **подталкивать модель к обводке**, если в референсе она есть.

Итог: в паковом промпте нет такого же жёсткого запрета контура, как в одиночном стикере, плюс при коллаже мы просим повторить outline → модель может рисовать обводку; при вырезании фона она «страдает».

### 3.2 Почему при вырезании фона обводка страдает

- Pixian/rembg строят **маску фона/объекта** по изображению.
- Всё, что модель нарисовала (включая контур вокруг человека), — это пиксели; маска может:
  - отнести тонкую обводку к «фону» и вырезать её, или
  - обрезать по резкой границе и «срезать» часть обводки.
- В итоге контур получается рваным или пропадает.

### 3.3 Почему «на одних пресетах есть обводка, на других нет»

В паке нет пресетов эмоций в смысле кнопок «Радуюсь / Грустный / Злой». Вместо них используются **сцены из content set** (scene_descriptions и labels), например:

- support: «Мой герой», «Вместе справимся», «Горжусь» …
- everyday: «Спим?», «Где еда?», «Устал» …
- sass: «Ага конечно», «Ну да», «Всё ясно» …

Разница в «обводке» между стикерами одного пака скорее всего из-за:

1. **Разных сцен** — модель по-разному интерпретирует сцену (более «графичный» контур в одних ячейках, более мягкий рендер в других).
2. **Коллажа** — если для пака задан reference pack с обводкой, строка «Match … outline …» может давать обводку не на всех ячейках одинаково.
3. **Случайности генерации** — одна и та же инструкция без явного «no outline» даёт разный результат по ячейкам.

---

## 4. Примеры из логов (только твои сессии — 42269230)

Все ниже — **PackPreview** для фото-реализма; полный промпт в логах обрезан (первые 400 символов).

| Время (UTC)     | Content set | Длина prompt_final | Фрагмент промпта (стиль) |
|-----------------|------------|--------------------|---------------------------|
| 2026-02-17 14:49 | support   | 1620               | Photo-realistic style: high-quality photograph, natural lighting, realistic sk... |
| 2026-02-17 15:06 | humor    | 1620               | Photorealistic style - high-quality photograph, natural lighting, realistic sk... |
| 2026-02-17 15:07 | everyday | 1615               | Photorealistic, high-quality photograph, natural lighting, realistic skin, hai... |
| 2026-02-17 16:01 | sass     | 1622               | Photorealistic, like a high-quality photograph. Natural lighting, realistic sk... |
| 2026-02-17 16:14 | humor    | 1563               | Photorealistic, resembling a high-quality photograph with natural lighting, re... |
| 2026-02-17 16:27 | reactions| 1620               | Photo-realistic style: high-quality photograph, natural lighting, realistic sk... |
| 2026-02-17 16:31 | reactions| 1439               | Photorealistic photograph. LIKENESS — Preserve the person's recognizable iden... |
| 2026-02-17 16:34 | reactions| 1428               | Photorealistic. LIKENESS — Preserve the person's recognizable identity from t... |
| 2026-02-17 16:35 | reactions| 1428               | Photorealistic. LIKENESS — Preserve the person's recognizable identity from t... |
| 2026-02-17 18:40 | sass     | 1593               | Photo-realistic style, natural lighting, realistic skin, hair and fabric textur... |
| 2026-02-17 20:38 | humor    | 1708               | Photo-realistic style: high-quality photograph, natural lighting, realistic sk... |
| 2026-02-18 06:38 | humor    | 1708               | (то же) |
| 2026-02-18 06:57 | humor    | 1435               | Photo-realistic style. LIKENESS — Preserve the person's recognizable identity... |
| 2026-02-18 06:59 | humor    | 1428               | Photorealistic. LIKENESS — Preserve the person's recognizable identity from t... |
| 2026-02-18 07:06 | …        | 1619               | … |
| 2026-02-18 07:11 | …        | 1580               | … |
| 2026-02-18 07:17 | …        | 1621               | … |
| 2026-02-18 07:21 | …        | 1621               | … |
| 2026-02-18 07:22 | …        | 1621               | … |

Замечание: при более коротком prompt_final (например 1428–1439) формулировка стиля короче («Photorealistic.» / «Photorealistic photograph.») и идёт блок LIKENESS. Разная длина может соответствовать разным версиям/источникам prompt_final (например, другой конфиг или другой состав правил). От этого тоже может зависеть, попал ли в промпт пункт «no border/outline» или нет.

---

## 5. Размер стикеров («очень большие»)

- Ячейка после нарезки: **341×341** px (с отступами вокруг персонажа, фон магента).
- **Вырезание фона (Pixian/rembg):** сервис возвращает изображение, обрезанное по контуру объекта — **отступы (прозрачные области) отбрасываются**. На выходе не 341×341, а плотный кроп без полей (например 200×280 или 250×300).
- Раньше дальше шёл сразу **addTextToSticker** с `resize(512, 512, { fit: "contain" })` — отступов не восстанавливали, персонаж заполнял весь кадр. Сейчас перед подписью вызывается **fitStickerIn512WithMargin(cellBuf, 0.05)**: контент вписывается в 512×512 с отступом 5% по краям, затем накладывается подпись.

**Почему они выглядят такими большими:** не из‑за одного только апскейла 341→512, а из‑за того, что при вырезании фона **убрались наши отступы**. Мы ресайзим в новое разрешение, но отступов уже нет — персонаж заполняет кадр.

**Реализованное решение:** после BG removal каждая ячейка пропускается через **`fitStickerIn512WithMargin(buffer, 0.05)`** (см. `src/lib/image-utils.ts` и `runPackAssembleJob` в worker): контент вписывается в область с отступом 5% по краям и центрируется в 512×512. Так по краям финального разрешения остаётся ~5% свободного места, остальное занимает стикер.

---

## 6. Рекомендации

### 6.1 Обводка

1. **Добавить в packTaskBlock** (worker.ts) явное правило, как в single-sticker:
   - «Do NOT add any border, outline, stroke, or contour around the character. Clean raw edges only.»
2. **При использовании коллажа** переформулировать:
   - убрать или заменить слово «outline» в «Match its visual style (rendering, outline, proportions, colors)», например: «Match its visual style (rendering, proportions, colors). Do not add outlines or strokes around the character.»

### 6.2 Размер / композиция

- Усилить в packTaskBlock правило про отступы, например: «Leave at least 20% padding on every side» или «Draw the character small enough that there is clear empty margin on all sides (at least 15–20%).»
- При необходимости добавить: «Prefer slightly smaller character with more margin over filling the whole cell.»

### 6.3 Логирование

- Пользователь генерировал только паки; одиночный флоу (стиль/эмоция по одному стикеру) не использовался.
- «По каждой генерации эмоции» в контексте пака = по разным **сценам** в листе (scene_descriptions из content set). Одна генерация = один лист 3×3; в логах виден один общий промпт на весь лист, а не отдельный промпт на каждую ячейку. Разница обводки между ячейками — из-за разного контента сцен и интерпретации модели.

---

## 7. Кратко

| Вопрос | Ответ |
|--------|--------|
| Где в логах твои сессии? | `chat_id` **42269230**, паки `p2s_pack_42269230_*`. |
| Использовался ли одиночный флоу (стиль/эмоция)? | Нет, только пак. В логах — PackPreview/PackAssemble и в другом файле runJob style (другие пользователи). |
| Какой финальный промпт у пака? | `session.prompt_final` (стиль + subject lock + composition, если есть) + packTaskBlock (сетка, сцены, магента, 15% padding, no lines between cells, no text). При коллаже + «Match … outline …». |
| Почему есть бордер? | Его рисует Gemini; в pack-промпте нет жёсткого «no outline», при коллаже мы просим «outline». |
| Почему на одних сценах есть, на других нет? | Разные сцены (content set) и случайность; при коллаже — разная интерпретация «outline» по ячейкам. |
| Почему при вырезании фона страдает? | Pixian/rembg режут по маске; нарисованная обводка может попадать в фон или срезаться по границе. |
| Размер стикеров | Финально 512×512; ощущение «очень большие» из-за крупного персонажа в ячейке — усилить правило про padding. |

---

## 8. Точная реализация (что сделать)

Ниже — конкретные шаги по коду для решения трёх задач: убрать обводку от Gemini, добавить программную обводку в воркере, зафиксировать отступы 5%.

---

### 8.1 Убрать обводку от Gemini

**Цель:** чтобы модель не рисовала контур/outline вокруг персонажа (он потом страдает при вырезании фона).

**Файл:** `src/worker.ts`

**1) В блоке `packTaskBlock`** (константа с правилами сетки, ~стр. 596–614) добавить отдельное правило про контур персонажа. После пункта 4 (Do NOT draw any visible lines, borders, or grid **between cells**) добавить пункт 4a или вставить явную фразу в конец CRITICAL RULES:

- Текст: **«Do NOT add any border, outline, stroke, or contour around the character. Clean raw edges only.»**

Конкретно: в строке с правилом 4 идёт «No separator lines.» — после неё добавить новое правило, например:

```text
4. Do NOT draw any visible lines, borders, or grid between cells. ...
5. Do NOT add any border, outline, stroke, or contour around the character(s). Clean raw edges only. The image will be background-removed; no hand-drawn outline.
6. Style must be IDENTICAL across all cells ...
7. Do NOT add any text, labels, or captions to the stickers.
```

(Нумерацию правил 5→6, 6→7 сдвинуть.)

**2) При использовании коллажа** (строка ~618): убрать слово **outline** из фразы про reference style, чтобы не просить модель копировать обводку.

- Было: `Match its visual style (rendering, outline, proportions, colors).`
- Стало: `Match its visual style (rendering, proportions, colors). Do not add outlines or strokes around the character.`

Итог: в промпте PackPreview явно запрещена обводка вокруг персонажа и не подталкиваем к ней при коллаже.

---

### 8.2 Вернуть программную обводку от воркера (rembg/Pixian)

**Цель:** после вырезания фона добавлять белую обводку программно (как в одиночном стикере по кнопке «Обводка»), чтобы контур был ровным и не зависел от генерации.

**Файл:** `src/worker.ts`

**1) Импорт:** добавить `addWhiteBorder` в импорт из `./lib/image-utils`:

```ts
import { addTextToSticker, fitStickerIn512WithMargin, addWhiteBorder } from "./lib/image-utils";
```

**2) В цикле обработки ячеек в `runPackAssembleJob`** (после `fitStickerIn512WithMargin` и подписи) применить белую обводку перед добавлением буфера в `stickerBuffers`.

Текущий порядок:

1. `fitStickerIn512WithMargin(cellBuf, 0.05)`  
2. при наличии label — `addTextToSticker(processed, label, "bottom")`  
3. `stickerBuffers.push(processed)`

Новый порядок:

1. `fitStickerIn512WithMargin(cellBuf, 0.05)`  
2. при наличии label — `addTextToSticker(processed, label, "bottom")`  
3. **`processed = await addWhiteBorder(processed)`** (по умолчанию borderWidth = 8, при необходимости передать вторым аргументом)  
4. `stickerBuffers.push(processed)`

Так в пайплайне пака стикеры получают ту же программную обводку, что и одиночные по кнопке «Обводка».

---

### 8.3 Изменить флоу генерации стикера для отступов 5%

**Цель:** по краям финального 512×512 оставлять ~5% свободного места, остальное — контент стикера.

**Уже сделано.** Менять ничего не нужно.

**Где реализовано:**

- **Файл:** `src/lib/image-utils.ts`  
  - Функция **`fitStickerIn512WithMargin(inputBuffer, marginRatio?)`**: вписывает контент в область `512 * (1 - 2*marginRatio)` по центру холста 512×512. По умолчанию `marginRatio = 0.1`; для пака передаётся `0.05`.

- **Файл:** `src/worker.ts`, `runPackAssembleJob`  
  - После получения ячеек без фона (`noBgCells`) для каждой ячейки первым шагом вызывается:
    - **`fitStickerIn512WithMargin(cellBuf, 0.05)`**
  - Дальше при необходимости накладывается подпись (`addTextToSticker`), затем (по п. 8.2) — `addWhiteBorder`.

**Порядок в пайплайне пака (итоговый):**

1. Нарезка листа на ячейки 341×341  
2. Вырезание фона (Pixian/rembg)  
3. **fitStickerIn512WithMargin(cellBuf, 0.05)** — отступы 5%  
4. addTextToSticker(processed, label) — подпись  
5. **addWhiteBorder(processed)** — программная обводка (после реализации п. 8.2)  
6. Отправка буфера в Telegram sticker set
