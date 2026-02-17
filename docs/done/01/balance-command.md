# Команда /balance — Требования

## Описание

Команда для просмотра текущего баланса кредитов пользователя.

---

## Команда

`/balance`

---

## Ответ

### RU

```
💰 Ваш баланс: {credits} кредитов

1 кредит = 1 стикер
[Пополнить баланс]
```

### EN

```
💰 Your balance: {credits} credits

1 credit = 1 sticker
[Top up balance]
```

---

## UI

- Inline-кнопка «Пополнить баланс» / «Top up balance»
- При нажатии → вызов `sendBuyCreditsMenu(ctx, user)`

---

## Технические изменения

### 1. Handler (index.ts)

```typescript
bot.command("balance", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user) {
    const lang = (ctx.from?.language_code || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await ctx.reply(await getText(lang, "start.need_start"));
    return;
  }

  const lang = user.lang || "en";
  const text = await getText(lang, "balance.info", { credits: user.credits || 0 });
  const btnText = await getText(lang, "btn.top_up");

  await ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback(btnText, "buy_credits")]
  ]));
});
```

### 2. Тексты (texts.ts)

```typescript
// RU
"balance.info": "💰 Ваш баланс: {credits} кредитов\n\n1 кредит = 1 стикер",
"btn.top_up": "Пополнить баланс",

// EN
"balance.info": "💰 Your balance: {credits} credits\n\n1 credit = 1 sticker",
"btn.top_up": "Top up balance",
```

### 3. SQL миграция

```sql
-- 011_balance_command.sql
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'balance.info', '💰 Ваш баланс: {credits} кредитов\n\n1 кредит = 1 стикер'),
  ('en', 'balance.info', '💰 Your balance: {credits} credits\n\n1 credit = 1 sticker'),
  ('ru', 'btn.top_up', 'Пополнить баланс'),
  ('en', 'btn.top_up', 'Top up balance')
ON CONFLICT (lang, key) DO UPDATE SET
  text = EXCLUDED.text,
  updated_at = now();
```

---

## Чеклист

- [ ] Добавить handler `bot.command("balance", ...)`
- [ ] Добавить тексты в fallbackTexts
- [ ] SQL миграция
- [ ] Тестирование
