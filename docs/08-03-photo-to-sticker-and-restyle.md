# Фото в стикер + Другой стиль

## Контекст

Текущее меню действий после загрузки фото (`sendActionMenu`):

```
🖼 Удалить фон
🧑 Заменить лицо (1💎)
✨ Сделать стикер (1💎)
📦 Создать стикер пак
```

Текущие кнопки после генерации стикера (`buildStickerButtons`):

```
📦 Добавить в пак
😊 Эмоция  |  🏃 Движение
🔲 Обводка |  ✏️ Текст
🧑 Заменить лицо  |  🖼 Вырезать фон
💡 Идеи
```

## Изменения

### 1. Меню после фото: новая кнопка + переименование

**Было:**

```
🖼 Удалить фон
🧑 Заменить лицо (1💎)
✨ Сделать стикер (1💎)          ← Gemini генерация со стилем
📦 Создать стикер пак
```

**Стало:**

```
📸 Фото в стикер                 ← НОВАЯ: быстрый стикер (repack в WebP без удаления фона, без Gemini)
🎨 Изменить стиль (1💎)          ← ПЕРЕИМЕНОВАНА: полная генерация с выбором стиля
🧑 Заменить лицо (1💎)
📦 Создать стикер пак
```

| Кнопка | Callback | Действие |
|--------|----------|----------|
| 📸 Фото в стикер | `action_photo_sticker` | `sharp`: вписать фото в 512×512 (прозрачные поля), WebP → `sendSticker`. Pixian не используется. Кредиты НЕ списываются. Gemini НЕ вызывается. |
| 🎨 Изменить стиль (1💎) | `action_make_sticker` | Текущее поведение: `wait_style` → `sendStyleKeyboardFlat` → выбор стиля → `startGeneration`. |
| 🧑 Заменить лицо (1💎) | `action_replace_face` | Без изменений. |
| 📦 Создать стикер пак | `action_make_pack` | Без изменений. |

**Примечание:** кнопка «🖼 Удалить фон» убрана из меню после фото; «📸 Фото в стикер» даёт быстрый стикер **без** удаления фона. Вырезка фона по готовому стикеру — отдельная кнопка «🖼 Вырезать фон» (`remove_bg:ID`, Pixian).

### 2. Кнопки после генерации стикера: новая кнопка «Другой стиль»

**Было:**

```
📦 Добавить в пак
😊 Эмоция  |  🏃 Движение
🔲 Обводка |  ✏️ Текст
🧑 Заменить лицо  |  🖼 Вырезать фон
💡 Идеи
```

**Стало:**

```
📦 Добавить в пак
🎨 Другой стиль
😊 Эмоция  |  🏃 Движение
🔲 Обводка |  ✏️ Текст
🧑 Заменить лицо  |  🖼 Вырезать фон
💡 Идеи
```

| Кнопка | Callback | Действие |
|--------|----------|----------|
| 🎨 Другой стиль | `restyle:STICKER_ID` | Берём `source_photo_file_id` стикера → `session.current_photo_file_id = source_photo_file_id` → `state = wait_style` → `sendStyleKeyboardFlat`. Пользователь выбирает стиль → `startGeneration(style)` по оригинальному фото. |

## Точки правки

### 1. `sendActionMenu` (`src/index.ts:~556`)

Заменить массив кнопок:

```typescript
const photoStickerCb = appendSessionRefIfFits("action_photo_sticker", sessionRef);
const makeStickerCb = appendSessionRefIfFits("action_make_sticker", sessionRef);
const replaceFaceCb = appendSessionRefIfFits("action_replace_face", sessionRef);
const makePackCb = appendSessionRefIfFits("action_make_pack", sessionRef);

const buttons = [
  [{ text: await getText(lang, "action.photo_sticker"), callback_data: photoStickerCb }],
  [{ text: await getText(lang, "action.make_sticker"), callback_data: makeStickerCb }],
  [{ text: await getText(lang, "action.replace_face"), callback_data: replaceFaceCb }],
  [{ text: await getText(lang, "action.make_pack"), callback_data: makePackCb }],
];
```

### 2. Callback `action_photo_sticker` (новый)

- Берёт `session.current_photo_file_id`
- `runFreePhotoStickerFlow` → `buildFreePhotoStickerWebp`: sharp (rotate, downscale если >4096, contain 482 + поля 15px, WebP; при размере файла >512 KB — снижение quality / меньший inner)
- `sendSticker` → insert в `stickers` с `generation_type: "photo_sticker"`
- Показать `buildStickerButtons` после отправки
- Кредиты НЕ списываются

### 3. Callback `action_remove_bg` → удалить

Больше не нужен в `sendActionMenu` (заменён на `action_photo_sticker`). Callback `remove_bg:STICKER_ID` в `buildStickerButtons` остаётся как есть (это remove-bg по существующему стикеру, другой flow).

### 4. `buildStickerButtons` (`src/index.ts:~1720`)

Добавить кнопку «Другой стиль» между «Добавить в пак» и «Эмоция/Движение»:

```typescript
const restyleText = lang === "ru" ? "🎨 Другой стиль" : "🎨 Different style";
const restyleCb = appendSessionRefIfFits(`restyle:${stickerId}`, sessionRef);

return {
  inline_keyboard: [
    [{ text: addToPackText, callback_data: `add_to_pack:${stickerId}` }],
    [{ text: restyleText, callback_data: restyleCb }],        // ← НОВАЯ
    [
      { text: changeEmotionText, callback_data: emotionCb },
      { text: changeMotionText, callback_data: motionCb },
    ],
    // ... остальные без изменений
  ],
};
```

### 5. Callback `restyle:STICKER_ID` (новый)

```
bot.action(/^restyle:([^:]+)(?::(.+))?$/, ...)
```

Логика:
1. Получить стикер по ID → `source_photo_file_id`
2. Если `source_photo_file_id` начинается с `AgAC` (фото) — использовать как `current_photo_file_id`
3. Если нет — взять `user.last_photo_file_id`
4. Если фото нет совсем — попросить прислать фото
5. Обновить сессию: `state = wait_style`, `current_photo_file_id = photoFileId`
6. Показать `sendStyleKeyboardFlat`

### 6. Тексты (`src/lib/texts.ts`)

Обновить/добавить:

```
"action.photo_sticker":
  ru: "📸 Фото в стикер"
  en: "📸 Photo to sticker"

"action.make_sticker":
  ru: "🎨 Изменить стиль (1💎)"
  en: "🎨 Change style (1💎)"
```

Текст `action.remove_bg` — оставить (используется в `buildStickerButtons`).

### 7. `handleActionMenuCallback` (`src/index.ts`)

Добавить ветку `"photo_sticker"` в switch, удалить ветку `"remove_bg"`:

```typescript
if (action === "photo_sticker") {
  // Pixian remove-bg из session.current_photo_file_id
  // Без кредитов, без Gemini
  // sendSticker + buildStickerButtons
}
```

## Что сохраняется без изменений

- `remove_bg:STICKER_ID` callback (вырезка фона у готового стикера) — остаётся
- `replace_face:STICKER_ID` callback — остаётся
- Весь pack flow — остаётся
- Reply Keyboard — остаётся
- Valentine flow — остаётся

## Файлы

| Файл | Изменение |
|------|-----------|
| `src/index.ts` | `sendActionMenu` (новые кнопки), `buildStickerButtons` (+restyle), `handleActionMenuCallback` (+photo_sticker, -remove_bg), новый callback `restyle:ID` |
| `src/lib/texts.ts` | `action.photo_sticker`, обновить `action.make_sticker` |

## Checklist

- [ ] `sendActionMenu`: заменить кнопки (photo_sticker, make_sticker, replace_face, make_pack)
- [x] Callback `action_photo_sticker`: sharp repack → WebP стикер (без кредитов, без Pixian)
- [ ] Убрать `action_remove_bg` из `sendActionMenu`
- [ ] `buildStickerButtons`: добавить «🎨 Другой стиль» (restyle)
- [ ] Callback `restyle:STICKER_ID`: source_photo → wait_style → sendStyleKeyboardFlat
- [ ] Тексты: `action.photo_sticker`, обновить `action.make_sticker`
- [ ] Проверить на test боте
