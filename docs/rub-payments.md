# Оплата в рублях — Требования

## Описание

Добавить возможность оплаты в рублях для пользователей с локалью `ru`. Для остальных локалей оставить только Telegram Stars.

---

## Текущее поведение

- Все пользователи видят только пакеты в Stars
- Оплата через Telegram Stars (XTR)

---

## Новое поведение

### Для `lang !== "ru"` (без изменений)

```
[Купить кредиты]
    ↓
Ваш баланс: X кредитов

[2 — 15⭐]  [5 — 30⭐]
[10 — 60⭐] [20 — 100⭐]
[❌ Отмена]
```

### Для `lang === "ru"` (новый шаг)

```
[Купить кредиты]
    ↓
Выберите способ оплаты:
[⭐ Telegram Stars]
[💳 Карта (рубли)]
[❌ Отмена]
    ↓
(если Stars)              (если Рубли)
Ваш баланс: X кредитов    Ваш баланс: X кредитов

[2 — 15⭐]  [5 — 30⭐]      [2 — 20₽]  [5 — 50₽]
[10 — 60⭐] [20 — 100⭐]    [10 — 100₽] [20 — 200₽]
[❌ Отмена]                [❌ Отмена]
```

---

## Тарифы

| Кредиты | Stars | RUB |
|---------|-------|-----|
| 2 | 15⭐ | 20₽ |
| 5 | 30⭐ | 50₽ |
| 10 | 60⭐ | 100₽ |
| 20 | 100⭐ | 200₽ |

Цена в рублях: **10₽ за 1 кредит**.

---

## Платёжный провайдер

**ЮKassa** через Telegram Payments API:
- Не требует отдельного webhook
- Работает через стандартный `sendInvoice`
- Нужен `provider_token` из BotFather

### Получение provider_token

1. Зарегистрироваться на [yookassa.ru](https://yookassa.ru)
2. Создать магазин, пройти модерацию
3. В BotFather: `/mybots` → бот → Payments → Connect ЮKassa
4. Получить `provider_token`

---

## Технические изменения

### 1. Новые переменные окружения

```env
YOOKASSA_PROVIDER_TOKEN=your_provider_token_here
```

### 2. Конфиг (config.ts)

```typescript
yookassaProviderToken: process.env.YOOKASSA_PROVIDER_TOKEN || "",
```

### 3. Тарифы (index.ts)

```typescript
const CREDIT_PACKS_STARS = [
  { credits: 2, price: 15 },
  { credits: 5, price: 30 },
  { credits: 10, price: 60 },
  { credits: 20, price: 100 },
];

const CREDIT_PACKS_RUB = [
  { credits: 2, price: 20 },
  { credits: 5, price: 50 },
  { credits: 10, price: 100 },
  { credits: 20, price: 200 },
];
```

### 4. Callback handlers

```typescript
// Выбор способа оплаты (только для ru)
bot.action("pay_stars", async (ctx) => {
  // Показать пакеты в Stars
});

bot.action("pay_rub", async (ctx) => {
  // Показать пакеты в рублях
});

// Покупка пакета в Stars (существующий)
bot.action(/^pack_(\d+)_(\d+)$/, async (ctx) => { ... });

// Покупка пакета в рублях (новый)
bot.action(/^pack_rub_(\d+)_(\d+)$/, async (ctx) => { ... });
```

### 5. sendInvoice для рублей

```typescript
await axios.post(`https://api.telegram.org/bot${token}/sendInvoice`, {
  chat_id: telegramId,
  title: "10 кредитов",
  description: "Пополнение баланса на 10 кредитов",
  payload: `[${transactionId}]`,
  provider_token: config.yookassaProviderToken, // <-- отличие от Stars
  currency: "RUB",                               // <-- отличие от Stars
  prices: [{ label: "Кредиты", amount: 10000 }], // копейки! 100₽ = 10000
});
```

**Важно:** Для RUB `amount` указывается в **копейках** (100₽ = 10000).

### 6. Поле в transactions

Добавить поле для отслеживания валюты:

```sql
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency varchar(3) DEFAULT 'XTR';
```

---

## Тексты (localization)

### Новые ключи

| Ключ | RU | EN |
|------|----|----|
| `payment.choose_method` | Выберите способ оплаты | Choose payment method |
| `btn.pay_stars` | ⭐ Telegram Stars | ⭐ Telegram Stars |
| `btn.pay_rub` | 💳 Карта (рубли) | 💳 Card (rubles) |

---

## SQL миграция

```sql
-- 010_rub_payments.sql

-- Currency field for transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS currency varchar(3) DEFAULT 'XTR';

-- Payment method texts
INSERT INTO bot_texts_new (lang, key, text) VALUES
  ('ru', 'payment.choose_method', 'Выберите способ оплаты'),
  ('en', 'payment.choose_method', 'Choose payment method'),
  ('ru', 'btn.pay_stars', '⭐ Telegram Stars'),
  ('en', 'btn.pay_stars', '⭐ Telegram Stars'),
  ('ru', 'btn.pay_rub', '💳 Карта (рубли)'),
  ('en', 'btn.pay_rub', '💳 Card (rubles)')
ON CONFLICT (lang, key) DO UPDATE SET
  text = EXCLUDED.text,
  updated_at = now();
```

---

## Логика sendBuyCreditsMenu

```typescript
async function sendBuyCreditsMenu(ctx: any, user: any, messageText?: string) {
  const lang = user.lang || "en";

  // Для ru — показываем выбор способа оплаты
  if (lang === "ru") {
    const text = messageText || await getText(lang, "payment.choose_method");
    const buttons = [
      [Markup.button.callback(await getText(lang, "btn.pay_stars"), "pay_stars")],
      [Markup.button.callback(await getText(lang, "btn.pay_rub"), "pay_rub")],
      [Markup.button.callback(await getText(lang, "btn.cancel"), "cancel")],
    ];
    await ctx.reply(text, Markup.inlineKeyboard(buttons));
    return;
  }

  // Для остальных — сразу пакеты в Stars
  await sendStarsPacksMenu(ctx, user, messageText);
}

async function sendStarsPacksMenu(ctx: any, user: any, messageText?: string) {
  // Текущая логика с CREDIT_PACKS_STARS
}

async function sendRubPacksMenu(ctx: any, user: any) {
  // Аналогичная логика с CREDIT_PACKS_RUB
  // callback_data: pack_rub_{credits}_{price}
}
```

---

## Обработка платежа (pre_checkout_query / successful_payment)

Логика остаётся той же — Telegram Payments API унифицирован. Различие только в:
- `provider_token` (пустой для Stars, заполнен для ЮKassa)
- `currency` (XTR vs RUB)
- `amount` (Stars — целое число, RUB — копейки)

---

## Чеклист реализации

- [ ] Добавить `YOOKASSA_PROVIDER_TOKEN` в config
- [ ] Разделить `CREDIT_PACKS` на Stars и RUB
- [ ] Добавить тексты в fallbackTexts
- [ ] Изменить `sendBuyCreditsMenu` для ru
- [ ] Добавить `sendRubPacksMenu`
- [ ] Добавить callbacks: `pay_stars`, `pay_rub`, `pack_rub_*`
- [ ] Изменить sendInvoice для RUB (provider_token, currency, amount в копейках)
- [ ] Добавить поле `currency` в transactions
- [ ] SQL миграция `010_rub_payments.sql`
- [ ] Тестирование

---

## Примечания

- **Чеки 54-ФЗ:** Пока не реализуем (тестируем идею)
- **Минимальная сумма ЮKassa:** ~10-50₽ (20₽ за 2 кредита должно пройти)
- **Возвраты:** Через личный кабинет ЮKassa вручную
