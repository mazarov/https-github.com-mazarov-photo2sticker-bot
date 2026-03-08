# Заменить лицо v2 — упрощённый flow

## Проблема

Текущий flow «Заменить лицо» — самый нестабильный во всём боте. Корневые причины:

1. **Два входа, требующие двух разных типов медиа** (фото + стикер), при этом `bot.on("sticker")` и `bot.on("photo")` — отдельные хендлеры со своей логикой поиска сессий.
2. **`is_active` сбрасывается** при любом update сессии (баг/особенность Supabase), после чего `getActiveSession` не находит сессию, sticker handler создаёт новую.
3. **`session_rev` рассинхрон** — sticker handler инкрементирует rev, но `startGeneration` получает старый rev через `patchedSession` → claim fail → «Сессия обновилась».
4. **Множество промежуточных состояний** (`wait_replace_face_sticker`, `wait_edit_photo`, `wait_edit_sticker`, `wait_edit_action`) каждое из которых нужно поддерживать в fallback-массивах, роутерах, и корректно обрабатывать в 3+ хендлерах.
5. **Два разных entry point** — из action menu (фото уже есть, нужен стикер) и из post-sticker menu (стикер уже есть, нужно фото) — удваивают сложность.

## Предложение: единый линейный flow (фото уже есть)

### Принцип

**Фото берётся из ранее присланного** (action menu показывается только когда есть фото). Пользователь присылает **только стикер**:

```
Entry point: кнопка "Заменить лицо" (из action menu)
     │
     │  Фото уже есть: session.current_photo_file_id
     ▼
Бот: "Пришли стикер, в который вставить лицо 👇"
     │
     ▼  (пользователь шлёт стикер)
     → startGeneration(replace_subject)
```

**Entry из post-sticker menu** (`replace_face:STICKER_ID`): стикер уже выбран, фото берём из сессии/пользователя → **сразу генерация**.

### Почему это лучше

- **Один шаг вместо двух**: не просим фото — оно уже есть.
- **Одно состояние** `wait_replace_face` — ждём только стикер (для action menu).
- **Меньше точек отказа** — нет зависимости от photo handler для входа в flow.
- **replace_face:STICKER_ID** — сразу генерация, без дополнительных шагов.

## Детальный дизайн

### Состояния

| Состояние | Ожидаемый ввод |
|---|---|
| `wait_replace_face` | Стикер (фото уже в сессии) |

### Entry points

#### 1. Из action menu (кнопка «🧑 Заменить лицо»)

Фото уже есть в `session.current_photo_file_id` (пользователь прислал его для action menu).

```
action_replace_face callback:
  1. session.state = "wait_replace_face"
  2. session.edit_replace_sticker_id = null
  3. session.is_active = true
  4. Деактивировать остальные сессии
  5. ctx.reply("Пришли стикер, в который вставить лицо 👇")
```

#### 2. Из post-sticker menu (кнопка «🧑 Заменить лицо» после генерации)

Стикер уже выбран. Фото берём из `session.current_photo_file_id` или `user.last_photo_file_id`.

```
replace_face:STICKER_ID callback:
  1. Сохранить стикер: session.last_sticker_file_id, edit_replace_sticker_id
  2. Фото: session.current_photo_file_id || user.last_photo_file_id
  3. Если фото есть → сразу startGeneration(replace_subject)
  4. Если фото нет → ctx.reply("Сначала отправь фото") (fallback)
```

### Photo handler (`bot.on("photo")`)

Для `wait_replace_face` с `edit_replace_sticker_id === null`: ждём стикер, не фото. Если пользователь по ошибке пришлёт фото — обновляем `current_photo_file_id` и снова просим стикер (опционально).

### Sticker handler (`bot.on("sticker")`)

```typescript
if (session.state === "wait_replace_face" && !session.edit_replace_sticker_id) {
  // Сохраняем стикер, фото уже есть в session.current_photo_file_id
  session.last_sticker_file_id = stickerFileId;
  session.edit_replace_sticker_id = importedSticker.id;
  
  startGeneration(ctx, user, freshSession, lang, {
    generationType: "replace_subject",
    ...
  });
}
```

### Решение проблемы `session_rev`

В sticker handler — перечитывать сессию из БД после update перед `startGeneration`.

### Решение проблемы `is_active`

При входе в flow — деактивировать все остальные сессии пользователя.

## Миграция

### SQL

```sql
-- sql/126_wait_replace_face.sql
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_replace_face';
```

### `edit_replace_sticker_id`

- `NULL` → ждём стикер (entry из action menu)
- Заполнен → стикер уже есть (entry из replace_face:ID) → сразу генерация

## Точки правки

| Файл | Что изменить |
|------|-------------|
| `src/index.ts` | `handleActionMenuCallback` → action `replace_face`: деактивация + `wait_replace_face` + просим стикер (не фото) |
| `src/index.ts` | `replace_face:STICKER_ID` callback: если фото есть → сразу генерация; иначе fallback "Сначала отправь фото" |
| `src/index.ts` | Photo handler: опционально — если в wait_replace_face пришло фото, обновить и снова просим стикер |
| `src/index.ts` | Sticker handler: ветка `wait_replace_face` (edit_replace_sticker_id === null) |
| `src/lib/texts.ts` | Использовать `action.replace_face_send_sticker` для запроса стикера |

## Обратная совместимость

- Старые callback кнопки с `replace_face:STICKER_ID` — продолжат работать (тот же regex).
- Сессии в старых состояниях (`wait_replace_face_sticker`, `wait_edit_photo` и т.д.) — перестанут обрабатываться. При следующем `/start` создастся новая сессия. Допустимо для test-env.

## Checklist

- [ ] SQL миграция `wait_replace_face`
- [ ] `handleActionMenuCallback` replace_face: деактивация + новое состояние
- [ ] `replace_face:STICKER_ID` callback: сохранить стикер + новое состояние
- [ ] Photo handler: ветка `wait_replace_face`
- [ ] Sticker handler: ветка `wait_replace_face`
- [ ] Удалить старые ветки (`wait_edit_photo`, `wait_edit_sticker`, `wait_edit_action`, `wait_replace_face_sticker`)
- [ ] `SESSION_FALLBACK_ACTIVE_STATES`: одно состояние вместо четырёх
- [ ] `startGeneration`: использовать `freshSession` из БД вместо `patchedSession`
- [ ] Тексты
- [ ] Тест на test-боте
