# PROHIBITED_CONTENT — отправка фото + промпта в алерт

> Дата: 14.02.2026
> Статус: TODO

## Проблема

Gemini часто возвращает `PROHIBITED_CONTENT` при генерации стикеров. В алерт приходит только текстовое сообщение — нет возможности понять, какое именно фото и какой промпт вызвали блокировку.

## Решение

При получении `PROHIBITED_CONTENT` от Gemini — отправить в alert-канал:
1. Текстовый алерт (как сейчас)
2. **Исходное фото** пользователя с caption: юзер, стиль, полный промпт

## Изменения

### `src/worker.ts` — блок обработки blockReason (~строка 273)

После существующего `sendAlert(...)` добавить отправку фото:

```typescript
// Send source photo + prompt to alert channel for debugging
if (config.alertChannelId && fileBuffer) {
  try {
    const caption = `🚫 *PROHIBITED\\_CONTENT*\n\n` +
      `👤 @${user?.username || telegramId}\n` +
      `🎨 Style: ${session.selected_style_id || "-"}\n\n` +
      `📝 *Prompt:*\n\`${(session.prompt_final || "").slice(0, 800)}\``;

    const formData = new FormData();
    formData.append("chat_id", config.alertChannelId);
    formData.append("photo", new Blob([fileBuffer], { type: "image/jpeg" }), "source.jpg");
    formData.append("caption", caption.slice(0, 1024));
    formData.append("parse_mode", "Markdown");

    await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendPhoto`, {
      method: "POST",
      body: formData,
    });
  } catch (err) {
    console.error("[Worker] Failed to send blocked photo to alert:", err);
  }
}
```

### Контекст

Переменные уже доступны в скоупе `runJob()`:
- `fileBuffer` — скачанный исходный файл (фото пользователя)
- `session.prompt_final` — сгенерированный промпт для Gemini
- `session.selected_style_id` — выбранный стиль
- `user?.username`, `telegramId` — данные пользователя
- `config.alertChannelId` — ID канала алертов

### Что увидит админ в канале

1. Текстовый алерт:
   ```
   🟡 generation_failed
   ❌ Gemini blocked: PROHIBITED_CONTENT
   📋 Details:
   • user: @username
   • styleId: cartoon_telegram
   • blockReason: PROHIBITED_CONTENT
   ```

2. Фото с caption:
   ```
   🚫 PROHIBITED_CONTENT
   
   👤 @username
   🎨 Style: cartoon_telegram
   
   📝 Prompt:
   `Transform this photo into a cartoon-style Telegram sticker...`
   ```

## Оценка

- **Сложность**: 1 изменение в 1 файле, ~15 строк
- **Время**: 5 минут
- **Риск**: нет (async, non-blocking, в catch)
