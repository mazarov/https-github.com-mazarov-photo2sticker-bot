# UTM-трекинг: сохранение источника трафика

## Флоу пользователя

```
Реклама (Яндекс Директ) → Лендинг (с UTM в URL) → Кнопка "Открыть бота" → Telegram бот
```

1. Пользователь кликает объявление в Яндекс Директ
2. Попадает на лендинг с UTM-параметрами в URL:
   ```
   https://photo2sticker.ru/?utm_source=ya&utm_medium=cpc&utm_campaign=706852522&utm_content=17579526984&utm_term=сделать+стикер
   ```
3. На лендинге нажимает кнопку "Открыть бота"
4. Кнопка ведёт на Telegram deep link с закодированными UTM:
   ```
   https://t.me/Photo_2_StickerBot?start=ya_cpc_706852522_17579526984
   ```
5. Бот получает `startPayload`, парсит UTM, сохраняет в БД

---

## Часть 1: Лендинг (JS)

### Задача
На лендинге динамически формировать Telegram-ссылку, пробрасывая UTM из URL страницы в `start=` параметр бота.

### Ограничение Telegram
Deep link `https://t.me/Bot?start=PAYLOAD` передаёт боту **только** значение `start=` (до 64 символов, допустимы `A-Za-z0-9_-`). Всё остальное из URL Telegram игнорирует.

### Формат start-параметра
```
{source}_{medium}_{campaign_id}_{content_id}
```

Примеры:
| URL-параметры | start payload |
|---|---|
| `utm_source=ya&utm_medium=cpc&utm_campaign=706852522&utm_content=17579526984` | `ya_cpc_706852522_17579526984` |
| `utm_source=gads&utm_medium=cpc&utm_campaign=123` | `gads_cpc_123` |
| без UTM | `web` |

### JS-скрипт для лендинга

```javascript
(function() {
  const params = new URLSearchParams(window.location.search);
  const source   = params.get('utm_source')   || '';
  const medium   = params.get('utm_medium')    || '';
  const campaign = params.get('utm_campaign')  || '';
  const content  = params.get('utm_content')   || '';

  let startPayload = 'web'; // дефолт — пришёл с сайта без UTM
  if (source) {
    const parts = [source, medium, campaign, content].filter(Boolean);
    // Очищаем от недопустимых символов, ограничиваем 64 символами
    startPayload = parts.join('_').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 64);
  }

  const botLink = `https://t.me/Photo_2_StickerBot?start=${startPayload}`;

  // Обновляем все кнопки с классом .open-bot-btn
  document.querySelectorAll('.open-bot-btn').forEach(btn => {
    btn.href = botLink;
  });
})();
```

### Где разместить
- В конце `<body>` на лендинге, или
- В GTM / Tilda custom code блоке

---

## Часть 2: Бот (уже реализовано)

### Миграция БД — `sql/048_utm_tracking.sql`
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS start_payload text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_source text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_medium text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_campaign text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_content text;

CREATE INDEX IF NOT EXISTS idx_users_utm_source ON users(utm_source);
CREATE INDEX IF NOT EXISTS idx_users_utm_campaign ON users(utm_campaign);
```

После применения выполнить:
```sql
NOTIFY pgrst, 'reload schema';
```

### Парсинг в боте — `src/index.ts`
Функция `parseStartPayload()` разбирает payload:
- `ya_cpc_706852522_17579526984` → `{ source: "ya", medium: "cpc", campaign: "706852522", content: "17579526984" }`
- `web` → `{ source: "web", medium: null, campaign: null, content: null }`
- пустой → `{ source: null, medium: null, campaign: null, content: null }`

Известные источники: `ya`, `gads`, `fb`, `ig`, `vk`, `tg`, `web`
Известные medium: `cpc`, `cpm`, `organic`, `social`, `referral`

### Сохранение при регистрации
При создании нового пользователя в `/start` хендлере UTM-поля записываются в таблицу `users`.

### Алерт о новом пользователе
Включает источник трафика: `📢 Источник: ya/cpc кампания:706852522`

---

## Часть 3: Аналитика (SQL-запросы)

### Пользователи по источникам
```sql
SELECT
  COALESCE(utm_source, 'direct') as source,
  utm_medium,
  COUNT(*) as users
FROM users
WHERE created_at > now() - interval '30 days'
GROUP BY utm_source, utm_medium
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

### Пользователи по кампаниям Яндекс Директ
```sql
SELECT
  utm_campaign,
  COUNT(*) as users,
  COUNT(*) FILTER (WHERE has_purchased) as paid_users
FROM users
WHERE utm_source = 'ya'
GROUP BY utm_campaign
ORDER BY users DESC;
```

---

## Чеклист

- [x] Миграция: колонки utm_* в users — `sql/048_utm_tracking.sql`
- [x] Функция `parseStartPayload()` в `src/index.ts`
- [x] Сохранение UTM при создании пользователя
- [x] UTM в алерте о новом пользователе
- [x] Закоммичено и запушено в main
- [ ] Применить миграцию в Supabase + `NOTIFY pgrst, 'reload schema'`
- [ ] Добавить JS-скрипт на лендинг (кнопка `.open-bot-btn`)
- [ ] Обновить ссылки в рекламных кампаниях (если используются прямые ссылки на бота)
- [ ] Проверить: зайти с UTM → убедиться что utm_source сохранился в users
