# Atomic Credit Deduction

## Проблема

Обнаружен критический баг: пользователь `@diiilina` сделал 2 генерации, имея только 1 кредит.

### Причина: Race Condition

Старый код списания кредитов:

```typescript
// 1. Читаем баланс
const user = await getUser(userId); // credits = 1

// 2. Проверяем
if (user.credits < 1) return; // OK, credits = 1

// 3. Списываем (НЕ АТОМАРНО!)
await supabase
  .from("users")
  .update({ credits: user.credits - 1 }) // credits = 1 - 1 = 0
  .eq("id", user.id);
```

**Сценарий race condition:**

```
Время   Запрос A                    Запрос B
─────   ────────                    ────────
t1      getUser() → credits=1
t2                                  getUser() → credits=1
t3      check: 1 >= 1 ✓
t4                                  check: 1 >= 1 ✓
t5      UPDATE credits = 1-1 = 0
t6                                  UPDATE credits = 1-1 = 0
t7      enqueueJob() ✓
t8                                  enqueueJob() ✓

Результат: 2 job'а созданы, списан только 1 кредит
```

## Решение

### 1. SQL функция для атомарного списания

```sql
CREATE OR REPLACE FUNCTION deduct_credits(p_user_id uuid, p_amount int)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  rows_affected int;
BEGIN
  UPDATE users 
  SET credits = credits - p_amount
  WHERE id = p_user_id AND credits >= p_amount;  -- Проверка в WHERE!
  
  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  
  RETURN rows_affected > 0;
END;
$$;
```

**Почему это работает:**
- `UPDATE ... WHERE credits >= p_amount` — атомарная операция
- Если два запроса придут одновременно, только один выполнит UPDATE
- Второй получит `rows_affected = 0` и вернёт `false`

### 2. Использование в коде

```typescript
// Атомарное списание
const { data: deducted } = await supabase
  .rpc("deduct_credits", { p_user_id: user.id, p_amount: creditsNeeded });

if (!deducted) {
  // Кредиты уже списаны другим запросом (race condition)
  await ctx.reply("Недостаточно кредитов");
  return;
}

// Только после успешного списания создаём job
await enqueueJob(session.id, user.id);
```

## Места исправления

| Файл | Функция | Описание |
|------|---------|----------|
| `src/index.ts` | `startGeneration()` | Основное списание при генерации |
| `src/index.ts` | `successful_payment` handler | Авто-продолжение после покупки |

## Миграция

```bash
psql $DATABASE_URL -f sql/030_atomic_credit_deduction.sql
```

## Тестирование

1. Проверить что генерация работает с 1 кредитом
2. Проверить что при 0 кредитов показывается меню покупки
3. Мониторить логи на "race condition detected"

## Статус

- [x] SQL миграция создана
- [x] Код обновлён
- [ ] Миграция применена
- [ ] Редеплой bot
- [ ] Редеплой worker
