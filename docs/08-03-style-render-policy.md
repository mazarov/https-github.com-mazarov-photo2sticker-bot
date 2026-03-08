# Style Render Policy (универсальная стилизация + photoreal)

## Цель

Устранить проблему, когда при выборе стилевого пресета (например, `chibi`, `manhwa`) результат визуально остается в исходном рендере.
Одновременно сохранить корректное поведение для фотореалистичных пресетов, где важно не рисовать, а оставаться в photo-режиме.

## Проблема

Сейчас `style`-генерация использует:
1. `prompt_hint` выбранного стиля -> `generatePrompt()`
2. `applySubjectLockToPrompt()` (identity/count lock)
3. `COMPOSITION_SUFFIX`

В `SUBJECT LOCK` есть формулировки типа `Keep the same identity/appearance...`, которые модель иногда трактует как "сохраняй исходный художественный рендер".
В итоге стиль меняется слабо или почти не меняется.

## Требования

### Функциональные

1. Для художественных стилей (`chibi`, `manhwa`, `cartoon`, etc.) результат должен явно перерисовываться в целевой стиль.
2. Для фотореалистичного режима результат должен сохранять photo-реализм без иллюстративной стилизации.
3. Поведение должно быть единообразным во всех flow, где используется `generationType="style"`.

### Нефункциональные

1. Не ломать текущий пайплайн `emotion/motion/text/replace_subject`.
2. Сохранить совместимость со старыми пресетами (без новой колонки).
3. Не ухудшить контроль `subject_count` и identity lock.

## Принятые архитектурные решения

1. `custom style` удаляется из кода (деприкация с полным отключением flow).
   - Пользователь больше не вводит стиль свободным текстом в single style flow.
   - Вход в генерацию стиля только через preset-style.
2. `render_mode` распространяется на pack flow.
   - Если в pack выбран style preset, его `render_mode` обязан учитываться при генерации pack preview/pack assemble.
3. В pack и single flow поведение должно быть одинаковым:
   - `stylize` -> явная перерисовка в художественный стиль.
   - `photoreal` -> сохранение фотореализма без "рисовки".

## Архитектурное решение (source of truth)

Добавить единый слой style policy в сборку prompt перед запуском генерации.

### Новый концепт: `render_mode`

Для каждого style preset вводится режим:
- `stylize` — художественная перерисовка
- `photoreal` — фотореализм, без "рисовки"

### Где применяется

В общем пути `style_v2 -> startGeneration(...)` (и других входах в style), а не в отдельных callback-хендлерах.
Policy должен применяться централизованно в `startGeneration`/helper.

## Изменения в данных

### БД: `style_presets_v2`

Добавить колонку:
- `render_mode text not null default 'stylize'`
- check: `render_mode in ('stylize','photoreal')`

### Миграция

Новый файл (не менять старые):
`sql/126_style_presets_render_mode.sql`

Пример:

```sql
ALTER TABLE style_presets_v2
ADD COLUMN IF NOT EXISTS render_mode text NOT NULL DEFAULT 'stylize';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'style_presets_v2_render_mode_check'
  ) THEN
    ALTER TABLE style_presets_v2
    ADD CONSTRAINT style_presets_v2_render_mode_check
    CHECK (render_mode IN ('stylize', 'photoreal'));
  END IF;
END $$;
```

## Изменения в коде

### 1) Типы и загрузка пресета

Файл: `src/index.ts` (где `StylePresetV2`/`getStylePresetV2ById`)

- добавить поле `render_mode?: "stylize" | "photoreal"` в тип пресета
- при чтении пресета использовать fallback:
  - если null/unknown -> `"stylize"`

### 2) Новый helper style-policy

Добавить helper (например в `src/lib/style-policy.ts` или рядом с prompt helpers):

```ts
type RenderMode = "stylize" | "photoreal";

function buildRenderModePolicy(mode: RenderMode): string {
  if (mode === "photoreal") {
    return `[RENDER MODE: PHOTOREAL]
Keep photorealistic rendering.
Do NOT convert to illustration, cartoon, anime, manga, manhwa, chibi, 3D toon, or painterly style.
Preserve natural skin texture, realistic lighting, camera-like details, and photo-like material appearance.`;
  }

  return `[RENDER MODE: STYLIZE]
Apply STRONG style transfer to the target style.
Keep identity (facial features/person) but DO NOT preserve source artistic rendering.
Re-render the image fully in the target style language (linework, shading, proportions, color treatment).`;
}
```

### 3) Встраивание policy в prompt pipeline

В `startGeneration` перед `applySubjectLockToPrompt`:

- если выбран preset-style:
  1. определить `render_mode` из выбранного пресета
  2. добавить `buildRenderModePolicy(render_mode)` к prompt

Порядок сборки prompt рекомендован:
1. render policy block
2. style prompt (из `generatePrompt`)
3. subject lock
4. composition suffix

## Деприкация custom style (спецификация, без реализации в этой задаче)

### Цель

Убрать весь пользовательский текстовый ввод стиля и связанные ветки состояний, чтобы:
- устранить размытые требования к стилю;
- упростить архитектуру style flow;
- гарантировать применение `render_mode` только через preset-style.

### Scope удаления

Удаляются/выключаются:
- состояния `wait_custom_style`, `wait_custom_style_v2`;
- callback-кнопки для "Свой стиль"/`btn.custom_style` и переходы в custom-style состояния;
- обработчики текста, которые запускали style generation из свободного пользовательского текста.

Сохраняются:
- preset-style flow;
- emotion/motion/text/replace_subject flow;
- pack style selection через presets.

### Изменения по слоям

1. **API/Router (`src/index.ts`)**
   - удалить переходы в `wait_custom_style*`;
   - удалить ветки text-handler для custom style;
   - в местах fallback при ошибках custom style заменить на возврат к списку preset styles.

2. **UI/Texts (`src/lib/texts.ts`)**
   - удалить/не использовать `btn.custom_style` и связанные подсказки custom style;
   - в UX оставить только выбор из preset styles.

3. **State model**
   - исключить `wait_custom_style*` из активных flow (включая recovery/fallback списки);
   - для старых сессий с этими state добавить safe migration в runtime:
     - при обнаружении `wait_custom_style*` переводить в `wait_style` и показывать preset keyboard.

### Совместимость и rollout

1. Сначала выкатывается код с runtime-migration старых state.
2. Затем удаляются UI-кнопки/тексты custom style.
3. В логах отдельно считать, сколько пользователей попало в auto-migrate из `wait_custom_style*`.

### Acceptance criteria

- Пользователь не может запустить custom style flow.
- Любая попытка попасть в legacy custom-style state корректно возвращает в `wait_style`.
- Генерация стиля работает только через presets и использует `render_mode`.

### 4) Уточнение SUBJECT LOCK

Файл: `src/lib/subject-profile.ts`, `buildSubjectLockBlock()`

Смягчить двусмысленность:
- заменить `Keep the same identity/appearance...` на:
  - `Keep the same person identity and key facial traits.`
  - `Do not preserve original artistic rendering if style instructions require re-rendering.`

Это снижает конфликт с `stylize` режимом.

Важно:
- Не менять базовый `SUBJECT LOCK` глобально для всех generation type.
- Новая формулировка должна добавляться только в style-контексте (или через style-specific policy block), чтобы не повлиять на `emotion/motion/replace_subject`.

### 5) Логирование для дебага

В `startGeneration`/worker добавить лог:
- `renderMode`
- `selected_style_id`
- hash/len final prompt

Опционально в worker:
- лог hash буфера перед `sendSticker` (например `sha1(stickerBuffer)`), чтобы проще доказать, что отправлен новый результат.

## Обратная совместимость

1. До применения миграции код не должен падать:
   - если `render_mode` нет -> использовать `stylize`.
2. Старые пресеты автоматически работают в `stylize`.
3. Для фотореалистичных пресетов вручную проставить `render_mode='photoreal'`.

## План заполнения данных

После миграции:
- обновить реалистичные пресеты:
  - `update style_presets_v2 set render_mode='photoreal' where id in (...);`
- остальные оставить `stylize`.

## Тест-план

### A. Stylize

1. Фото -> `chibi`
2. Фото -> `manhwa`
3. Фото -> `cartoon_telegram`

Ожидание: явная стилизация, не "как исходный рендер".

### B. Photoreal

1. Фото -> реалистичный пресет (`render_mode=photoreal`)

Ожидание: фотореализм, без cartoon/anime/manga.

### C. Платежный сценарий

1. style при 0 кредитов -> paywall -> оплата -> авто-продолжение
2. Проверить, что используется тот же `render_mode` и правильный стиль.

### D. Регрессии

- emotion/motion/text не меняют поведение
- replace_face цепочка без изменений
- pack flow учитывает `render_mode` так же, как single flow

## Риски и как их снизить

1. Слишком агрессивный stylize ломает узнаваемость
   -> оставить identity lock + явный текст "keep identity".
2. Photoreal все равно "рисует" на некоторых фото
   -> усилить photoreal policy + добавить few-shot в prompt_generator.
3. Конфликт policy и prompt_generator вывода
   -> policy добавлять как отдельный обязательный блок после генерации prompt.

## Критерий готовности (DoD)

1. Есть миграция `render_mode`.
2. В коде есть централизованный style policy.
3. Для `chibi/manhwa` стилизация заметно меняет рендер.
4. Для `photoreal` стиль остается фото-подобным.
5. Логи показывают `renderMode` в генерации.
6. Проверены сценарии оплаты с автопродолжением.
