# Требования: «Фото в стикер (free)» без удаления фона

**Статус:** реализовано в `src/index.ts` (`buildFreePhotoStickerWebp`, `runFreePhotoStickerFlow`)  
**Дата:** 05-04-2026

## 1. Цель

Изменить поведение бесплатного сценария **упаковки фото в Telegram-стикер** так, чтобы **не вызывалось удаление фона** (Pixian и любые аналоги): пользователь получает стикер с **тем же визуальным содержимым**, что и исходное фото, приведённое к формату стикера (размер, WebP, отступы).

## 2. As is / To be

| | **As is** | **To be** |
|---|-----------|-----------|
| Обработка | Скачивание файла → конвертация в PNG → **Pixian remove-background** → `sharp`: trim → resize → extend → WebP → `sendSticker` | Скачивание файла → **`sharp` только**: вписать изображение в холст стикера (без Pixian) → WebP → `sendSticker` |
| Прогресс-текст | «Убираю фон...» / «Removing background...» | Текст про **подготовку стикера**, без упоминания фона |
| Сообщение после успеха | «Фон удалён! Что дальше?» / «Background removed! What's next?» | Нейтральное: стикер **готов**, предложение следующего шага (без «фон удалён») |
| Ошибка | Про неудачное удаление фона | Про неудачную **подготовку/отправку стикера** |
| Кредиты / Gemini | Без изменений (бесплатно, без генерации) | Без изменений |

## 3. Область (scope)

### 3.1 Входит

Все вызовы общей функции **`runFreePhotoStickerFlow`** в `src/index.ts` (~3960–4068):

1. **Меню действий** — callback `action_photo_sticker` (кнопка с подписью вида «📸 Фото в стикер (free)» через `withFreeBadge` + `sendActionMenu`).
2. **Онбординг** — первое фото в состоянии `wait_photo`, когда автоматически вызывается тот же flow (`onboardingMode: true`).
3. **Legacy callback `action_remove_bg`** — обрабатывается в том же ветке `handleActionMenuCallback`, что и `photo_sticker`, и сейчас вызывает **ту же** `runFreePhotoStickerFlow`. После изменения оба пути получат **одинаковое** поведение «только репак».  
   - *Продуктовое примечание:* кнопки `action_remove_bg` в актуальном `sendActionMenu` нет; затронуты только старые сообщения/кэшированные клавиатуры, если они ещё встречаются.

### 3.2 Не входит (без изменений в рамках этой задачи)

- Callback **`remove_bg:STICKER_ID`** (~11495+) — удаление фона **у уже отправленного стикера** (другой сценарий, отдельный handler, своя копия Pixian + тексты «убираю фон»).
- Платные flow: стиль / эмоция / пак / worker — не затрагиваются.
- Значения `generation_type` в БД для записи из `runFreePhotoStickerFlow`: по-прежнему логично хранить как **`photo_sticker`** (это «фото → стикер», а не операция remove-bg). Fallback на `remove_bg` в insert — оставить только если по-прежнему нужен для совместимости со старой схемой enum (не менять без проверки миграций).

## 4. Техническая спецификация

### 4.1 Точка изменения (source of truth)

**Один источник правды:** `async function runFreePhotoStickerFlow(...)` в `src/index.ts`.

Не дублировать логику в `handleActionMenuCallback` или в обработчике фото — только заменить внутренний пайплайн этой функции (и связанные тексты внутри неё).

### 4.2 Пайплайн изображения (to be)

1. Получить `fileBuffer` из Telegram (`getFilePath` + `downloadFile`) — как сейчас.
2. **Не вызывать** `https://api.pixian.ai/api/v2/remove-background`.
3. Собрать WebP для стикера через `sharp`:
   - Сохранить **весь кадр** фото (включая фон).
   - **Не применять** `.trim()` к результату «как после matting» — для полноценного фото trim может вести себя непредсказуемо или обрезать полезные поля; целевое поведение — **contain** внутри целевого квадрата.
   - Согласовать геометрию с текущим результатом: сейчас после Pixian используется `resize(482, 482, { fit: "contain", ... })` + `extend` по 15 px с каждой стороны → итог **512×512**. Для to be рекомендуется **тот же итоговый размер 512×512** и те же отступы, чтобы визуально стикеры из этого flow не «прыгали» относительно текущих.
   - Фон полей, если изображение не квадратное: **прозрачный** (`alpha: 0`), как в текущей цепочке после remove-bg — чтобы формат оставался привычным для стикеров в Telegram.
   - Для JPEG и прочих форматов без альфы: `ensureAlpha()` перед resize/composite при необходимости.
4. Отправка: `sendSticker` — без изменений по смыслу.
5. Запись в `stickers`, обновление `sessions` (`confirm_sticker`, `last_sticker_file_id`, `current_photo_file_id`, …), `sendNotification` — логика полей **без изменений**, кроме того что `resultImageBuffer` в уведомлении админу будет уже «репак без matting».

### 4.3 Конфигурация

- `config.pixianUsername` / `config.pixianPassword` в этом flow **не используются** (остаются нужными для `remove_bg:STICKER_ID` и любых других вызовов Pixian).

### 4.4 Лимиты и риски

- **Размер файла WebP** для статических стикеров в Telegram ограничен (исторически до ~512 KB для набора; для отдельной отправки уточнить актуальные лимиты API). При больших исходных фото может понадобиться **снижение quality** или предварительное уменьшение — заложить в реализацию проверку размера буфера и при необходимости один повтор с более агрессивным сжатием (описать в коде/логах).
- Логи: переименовать/добавить префикс вроде `[free_photo_sticker]` для этапа repack, чтобы не путать с `[remove_bg]` у стикера.

## 5. Копирайт (i18n)

Сейчас строки **захардкожены** внутри `runFreePhotoStickerFlow` (RU/EN). Нужно обновить:

| Момент | Было (смысл) | Стало (смысл) |
|--------|----------------|----------------|
| Прогресс | Убираю фон | Готовлю стикер / упаковываю в стикер |
| Успех | Фон удалён | Стикер готов (что дальше?) |
| Ошибка | Не удалось убрать фон | Не удалось сделать стикер / отправить стикер |

Опционально: вынести в `src/lib/texts.ts` ключи вида `free_photo_sticker.progress` / `success` / `error` для единообразия с остальным ботом.

## 6. Документация после мержа

- Обновить `docs/08-03-photo-to-sticker-and-restyle.md`: в таблице для «📸 Фото в стикер» указать **repack через sharp**, без Pixian.
- При существенном изменении flow — кратко поправить `docs/architecture/01-api-bot.md` (раздел про меню после фото / бесплатный стикер), если там зафиксировано remove-bg для этой кнопки.

## 7. Тест-план (ручной)

1. Отправить фото с **однотонным/сложным фоном** → «Фото в стикер (free)» → убедиться, что **фон на месте**, стикер квадратный с прозрачными полями при необходимости.
2. Онбординг: новый пользователь, первое фото — тот же результат без matting.
3. После успеха — `buildStickerButtons`, переходы «эмоция / движение / другой стиль» не ломаются (`source_photo_file_id` = исходное фото AgAC).
4. Регрессия: **`remove_bg` по уже готовому стикеру** (`remove_bg:ID`) — по-прежнему удаляет фон (Pixian), если задача не расширяла scope.

## 8. Чеклист реализации

- [x] Убрать вызов Pixian из `runFreePhotoStickerFlow`.
- [x] Реализовать sharp-пайплайн 512×512 с `fit: "contain"` и прежними отступами; при WebP > 512 KB — снижение quality и меньший inner.
- [x] Обновить RU/EN тексты прогресса / успеха / ошибки.
- [ ] Проверить размер выходного WebP на «тяжёлом» фото (ручной тест на test-боте).
- [x] Обновить `docs/08-03-photo-to-sticker-and-restyle.md` и `docs/architecture/01-api-bot.md`.

## 9. Ссылки на код (на момент составления ТЗ)

```3960:4068:src/index.ts
async function runFreePhotoStickerFlow(
  ctx: any,
  params: {
    user: any;
    session: any;
    lang: string;
    photoFileId: string;
    actionLabel?: "photo_sticker" | "remove_bg";
    onboardingMode?: boolean;
  }
) {
  const { user, session, lang, photoFileId, actionLabel = "photo_sticker", onboardingMode = false } = params;
  const isRu = lang === "ru";
  try {
    await ctx.reply(isRu ? "⏳ Убираю фон..." : "⏳ Removing background...");
    const filePath = await getFilePath(photoFileId);
    const fileBuffer = await downloadFile(filePath);
    const pngBuffer = await sharp(fileBuffer).png().toBuffer();
    const pixianForm = new FormData();
    pixianForm.append("image", pngBuffer, { filename: "image.png", contentType: "image/png" });
    const pixianRes = await axios.post("https://api.pixian.ai/api/v2/remove-background", pixianForm, {
      // ...
    });
    // ... trim, resize, extend, webp, sendSticker, DB, session update ...
    await ctx.reply(lang === "ru" ? "Фон удалён! Что дальше?" : "Background removed! What's next?", { reply_markup: replyMarkup });
  } catch (err: any) {
    // ... сообщение про удаление фона ...
  }
}
```

Точки входа:

- `handleActionMenuCallback` — ветка `action === "photo_sticker" || action === "remove_bg"` → `runFreePhotoStickerFlow`.
- Обработчик входящего фото — онбординг: `runFreePhotoStickerFlow(..., { onboardingMode: true })`.

Кнопка в меню: `sendActionMenu` — `withFreeBadge(await getText(lang, "action.photo_sticker"))` + callback `action_photo_sticker`.
