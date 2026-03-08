# Заменить лицо v2 — упрощённый flow

## Проблема

Текущий flow «Заменить лицо» — самый нестабильный во всём боте. Корневые причины:

1. **Два входа, требующие двух разных типов медиа** (фото + стикер), при этом `bot.on("sticker")` и `bot.on("photo")` — отдельные хендлеры со своей логикой поиска сессий.
2. **`is_active` сбрасывается** при любом update сессии (баг/особенность Supabase), после чего `getActiveSession` не находит сессию, sticker handler создаёт новую.
3. **`session_rev` рассинхрон** — sticker handler инкрементирует rev, но `startGeneration` получает старый rev через `patchedSession` → claim fail → «Сессия обновилась».
4. **Множество промежуточных состояний** (`wait_replace_face_sticker`, `wait_edit_photo`, `wait_edit_sticker`, `wait_edit_action`) каждое из которых нужно поддерживать в fallback-массивах, роутерах, и корректно обрабатывать в 3+ хендлерах.
5. **Два разных entry point** — из action menu (фото уже есть, нужен стикер) и из post-sticker menu (стикер уже есть, нужно фото) — удваивают сложность.

## Предложение: единый линейный flow

### Принцип

Вместо двустороннего сбора (фото ↔ стикер) — **всегда линейная цепочка с одним входом**:

```
Entry point: кнопка "Заменить лицо"
     │
     ▼
Бот: "Пришли фото с лицом 📸"
     │
     ▼  (пользователь шлёт фото)
Бот: "Теперь пришли стикер, в который вставить лицо"
     │
     ▼  (пользователь шлёт стикер)
     → startGeneration(replace_subject)
```

### Почему это лучше

- **Одно состояние вместо четырёх**: `wait_replace_face` (два подшага хранятся в поле `replace_face_step: "photo" | "sticker"`).
- **Фото-хендлер и стикер-хендлер проверяют одно состояние** — нет путаницы с роутингом.
- **Не нужны fallback-массивы** для 4 разных `wait_edit_*` состояний.
- **Нет race condition с `session_rev`** — данные обновляются последовательно, `startGeneration` вызывается сразу после сохранения стикера.

## Детальный дизайн

### Состояния

| Состояние | Подшаг (`replace_face_step`) | Ожидаемый ввод |
|---|---|---|
| `wait_replace_face` | `photo` | Фото с лицом |
| `wait_replace_face` | `sticker` | Стикер-референс |

### Entry points

#### 1. Из action menu (кнопка «🧑 Заменить лицо»)

```
action_replace_face callback:
  1. session.state = "wait_replace_face"
  2. session.replace_face_step = "photo"
  3. session.is_active = true
  4. Деактивировать остальные сессии
  5. ctx.reply("📸 Пришли фото с лицом:")
```

#### 2. Из post-sticker menu (кнопка «🧑 Заменить лицо» после генерации)

```
replace_face:STICKER_ID callback:
  1. Сохранить стикер: session.last_sticker_file_id = sticker.telegram_file_id
  2. session.edit_replace_sticker_id = stickerId
  3. session.state = "wait_replace_face"
  4. session.replace_face_step = "photo"  ← всегда просим фото
  5. session.is_active = true
  6. Деактивировать остальные сессии
  7. ctx.reply("📸 Пришли фото с лицом:")
```

**Ключевое отличие**: стикер из post-sticker menu уже сохранён в сессию, поэтому после фото — сразу генерация (шаг «пришли стикер» пропускается).

### Photo handler (`bot.on("photo")`)

```typescript
if (session.state === "wait_replace_face") {
  // Сохраняем фото
  session.current_photo_file_id = photo.file_id;
  
  if (session.edit_replace_sticker_id) {
    // Стикер уже есть (entry из post-sticker menu) → сразу генерация
    startGeneration(ctx, user, session, lang, {
      generationType: "replace_subject",
      ...
    });
  } else {
    // Стикера ещё нет → просим стикер
    session.replace_face_step = "sticker";
    ctx.reply("Теперь пришли стикер, в который нужно вставить лицо:");
  }
}
```

### Sticker handler (`bot.on("sticker")`)

```typescript
if (session.state === "wait_replace_face" && session.replace_face_step === "sticker") {
  // Сохраняем стикер
  session.last_sticker_file_id = stickerFileId;
  session.edit_replace_sticker_id = importedSticker.id;
  
  // Оба входа есть → генерация
  startGeneration(ctx, user, session, lang, {
    generationType: "replace_subject",
    ...
  });
}
```

### Решение проблемы `session_rev`

В обоих хендлерах (photo и sticker) — **не создавать `patchedSession`**, а перечитывать сессию из БД после update:

```typescript
await supabase.from("sessions").update({ ... }).eq("id", session.id);
const { data: freshSession } = await supabase
  .from("sessions").select("*").eq("id", session.id).single();
await startGeneration(ctx, user, freshSession, lang, { ... });
```

Это полностью устраняет проблему рассинхрона `session_rev`.

### Решение проблемы `is_active`

При входе в flow — **деактивировать ВСЕ остальные сессии** пользователя:

```typescript
await supabase.from("sessions")
  .update({ is_active: false })
  .eq("user_id", user.id)
  .eq("env", config.appEnv)
  .neq("id", session.id);
```

И в `SESSION_FALLBACK_ACTIVE_STATES` достаточно одного состояния `wait_replace_face`.

## Миграция

### SQL

```sql
-- sql/126_wait_replace_face.sql
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_replace_face';
```

### Колонка `replace_face_step`

Новая колонка НЕ нужна — используем `edit_replace_sticker_id`:
- Если `NULL` → ждём фото, потом стикер
- Если заполнен → ждём только фото, потом сразу генерация

## Точки правки

| Файл | Что изменить |
|------|-------------|
| `src/index.ts` | `handleActionMenuCallback` → action `replace_face`: деактивация + `wait_replace_face` |
| `src/index.ts` | `replace_face:STICKER_ID` callback: сохранить стикер + `wait_replace_face` |
| `src/index.ts` | Photo handler: ветка `wait_replace_face` |
| `src/index.ts` | Sticker handler: ветка `wait_replace_face` (вместо `wait_replace_face_sticker`) |
| `src/index.ts` | Удалить ветки `wait_edit_photo`, `wait_edit_sticker`, `wait_edit_action` |
| `src/index.ts` | `SESSION_FALLBACK_ACTIVE_STATES`: заменить 4 состояния на одно `wait_replace_face` |
| `src/lib/texts.ts` | Обновить тексты |
| `sql/` | Миграция нового enum value |

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
