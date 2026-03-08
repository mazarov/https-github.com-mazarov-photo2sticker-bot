# Меню действий после фото

## Проблема

Сейчас при `/start` сразу запускается pack flow (карусель паков). Пользователь не видит все доступные действия и не может выбрать что делать с фото.

## Новый flow

```
/start → "Пришли фото 📸"
         ↓ (фото получено)
         → "Что хочешь сделать с этим фото?"
           ├── 🖼 Удалить фон        → Pixian remove-bg
           ├── 🧑 Заменить лицо      → wait_edit_photo → фото → генерация
           ├── ✨ Сделать стикер     → wait_style → выбор стиля
           └── 📦 Создать стикер пак → pack flow (карусель)
```

Если фото уже есть (`last_photo_file_id`) — сразу показать меню действий.

## Новое состояние: `wait_action`

Сессия в состоянии `wait_action` означает: фото есть, ждём выбор действия от пользователя.

## Точки правки

### 1. SQL-миграция

```sql
-- sql/XXX_wait_action_state.sql
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_action';
```

### 2. `/start` handler (`src/index.ts:~3261`)

**Было:** `await handlePackMenuEntry(ctx, { source: "start", autoPackEntry: true })`

**Стало:**
- Определить `existingPhoto` (из последних сессий или `user.last_photo_file_id`)
- Если нет фото → сессия `wait_photo`, приветствие + "Пришли фото 📸"
- Если есть фото → сессия `wait_action`, показать `sendActionMenu`

### 3. Photo handler: Manual mode (`src/index.ts:~3835`)

**Было:** фото → `wait_style` → `sendStyleKeyboardFlat`

**Стало:** фото → `wait_action` → `sendActionMenu`

### 4. Новая функция `sendActionMenu(ctx, lang, sessionId, sessionRev)`

Отправляет inline-кнопки:

```
🖼 Удалить фон
🧑 Заменить лицо (1💎)
✨ Сделать стикер (1💎)
📦 Создать стикер пак
```

Callback data с session ref:
- `action_remove_bg:SESSION_ID:REV`
- `action_replace_face:SESSION_ID:REV`
- `action_make_sticker:SESSION_ID:REV`
- `action_make_pack:SESSION_ID:REV`

### 5. Callback-хендлеры

| Callback | Действие |
|----------|----------|
| `action_remove_bg` | Взять `session.current_photo_file_id` → скачать → Pixian → отправить результат + кнопки стикера |
| `action_replace_face` | Сохранить фото как identity, `state → wait_edit_photo`, просить "Пришли фото с лицом для замены" (но тут фото уже есть — нужен стикер для замены. Вариант: предложить выбрать стикер или пропустить, если стикеров нет) |
| `action_make_sticker` | `state → wait_style` → `sendStyleKeyboardFlat` |
| `action_make_pack` | `handlePackMenuEntry` (карусель паков) |

### 6. `SESSION_FALLBACK_ACTIVE_STATES`

Добавить `"wait_action"` в массив.

### 7. Тексты (`src/lib/texts.ts`)

```
"action.choose":
  ru: "Что хочешь сделать с этим фото?"
  en: "What do you want to do with this photo?"

"action.remove_bg":
  ru: "🖼 Удалить фон"
  en: "🖼 Remove background"

"action.replace_face":
  ru: "🧑 Заменить лицо (1💎)"
  en: "🧑 Replace face (1💎)"

"action.make_sticker":
  ru: "✨ Сделать стикер (1💎)"
  en: "✨ Make sticker (1💎)"

"action.make_pack":
  ru: "📦 Создать стикер пак"
  en: "📦 Create sticker pack"
```

### 8. Обработка фото при `wait_action`

Если пользователь уже в `wait_action` и присылает новое фото — обновить `current_photo_file_id` и заново показать меню действий.

## Что сохраняется без изменений

- `val_*` deep links (Valentine flow)
- Pack flow целиком (`handlePackMenuEntry`)
- Стикер flow (`sendStyleKeyboardFlat` → `startGeneration`)
- Replace face flow (`wait_edit_photo` → фото → генерация)
- Remove bg flow (Pixian)
- Все кнопки после генерации (эмоция, движение, текст, обводка, замена лица)
- Reply Keyboard (баланс, поддержка, создать пак, создать стикер)

## Файлы

| Файл | Изменение |
|------|-----------|
| `src/index.ts` | `/start`, photo handler, `sendActionMenu`, 4 callback-хендлера, `SESSION_FALLBACK_ACTIVE_STATES` |
| `src/lib/texts.ts` | Новые тексты для меню действий |
| `sql/XXX_wait_action_state.sql` | Миграция enum |

## Checklist

- [ ] SQL-миграция `wait_action`
- [ ] `/start` handler: фото есть → `wait_action` + меню; нет фото → `wait_photo`
- [ ] Photo handler: фото → `wait_action` + меню (вместо `wait_style`)
- [ ] `sendActionMenu` функция
- [ ] Callback `action_remove_bg`
- [ ] Callback `action_replace_face`
- [ ] Callback `action_make_sticker`
- [ ] Callback `action_make_pack`
- [ ] `SESSION_FALLBACK_ACTIVE_STATES` + `wait_action`
- [ ] Тексты в `texts.ts`
- [ ] Проверить на test боте
