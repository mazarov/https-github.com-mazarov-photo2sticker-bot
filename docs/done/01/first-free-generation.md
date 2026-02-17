# Первая бесплатная генерация (First Free Generation)

## Цель

Повысить конверсию из free → paid за счёт вау-эффекта от первой генерации стикера в максимальном качестве.

## Бизнес-логика

### Первая генерация (total_generations = 0)
- **Бесплатная** — кредиты не списываются
- **Модель:** `gemini-3-pro-vision` (Nano Banana Pro)
- **Качество:** максимальное
- **Любой тип:** style, emotion, motion, text

### Все последующие генерации (total_generations > 0)
- **Платные** — требуют кредиты
- **Модель:** `gemini-2.5-flash-image`
- **Стандартный flow**

## Технические изменения

### 1. Миграция БД

```sql
-- sql/027_first_free_generation.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_generations integer DEFAULT 0;
```

### 2. Изменения в index.ts

В функции `startGeneration`:

```typescript
// Проверка первой бесплатной генерации
const isFirstGeneration = user.total_generations === 0;

if (!isFirstGeneration) {
  // Стандартная проверка кредитов
  if (user.credits < creditsNeeded) {
    // показать меню покупки
    return;
  }
  // Списать кредиты
  await supabase
    .from("users")
    .update({ credits: user.credits - creditsNeeded })
    .eq("id", user.id);
}

// Создать job с флагом is_first_free
await supabase.from("jobs").insert({
  session_id: session.id,
  status: "pending",
  is_first_free: isFirstGeneration,  // новое поле
});
```

### 3. Изменения в worker.ts

```typescript
// Выбор модели
const model = job.is_first_free 
  ? "gemini-3-pro-vision"      // Nano Banana Pro
  : "gemini-2.5-flash-image";  // Standard

const geminiRes = await axios.post(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  // ...
);

// После успешной генерации — инкремент счётчика
await supabase
  .from("users")
  .update({ total_generations: user.total_generations + 1 })
  .eq("id", user.id);
```

## Схема потока

```
┌─────────────────────────────────────────┐
│         Пользователь шлёт фото          │
└──────────────────┬──────────────────────┘
                   │
         ┌─────────▼──────────────┐
         │ total_generations = 0? │
         └─────────┬──────────────┘
                   │
       ┌───────────┴───────────┐
       │ ДА (первая)           │ НЕТ
       ▼                       ▼
┌──────────────┐      ┌──────────────────┐
│ FREE         │      │ Проверка credits │
│ gemini-3-pro │      │ >= 1             │
│ -vision      │      └────────┬─────────┘
└──────┬───────┘               │
       │                ┌──────┴──────┐
       │                │ < 1         │ >= 1
       │                ▼             ▼
       │         ┌──────────┐  ┌─────────────┐
       │         │ Buy menu │  │ Deduct 1    │
       │         └──────────┘  │ gemini-2.5  │
       │                       │ -flash      │
       │                       └─────────────┘
       ▼                              │
┌──────────────────────────────────────┐
│      После успеха:                   │
│      total_generations++             │
└──────────────────────────────────────┘
```

## Стоимость

| Модель | Цена |
|--------|------|
| gemini-2.5-flash-image | ~$0.0001 / изображение |
| gemini-3-pro-vision | ~$0.0005 / изображение |

**Вывод:** Первая генерация 5x дороже, но это инвестиция в конверсию.

## UX

Без изменений — пользователь не видит разницы в интерфейсе.
Разница только в качестве результата.

## Checklist

- [x] Создать миграцию `sql/027_first_free_generation.sql`
- [x] Добавить `is_first_free` в таблицу `jobs`
- [x] Обновить `index.ts` — проверка first free перед кредитами
- [x] Обновить `worker.ts` — выбор модели + инкремент счётчика
- [ ] Выполнить миграцию в Supabase
- [ ] Деплой
- [ ] Тестирование с новым пользователем
- [ ] Мониторинг конверсии
