# UTM-трекинг: сохранение источника трафика

## Проблема

Пользователи приходят из рекламы (Яндекс Директ, Google Ads и т.д.), но мы не знаем откуда. Нужно сохранять UTM-метки при регистрации для аналитики трафика.

## Ограничение Telegram

Telegram deep link (`https://t.me/Bot?start=PAYLOAD`) передаёт боту **только** значение `start=`. Всё остальное из URL (`&utm_source=...`) Telegram игнорирует.

Пример:
```
https://t.me/Photo_2_StickerBot?start=from_web&utm_source=ya&utm_medium=cpc&utm_campaign=706852522
```
Бот получит только `ctx.startPayload = "from_web"`. UTM-параметры потеряются.

## Решение: кодировать UTM в start-параметр

Формат start-параметра (до 64 символов):
```
start=ya_cpc_706852522_17579526984
```
Структура: `{source}_{medium}_{campaign_id}_{content_id}`

### Примеры ссылок для рекламных кампаний

**Яндекс Директ:**
```
https://t.me/Photo_2_StickerBot?start=ya_cpc_706852522
```

**Google Ads:**
```
https://t.me/Photo_2_StickerBot?start=gads_cpc_123456
```

**Органика (ссылка с сайта):**
```
https://t.me/Photo_2_StickerBot?start=web
```

**Без метки (обычный /start):**
```
ctx.startPayload = "" или undefined
```

---

## Миграция БД

```sql
-- 048_utm_tracking.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS start_payload text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_medium text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_campaign text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_content text;

CREATE INDEX IF NOT EXISTS idx_users_utm_source ON users(utm_source);
CREATE INDEX IF NOT EXISTS idx_users_utm_campaign ON users(utm_campaign);
```

---

## Парсинг start_payload

```typescript
function parseStartPayload(payload: string): {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
} {
  if (!payload) return { source: null, medium: null, campaign: null, content: null };

  // Формат: {source}_{medium}_{campaign}_{content}
  // Примеры: "ya_cpc_706852522_17579526984", "ya_cpc_706852522", "web", "from_web"
  const parts = payload.split("_");

  // Известные источники
  const knownSources = ["ya", "gads", "fb", "ig", "vk", "tg", "web"];
  const knownMediums = ["cpc", "cpm", "organic", "social", "referral"];

  if (parts.length >= 2 && knownSources.includes(parts[0]) && knownMediums.includes(parts[1])) {
    return {
      source: parts[0],
      medium: parts[1],
      campaign: parts[2] || null,
      content: parts[3] || null,
    };
  }

  // Простые метки: "web", "from_web" и т.д.
  return {
    source: payload,
    medium: null,
    campaign: null,
    content: null,
  };
}
```

---

## Изменения в коде

### `src/index.ts` — обработчик `/start`

В блоке создания нового пользователя:

```typescript
bot.start(async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  let user = await getUser(telegramId);

  if (!user) {
    // Парсим start payload
    const startPayload = (ctx as any).startPayload || "";
    const utm = parseStartPayload(startPayload);

    const { data: created } = await supabase
      .from("users")
      .insert({
        telegram_id: telegramId,
        lang,
        language_code: languageCode || null,
        credits: 1,
        has_purchased: false,
        username: ctx.from?.username || null,
        env: config.appEnv,
        // UTM tracking
        start_payload: startPayload || null,
        utm_source: utm.source,
        utm_medium: utm.medium,
        utm_campaign: utm.campaign,
        utm_content: utm.content,
      })
      .select("*")
      .single();

    // Алерт с UTM
    sendNotification({
      type: "new_user",
      message: `@${ctx.from?.username || "no_username"} (${telegramId})\n🌐 Язык: ${languageCode}\n📢 Источник: ${utm.source || "direct"}`,
    }).catch(console.error);
  }
});
```

---

## SQL-запросы для аналитики

### Пользователи по источникам
```sql
SELECT utm_source, utm_medium, COUNT(*) as users
FROM users
WHERE utm_source IS NOT NULL
GROUP BY utm_source, utm_medium
ORDER BY users DESC;
```

### Пользователи по кампаниям Яндекс Директ
```sql
SELECT utm_campaign, COUNT(*) as users,
  COUNT(*) FILTER (WHERE has_purchased) as paid_users,
  SUM(credits) FILTER (WHERE has_purchased) as total_credits
FROM users
WHERE utm_source = 'ya'
GROUP BY utm_campaign
ORDER BY users DESC;
```

### Конверсия по источникам
```sql
SELECT
  COALESCE(utm_source, 'direct') as source,
  COUNT(*) as total_users,
  COUNT(*) FILTER (WHERE has_purchased) as paid_users,
  ROUND(100.0 * COUNT(*) FILTER (WHERE has_purchased) / NULLIF(COUNT(*), 0), 1) as conversion_pct
FROM users
GROUP BY utm_source
ORDER BY total_users DESC;
```

---

## Настройка рекламы (Яндекс Директ)

В Яндекс Директ в поле "Ссылка" указать:
```
https://t.me/Photo_2_StickerBot?start=ya_cpc_{campaign_id}
```

Где `{campaign_id}` — подстановка ID кампании из Директа.

Для более детальной аналитики (с ID объявления):
```
https://t.me/Photo_2_StickerBot?start=ya_cpc_{campaign_id}_{ad_id}
```

---

## Чеклист

- [ ] Миграция: добавить колонки utm_* в users
- [ ] Функция `parseStartPayload()` в index.ts
- [ ] Парсинг `ctx.startPayload` при создании пользователя
- [ ] Сохранение utm-полей при insert в users
- [ ] UTM в алерте о новом пользователе
- [ ] Обновить ссылки в рекламных кампаниях
- [ ] NOTIFY pgrst, 'reload schema' после миграции
