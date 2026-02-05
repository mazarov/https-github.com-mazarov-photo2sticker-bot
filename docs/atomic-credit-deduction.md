# Atomic Credit Deduction & First Free Generation

## Проблема 1: Race Condition при списании кредитов

Пользователь `@diiilina` сделал 2 генерации, имея только 1 кредит.

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

## Проблема 2: Double First Free Generation

Пользователь мог получить 2 бесплатных генерации, быстро нажав "изменить стиль" после первой.

### Причина

`total_generations` инкрементировался в worker ПОСЛЕ обработки, а проверка `isFirstFree` в bot ДО создания job:

```
Время   Запрос A                    Запрос B
─────   ────────                    ────────
t1      getUser() → generations=0
t2      isFirstFree=true ✓
t3      enqueueJob()
t4                                  getUser() → generations=0 (ещё не обновлён!)
t5                                  isFirstFree=true ✓
t6                                  enqueueJob()

Результат: 2 бесплатных генерации
```

### Решение

SQL функция `claim_first_free_generation()` атомарно проверяет и устанавливает `total_generations = 1`:

```sql
CREATE OR REPLACE FUNCTION claim_first_free_generation(p_user_id uuid)
RETURNS boolean
AS $$
  UPDATE users SET total_generations = 1
  WHERE id = p_user_id AND (total_generations IS NULL OR total_generations = 0);
  RETURN ROW_COUNT > 0;
$$;
```

## Места исправления

| Файл | Функция | Описание |
|------|---------|----------|
| `src/index.ts` | `startGeneration()` | Атомарное списание кредитов + claim first free |
| `src/index.ts` | `successful_payment` handler | Авто-продолжение после покупки |
| `src/worker.ts` | `processJob()` | Убран increment total_generations (перенесён в bot) |

## Миграции

```bash
psql $DATABASE_URL -f sql/030_atomic_credit_deduction.sql
psql $DATABASE_URL -f sql/031_atomic_first_generation.sql
```

## Тестирование

1. Проверить что генерация работает с 1 кредитом
2. Проверить что при 0 кредитов показывается меню покупки
3. Мониторить логи на "race condition detected"

## Статус

- [x] SQL миграция 030 создана (deduct_credits)
- [x] SQL миграция 031 создана (claim_first_free_generation, increment_generations)
- [x] Код обновлён
- [x] Миграция 030 применена
- [ ] Миграция 031 применена
- [ ] Редеплой bot
- [ ] Редеплой worker
