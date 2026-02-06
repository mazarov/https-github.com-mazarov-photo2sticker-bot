# Привязка оценок к стилю

## Цель
Понимать качество работы промптов по каждому стилю через анализ оценок пользователей.

## Текущее состояние
- Оценки хранятся в `sticker_ratings` с `sticker_id`
- Стиль можно получить через JOIN: `sticker_ratings → stickers → style_preset_id`
- Но это требует JOIN при каждом анализе

## Изменения

### 1. Миграция: добавить `style_preset_id` в `sticker_ratings`

```sql
-- 035_rating_style.sql
ALTER TABLE sticker_ratings ADD COLUMN IF NOT EXISTS style_preset_id text;

-- Backfill из существующих данных
UPDATE sticker_ratings sr
SET style_preset_id = s.style_preset_id
FROM stickers s
WHERE sr.sticker_id = s.id
  AND sr.style_preset_id IS NULL;

-- Индекс для быстрой аналитики
CREATE INDEX IF NOT EXISTS idx_sticker_ratings_style 
ON sticker_ratings (style_preset_id, rating) 
WHERE rating IS NOT NULL;
```

### 2. Изменить код создания рейтинга (worker.ts)

```typescript
// Было:
.insert({
  sticker_id: stickerId,
  session_id: session.id,
  user_id: session.user_id,
  telegram_id: telegramId,
  prompt_final: session.prompt_final,
})

// Стало:
.insert({
  sticker_id: stickerId,
  session_id: session.id,
  user_id: session.user_id,
  telegram_id: telegramId,
  prompt_final: session.prompt_final,
  style_preset_id: session.selected_style_id || null,  // NEW
})
```

### 3. SQL для аналитики

```sql
-- Средний рейтинг по стилям
SELECT 
  style_preset_id,
  COUNT(*) as total_ratings,
  ROUND(AVG(rating), 2) as avg_rating,
  COUNT(*) FILTER (WHERE rating >= 4) as good_ratings,
  COUNT(*) FILTER (WHERE rating <= 2) as bad_ratings
FROM sticker_ratings
WHERE rating IS NOT NULL AND style_preset_id IS NOT NULL
GROUP BY style_preset_id
ORDER BY avg_rating DESC;

-- Рейтинги за последние 7 дней
SELECT 
  style_preset_id,
  COUNT(*) as total,
  ROUND(AVG(rating), 2) as avg_rating
FROM sticker_ratings
WHERE rating IS NOT NULL 
  AND rated_at > NOW() - INTERVAL '7 days'
GROUP BY style_preset_id
ORDER BY total DESC;
```

## Логика оценок
**Не меняется** — пользователь по-прежнему оценивает стикер от 1 до 5.

## Результат
- Быстрый анализ качества по стилям без JOIN
- Возможность выявлять проблемные стили
- Данные для улучшения prompt_hint

## Checklist
- [x] Миграция `035_rating_style.sql`
- [x] Обновить worker.ts — добавить `style_preset_id` при создании рейтинга
- [ ] Выполнить миграцию в Supabase
- [ ] Тестирование
