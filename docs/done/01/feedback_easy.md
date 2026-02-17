# Support Command (Simplified Feedback)

## Цель

Простой способ связи пользователя с поддержкой — команда `/support` с кнопкой для перехода в личный чат.

## Команда

```
/support
```

## Поведение

1. Пользователь вводит `/support`
2. Бот отправляет сообщение с inline-кнопкой
3. Кнопка открывает чат с @mazarov

## UI

**Сообщение:**
```
💬 Если у вас есть вопросы, предложения или проблемы — напишите напрямую:
```

**Кнопка:**
```
💬 Написать в поддержку → https://t.me/mazarov
```

## Локализация

### Тексты

| Ключ | RU | EN |
|------|----|----|
| `support.message` | 💬 Если у вас есть вопросы, предложения или проблемы — напишите напрямую: | 💬 If you have questions, suggestions or issues — write directly: |
| `support.button` | 💬 Написать в поддержку | 💬 Contact support |

### SQL миграция

```sql
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'support.message', '💬 Если у вас есть вопросы, предложения или проблемы — напишите напрямую:'),
  ('en', 'support.message', '💬 If you have questions, suggestions or issues — write directly:'),
  ('ru', 'support.button', '💬 Написать в поддержку'),
  ('en', 'support.button', '💬 Contact support')
ON CONFLICT (key, lang) DO UPDATE SET text = EXCLUDED.text;
```

## Реализация

### index.ts

```typescript
// /support command
bot.command("support", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const { data: user } = await supabase
    .from("users")
    .select("lang")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  const lang = user?.lang || "en";
  const message = await getText(lang, "support.message");
  const buttonText = await getText(lang, "support.button");

  await ctx.reply(message, {
    reply_markup: {
      inline_keyboard: [[
        { text: buttonText, url: "https://t.me/mazarov" }
      ]]
    }
  });
});
```

### texts.ts (fallback)

```typescript
// Добавить в defaultTexts
"support.message": {
  ru: "💬 Если у вас есть вопросы, предложения или проблемы — напишите напрямую:",
  en: "💬 If you have questions, suggestions or issues — write directly:"
},
"support.button": {
  ru: "💬 Написать в поддержку",
  en: "💬 Contact support"
}
```

## Конфигурация

Ссылка на поддержку захардкожена как `https://t.me/mazarov`.

Если нужно сделать настраиваемой — можно:
- Добавить в `config.ts`: `supportUsername: "mazarov"`
- Или в таблицу `settings` в БД

## Checklist

- [x] SQL миграция для текстов (`sql/018_support_command.sql`)
- [x] Добавить fallback в `texts.ts`
- [x] Добавить handler `/support` в `index.ts`
- [ ] Тестирование команды
