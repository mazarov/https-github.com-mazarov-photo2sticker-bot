# Заменить лицо — всегда просить фото

## Проблема

Текущий flow «Заменить лицо» берёт фото из `session.current_photo_file_id` или `user.last_photo_file_id` и сразу запускает генерацию. Пользователь не может выбрать другое фото для замены лица.

## Новый flow

```
"🧑 Заменить лицо" → "Пришли фото с лицом" → Фото → сразу генерация
```

Один промежуточный шаг: бот всегда просит фото, получив — сразу генерирует.

## Точки правки

### 1. `replace_face` callback (`src/index.ts:~8844`)

**Было:** проверяет `identityPhotoFileId` → если есть, сразу `startGeneration`.

**Стало:** всегда переводит в `wait_edit_photo` и просит фото:

```typescript
await supabase.from("sessions").update({
  state: "wait_edit_photo",
  is_active: true,
  flow_kind: "single",
  edit_replace_sticker_id: stickerId,
  last_sticker_file_id: sticker.telegram_file_id,
  selected_style_id: sticker.style_preset_id || session.selected_style_id || null,
  session_rev: nextRev,
}).eq("id", session.id);

await ctx.reply("📸 Пришли фото с лицом, которое нужно вставить в стикер:");
```

### 2. Photo handler `wait_edit_photo` (`src/index.ts:~3489`)

**Было:** сохраняет фото → `wait_edit_action` → показывает кнопку «Заменить лицо» (ещё один клик).

**Стало:** сохранить фото и сразу запустить `startGeneration(replace_subject)` без промежуточной кнопки.

### 3. Тексты (`src/lib/texts.ts`)

Обновить `edit.need_photo`:
- RU: `"📸 Пришли фото с лицом, которое нужно вставить в стикер:"`
- EN: `"📸 Send a photo with the face you want to put on the sticker:"`

## Checklist

- [x] `replace_face` callback: убрать проверку фото, всегда → `wait_edit_photo` + просить фото
- [x] Photo handler `wait_edit_photo`: получив фото → сразу `startGeneration`
- [x] Тексты: обновить `edit.need_photo`
- [ ] Проверить на test боте
