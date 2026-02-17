# Abandoned Cart Alerting — Алерты о брошенных корзинах

## Цель
Уведомлять команду о пользователях, которые не завершили оплату, для ручного follow-up или анализа.

## Триггер

- Транзакция в статусе `created` более **15 минут**
- По этой транзакции ещё не отправляли алерт (`alert_sent = false`)

## Канал

- `ALERT_CHANNEL_ID` (тот же что для других алертов)

## Формат алерта

```
🛒 Брошенная корзина

👤 @username (123456789)
📦 Пакет: Лайт (10 кредитов)
💰 Сумма: 150⭐
⏱ Прошло: 15 мин

[Написать пользователю]
```

### Кнопка действия

Deep link на support bot для ответа пользователю:

```typescript
Markup.button.url(
  "Написать пользователю",
  `https://t.me/${config.supportBotUsername}?start=reply_${telegram_id}`
)
```

## База данных

### Новое поле в transactions

```sql
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS alert_sent boolean DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS alert_sent_at timestamptz;
```

## Реализация

### Cron Job (вместе с discount job)

Запускать каждые 5 минут:

```typescript
async function processAbandonedCartAlerts() {
  // Найти транзакции старше 15 минут без алерта
  const { data: abandoned } = await supabase
    .from("transactions")
    .select("*, users(*)")
    .eq("state", "created")
    .eq("alert_sent", false)
    .gt("price", 0)
    .lt("created_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());

  for (const tx of abandoned || []) {
    const user = tx.users;
    const minutesSince = Math.round((Date.now() - new Date(tx.created_at).getTime()) / 60000);
    
    // Определить название пакета
    const packName = tx.amount === 10 ? "Лайт" : tx.amount === 30 ? "Бро" : `${tx.amount} кредитов`;
    
    const message = `🛒 Брошенная корзина

👤 @${user.username || 'no_username'} (${user.telegram_id})
📦 Пакет: ${packName} (${tx.amount} кредитов)
💰 Сумма: ${tx.price}⭐
⏱ Прошло: ${minutesSince} мин`;

    // Отправить алерт
    await sendNotification({
      type: "abandoned_cart",
      message,
      buttons: [[{
        text: "Написать пользователю",
        url: `https://t.me/${config.supportBotUsername}?start=reply_${user.telegram_id}`
      }]]
    });
    
    // Отметить что алерт отправлен
    await supabase
      .from("transactions")
      .update({ alert_sent: true, alert_sent_at: new Date().toISOString() })
      .eq("id", tx.id);
  }
}
```

## Порядок событий

```
0 мин  — Пользователь выбирает тариф, создаётся транзакция
15 мин — Алерт в канал команды
30 мин — Сообщение пользователю со скидкой
```

## Чеклист

- [x] Миграция: поле `alert_sent` в transactions
- [x] Функция отправки алерта с кнопкой
- [x] Обновить `sendNotification` для поддержки кнопок
- [x] Cron job каждые 5 минут
- [ ] Применить миграцию в Supabase
- [ ] Тестирование
