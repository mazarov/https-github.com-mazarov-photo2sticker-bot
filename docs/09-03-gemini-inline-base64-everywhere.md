# 09-03 Gemini Inline Base64 Everywhere

## Goal

Вернуть единый транспорт входных изображений для Gemini: во всех местах отправлять фото/стикер через `inlineData` (`base64`), а не через `fileData.fileUri`.

Цель: убрать зависимость от публичных URL источников и исключить ошибки Gemini вида `Cannot fetch content from the provided URL`.

## Why Now

Сейчас в коде смешаны два подхода:

- часть вызовов Gemini получает изображение по `fileUri`;
- часть уже использует `inlineData`.

Из-за этого появляются дополнительные ветки логики (temp upload, проверка публичной доступности URL, fallback'и по транспорту), а поведение отличается между flow.

## Source Of Truth

Единый контракт для image input в Gemini:

- входное изображение всегда передаётся как:
  - `inlineData.mimeType`
  - `inlineData.data = Buffer.toString("base64")`
- `fileData.fileUri` не используется для пользовательских фото/стикеров.

Важно: это изменение касается только транспорта input image в Gemini. Бизнес-правила цепочки генерации не меняются.

## Scope

В scope:

1. Перевести все image-вызовы Gemini в `src/` на `inlineData`.
2. Удалить Gemini-специфичные зависимости от публичных URL для source image.
3. Обновить debug-логи (транспорт = `inlineData`) и архитектурную документацию.
4. Прогнать тестовый чеклист в окружении `test`.

Вне scope:

- изменение моделей Gemini;
- изменение прокси-маршрутизации (`gemini_use_proxy`, `GEMINI_PROXY_BASE_URL`) для самого HTTP endpoint;
- изменение бизнес-логики style/emotion/motion/text/replace_subject.

## Current Code Points To Change

Найденные места с `fileData.fileUri` (Gemini input image):

1. `src/worker.ts`
   - pack preview: collage/photo image parts;
   - replace_subject background analysis;
   - single generation request (source + replace reference).
2. `src/index.ts`
   - fallback Gemini для pack ideas.
3. `src/lib/subject-profile.ts`
   - detector сейчас условно выбирает `fileData` при наличии `sourceFileUrl` и `inlineData` иначе.

Итого: 6 фактических точек отправки image input.

## Detailed Implementation

### 1) Ввести общий helper для Gemini image part

Добавить helper (например `src/lib/gemini-image-part.ts`):

```ts
export function buildInlineImagePart(buffer: Buffer, mimeType: string) {
  return {
    inlineData: {
      mimeType,
      data: buffer.toString("base64"),
    },
  };
}
```

Требования:

- helper не должен мутировать буфер;
- `mimeType` передаётся фактический (`image/jpeg`, `image/png`, `image/webp`);
- helper используется везде, где в Gemini отправляется изображение.

### 2) Worker: pack preview -> inlineData

Файл: `src/worker.ts` (`runPackPreviewJob`)

Что меняем:

- вместо `imageParts.push({ fileData: { ... fileUri } })` использовать `inlineData` с уже загруженными буферами collage/photo;
- если для collage/photo буфер не получен — падать с явной ошибкой до вызова Gemini.
- для ветки `template.collage_url` обязательно:
  - скачать `collage_url` в `Buffer`,
  - определить `mimeType` по `Content-Type` (fallback: расширение URL),
  - отправлять в Gemini как `inlineData` (не передавать URL в `fileData`).

Что можно удалить/упростить:

- ветки, которые существуют только ради подготовки публичного URL для Gemini input;
- проверки доступности URL (`waitForPublicUrlReady`) в части, относящейся только к input image.

### 3) Worker: single generation -> inlineData

Файл: `src/worker.ts` (`callGeminiImage`)

Что меняем:

- source image part:
  - `fileData.fileUri` -> `inlineData` из `fileBuffer`;
- для `replace_subject` reference image:
  - `fileData.fileUri` -> `inlineData` из `replaceReferenceBuffer`.

Обновление логов:

- в `requestImagePayload` заменить:
  - `transport: "fileData"` -> `transport: "inlineData"`;
  - добавить признак `base64BytesApprox` (длина base64 строки) для диагностики;
  - не логировать полный base64 payload.

### 4) Worker: replace_subject background analysis -> inlineData

Файл: `src/worker.ts` (анализ `bgDescription`)

Что меняем:

- анализ исходного стикера для reconstruction должен передавать изображение через `inlineData` из `fileBuffer`, без `sourceFileUrl`.

### 5) API Bot: Gemini fallback pack ideas -> inlineData

Файл: `src/index.ts`

Что меняем:

- в fallback-вызове Gemini (`gemini-2.5-flash`) заменить image part на `inlineData` из уже скачанного source buffer.

### 6) Subject detector: всегда inlineData

Файл: `src/lib/subject-profile.ts`

Что меняем:

- убрать условную отправку `fileData` по `sourceFileUrl`;
- всегда отправлять `inlineData` из `imageBuffer`.

Что упрощается:

- сигнатуру можно оставить обратносуместимой (`sourceFileUrl?`), но параметр больше не участвует в Gemini payload;
- в следующем шаге (необязательно в этом PR) можно удалить неиспользуемый `sourceFileUrl` из API detector'а.

## Architecture Check

Fix type: `architectural`

Почему:

- проблема не локальна одному хендлеру; одинаковый дефектный паттерн (`fileUri` для user image) присутствует в нескольких flow (`single`, `replace_subject`, `pack preview`, `pack ideas`, `subject detector`);
- правка делается в общем транспортном слое и унифицирует контракт.

Проверяемые flow после правки:

- `style`, `emotion`, `motion`, `replace_subject`;
- pack preview / pack assemble entry;
- detector pipeline (subject/age);
- идеи для пака (Gemini fallback).

## Test Plan (test env)

### A. Single flow

1. Фото -> `style`.
2. Из результата -> `emotion`.
3. Из результата -> `motion`.

Ожидание:

- генерации успешны;
- в логах Gemini transport = `inlineData`;
- нет ошибок `Cannot fetch content from the provided URL`.

### B. Replace subject

1. Взять стикер-референс.
2. Заменить лицо по фото пользователя.

Ожидание:

- успешный background analysis + финальная генерация;
- оба image input передаются как `inlineData`.

### C. Pack preview

1. Запустить preview с выбранным style preset.
2. Проверить сценарий с collage reference и без него.
3. Отдельно проверить вариант, когда reference задаётся через `template.collage_url` (не `collage_file_id`).

Ожидание:

- Gemini принимает запрос без URL-зависимостей;
- sheet генерируется стабильно.

### D. Detector

1. Загрузить фото пользователя.
2. Проверить, что subject/age profile заполняется как раньше.

Ожидание:

- детектор работает без `sourceFileUrl`;
- поведение child/adult policy не регрессит.

### E. Regression checks

- `text` generation flow не меняется (Gemini image call не используется);
- маршрутизация direct/proxy для Gemini endpoint остаётся рабочей.

## Risks And Mitigations

1. Рост размера HTTP body (base64 +33%)
   - оставить текущие timeout/retry;
   - при необходимости поднять лимиты прокси (`client_max_body_size`) и логировать request size.

2. Память процесса на больших входах
   - не держать дубли буфера дольше нужного;
   - переиспользовать уже загруженные буферы без лишних копий.

3. Логирование чувствительных данных
   - не писать base64 в логи;
   - логировать только размеры, mime и hash.

## Rollout

1. Ветка: feature-ветка для задачи.
2. Деплой в `test`.
3. Smoke по чеклисту выше.
4. После подтверждения — merge в `main`.

## Done Criteria

- В `src/` не осталось `fileData.fileUri` для отправки пользовательских изображений в Gemini.
- Все целевые flow в `test` проходят без URL-fetch ошибок.
- Логи показывают единый транспорт `inlineData`.
- Обновлены соответствующие документы архитектуры:
  - `docs/architecture/02-worker.md`
  - `docs/architecture/01-api-bot.md`
  - `docs/architecture/07-libs.md`
