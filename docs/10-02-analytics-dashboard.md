# Аналитика и дашборд

**Приоритет:** Средний — запускать параллельно с расширением трафика

---

## SQL-дашборд для отслеживания ROI

### 1. Пользователи и конверсия по кампаниям (30 дней)

```sql
SELECT
  utm_campaign,
  utm_medium,
  COUNT(*) as users,
  COUNT(*) FILTER (WHERE total_generations > 0) as active_users,
  COUNT(*) FILTER (WHERE has_purchased) as paid_users,
  ROUND(100.0 * COUNT(*) FILTER (WHERE has_purchased) / NULLIF(COUNT(*), 0), 1) as conversion_pct,
  COALESCE(SUM(total_generations), 0) as total_gens
FROM users
WHERE utm_source IN ('ya', 'yandex')
  AND created_at > now() - interval '30 days'
GROUP BY utm_campaign, utm_medium
ORDER BY users DESC;
```

### 2. Стоимость привлечения платящего (CPA)

```sql
-- Вручную добавить расход по кампании
WITH campaign_costs AS (
  SELECT '706852522' as campaign, 5000 as cost
  UNION ALL
  SELECT '17579526984', 3000
)
SELECT
  u.utm_campaign,
  cc.cost as spend_rub,
  COUNT(*) as users,
  COUNT(*) FILTER (WHERE u.has_purchased) as paid,
  ROUND(cc.cost::numeric / NULLIF(COUNT(*), 0), 0) as cpa_user,
  ROUND(cc.cost::numeric / NULLIF(COUNT(*) FILTER (WHERE u.has_purchased), 0), 0) as cpa_paid
FROM users u
JOIN campaign_costs cc ON u.utm_campaign = cc.campaign
WHERE u.utm_source IN ('ya', 'yandex')
  AND u.created_at > now() - interval '30 days'
GROUP BY u.utm_campaign, cc.cost
ORDER BY cpa_paid;
```

### 3. Воронка по дням (когортный анализ)

```sql
SELECT
  date_trunc('day', created_at)::date as day,
  COUNT(*) as registrations,
  COUNT(*) FILTER (WHERE total_generations > 0) as used_bot,
  COUNT(*) FILTER (WHERE has_purchased) as purchased
FROM users
WHERE utm_source IN ('ya', 'yandex')
  AND created_at > now() - interval '14 days'
GROUP BY day
ORDER BY day;
```

### 4. Все источники трафика (общая картина)

```sql
SELECT
  COALESCE(utm_source, 'organic') as source,
  COUNT(*) as users,
  COUNT(*) FILTER (WHERE total_generations > 0) as active,
  COUNT(*) FILTER (WHERE has_purchased) as paid,
  ROUND(100.0 * COUNT(*) FILTER (WHERE has_purchased) / NULLIF(COUNT(*), 0), 1) as conv_pct
FROM users
WHERE created_at > now() - interval '30 days'
GROUP BY COALESCE(utm_source, 'organic')
ORDER BY users DESC;
```

### 5. Retention: возвращаемость по когортам

```sql
SELECT
  date_trunc('week', u.created_at)::date as cohort_week,
  COUNT(DISTINCT u.id) as cohort_size,
  COUNT(DISTINCT u.id) FILTER (WHERE u.total_generations >= 2) as returned,
  ROUND(100.0 * COUNT(DISTINCT u.id) FILTER (WHERE u.total_generations >= 2) / 
    NULLIF(COUNT(DISTINCT u.id), 0), 1) as retention_pct
FROM users u
WHERE u.created_at > now() - interval '8 weeks'
GROUP BY cohort_week
ORDER BY cohort_week;
```

### 6. Доход по источникам (Stars)

```sql
SELECT
  COALESCE(u.utm_source, 'organic') as source,
  COUNT(t.*) as transactions,
  SUM(t.amount) as total_stars,
  ROUND(AVG(t.amount), 0) as avg_stars
FROM transactions t
JOIN users u ON t.user_id = u.id
WHERE t.created_at > now() - interval '30 days'
  AND t.status = 'completed'
GROUP BY COALESCE(u.utm_source, 'organic')
ORDER BY total_stars DESC;
```

---

## Автоматический еженедельный отчёт

Раз в неделю бот отправляет в support-канал сводку:

```
📊 Недельный отчёт по трафику (3-10 фев)

Новые пользователи: 156
├ Яндекс Директ: 89 (57%)
├ Органик/direct: 52 (33%)
└ Реферал: 15 (10%)

Конверсия в покупку:
├ Яндекс: 12/89 = 13.5%
├ Органик: 8/52 = 15.4%
└ Реферал: 4/15 = 26.7%

Топ кампании:
1. telegram_keywords: 34 юзера, 6 покупок (17.6%)
2. free_online: 28 юзеров, 3 покупки (10.7%)
3. bot_keywords: 15 юзеров, 2 покупки (13.3%)

💰 Общий доход: 12,400 Stars
```

**Реализация:** cron-задача или отдельный worker, раз в неделю (понедельник, 10:00).

---

## Метрики успеха

| Метрика | Текущая | Цель (через 1 мес) |
|---------|---------|---------------------|
| Уникальных посетителей/мес | ? | 3,000+ |
| Конверсия лендинг → бот | ? | 25-35% |
| Конверсия бот → покупка | ? | 10-15% |
| CPA (стоимость платящего) | ? | < 300₽ |
| ROAS | ? | > 2.0 |

---

## Чеклист

- [ ] Запустить SQL-запросы 1-6 и проверить данные
- [ ] Сохранить запросы как SQL-сниппеты в Supabase Dashboard
- [ ] Настроить еженедельный автоотчёт в support-канал (опционально)
- [ ] После 2 недель трафика: первая оценка CPA и ROAS
- [ ] Добавить таблицу campaign_costs для автоматического расчёта CPA
