# Payment Optimization — Устранение таймаутов

## Проблема

Платежи через Telegram Stars периодически не проходят. При нажатии кнопки "Pay" ничего не происходит.

### Диагностика

```json
// getWebhookInfo
{
  "last_error_message": "Read timeout expired"
}
```

### Причина

`pre_checkout_query` должен быть отвечен за **< 10 секунд**. Текущий код делает DB запрос, который может тормозить:

```typescript
// Текущий код — рискованный
bot.on("pre_checkout_query", async (ctx) => {
  // DB UPDATE — может занять 1-10+ секунд при лагах Supabase
  const { data } = await supabase
    .from("transactions")
    .update({ state: "processed" })
    .eq("id", transactionId)
    .select("*");
  
  // Если DB тормозит — таймаут, платёж отменяется молча
  await ctx.answerPreCheckoutQuery(true);
});
```

### Статистика

- Все транзакции 150⭐/300⭐ в статусе `created` — ни одной `done`
- Единственная успешная оплата — тестовый пакет 1⭐ (повезло с быстрым ответом DB)

---

## Решение

### Стратегия: Минимизировать pre_checkout_query

Отвечать OK **сразу**, без DB запросов. Вся логика — в `successful_payment`.

### Изменения

**pre_checkout_query (БЫЛО):**
```typescript
bot.on("pre_checkout_query", async (ctx) => {
  const transactionId = ...;
  
  // DB запрос — риск таймаута!
  const { data } = await supabase
    .from("transactions")
    .update({ state: "processed", pre_checkout_query_id: query.id })
    .eq("id", transactionId)
    .eq("state", "created")
    .select("*");

  if (!data?.length) {
    await ctx.answerPreCheckoutQuery(false, "Transaction not found");
    return;
  }
  
  await ctx.answerPreCheckoutQuery(true);
});
```

**pre_checkout_query (СТАНЕТ):**
```typescript
bot.on("pre_checkout_query", async (ctx) => {
  const startTime = Date.now();
  console.log("=== PAYMENT: pre_checkout_query START ===");
  
  // Мгновенный ответ — без DB
  await ctx.answerPreCheckoutQuery(true);
  
  console.log("=== PAYMENT: pre_checkout_query OK ===");
  console.log("total time:", Date.now() - startTime, "ms");
});
```

**successful_payment (изменения):**
```typescript
// Изменить проверку состояния: "created" вместо "processed"
const { data: updatedTransactions } = await supabase
  .from("transactions")
  .update({
    state: "done",
    is_active: false,
    telegram_payment_charge_id: payment.telegram_payment_charge_id,
  })
  .eq("id", transactionId)
  .eq("state", "created")  // БЫЛО: "processed"
  .is("telegram_payment_charge_id", null)
  .select("*");
```

### State Flow

**Было:**
```
created → processed → done
         ↑ pre_checkout  ↑ successful_payment
```

**Станет:**
```
created → done
         ↑ successful_payment
```

---

## Безопасность

### Защиты которые СОХРАНЯЮТСЯ

| Защита | Как работает | Статус |
|--------|--------------|--------|
| Idempotency по charge_id | `telegram_payment_charge_id` уникален для каждого платежа | ✅ Сохраняется |
| Atomic update | `.eq("state", "created").is("telegram_payment_charge_id", null)` | ✅ Сохраняется |
| Защита от фейков | `successful_payment` приходит только от Telegram | ✅ Не зависит |
| Двойной клик | Telegram отправляет один `successful_payment` | ✅ Не зависит |

### Что теряем

- Возможность отклонить платёж в `pre_checkout_query` (например, "акция закончилась")
- **Мы это не используем** — всегда одобряем

### Edge Case

Теоретически: одобряем платёж для несуществующей транзакции → `successful_payment` не найдёт её → кредиты не начислятся → пользователь потеряет Stars.

**Вероятность:** Крайне низкая (транзакция создаётся за секунды до оплаты).

**Митигация:** Логировать такие случаи, возвращать Stars вручную при обращении в поддержку.

---

## Ожидаемый результат

| Метрика | Было | Станет |
|---------|------|--------|
| Время ответа pre_checkout | 500ms - 10s+ | < 100ms |
| Риск таймаута | Высокий | Нулевой |
| Успешные платежи | ~0% | ~100% |

---

## Чеклист

- [x] Упростить `pre_checkout_query` — только `answerPreCheckoutQuery(true)`
- [x] Изменить `successful_payment` — искать `state: "created"` вместо `"processed"`
- [x] Удалить поле `pre_checkout_query_id` из update (больше не нужно)
- [x] Сохранить все логи для диагностики
- [ ] Тестирование на тестовом пакете (1⭐)
- [ ] Тестирование на реальном пакете (150⭐)
- [ ] Мониторинг первых 10 платежей
