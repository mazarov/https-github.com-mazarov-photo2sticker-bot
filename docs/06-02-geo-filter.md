# Geo-фильтрация: Whitelist языков

## Проблема
Пользователи из бедных стран съедают бесплатные кредиты без конверсии в оплату.

## Решение
Давать бесплатные кредиты только пользователям из целевых регионов (по `language_code`).

---

## Источник данных

### Откуда берём `language_code`

```typescript
ctx.from?.language_code  // Telegraf/Telegram Bot API
```

**Telegram Bot API** возвращает в объекте `User`:
- `language_code` (string, optional) — [IETF language tag](https://en.wikipedia.org/wiki/IETF_language_tag) языка интерфейса Telegram пользователя

### Когда доступно

| Момент | Доступно? | Пример |
|--------|-----------|--------|
| `/start` команда | ✅ Да | `ctx.from.language_code` |
| Любое сообщение | ✅ Да | `ctx.from.language_code` |
| Callback query | ✅ Да | `ctx.from.language_code` |
| Webhook (без ctx) | ❌ Нет | Нужно из update |

### Когда проверяем и сохраняем

**Момент:** При регистрации нового пользователя в `/start`

```typescript
bot.start(async (ctx) => {
  const telegramId = ctx.from?.id;
  let user = await getUser(telegramId);
  
  if (!user) {
    // === ЗДЕСЬ берём language_code ===
    const languageCode = ctx.from?.language_code || "";  // "ru", "de", "hi", etc.
    const lang = languageCode.startsWith("ru") ? "ru" : "en";  // UI язык
    
    // Проверяем whitelist
    const freeCredits = isAllowedLanguage(languageCode) ? 2 : 0;
    
    // Сохраняем в БД
    await supabase.from("users").insert({ 
      telegram_id: telegramId, 
      lang,
      language_code: languageCode || null,  // сохраняем оригинал
    });
    
    // Начисляем кредиты (если разрешено)
    if (freeCredits > 0) {
      await supabase.from("transactions").insert({ ... });
    }
  }
});
```

---

## Whitelist языков

```typescript
const ALLOWED_LANG_PREFIXES = [
  // Россия + СНГ
  "ru",  // Russian
  "uk",  // Ukrainian
  "be",  // Belarusian
  "kk",  // Kazakh
  "uz",  // Uzbek
  "ky",  // Kyrgyz
  "tg",  // Tajik
  "az",  // Azerbaijani
  "hy",  // Armenian
  "ka",  // Georgian
  
  // США + Англоязычные
  "en",  // English (USA, UK, Canada, Australia, etc.)
  
  // Европа
  "de",  // German
  "fr",  // French
  "es",  // Spanish
  "it",  // Italian
  "pt",  // Portuguese
  "nl",  // Dutch
  "pl",  // Polish
  "cs",  // Czech
  "sk",  // Slovak
  "hu",  // Hungarian
  "ro",  // Romanian
  "bg",  // Bulgarian
  "el",  // Greek
  "sv",  // Swedish
  "da",  // Danish
  "fi",  // Finnish
  "no",  // Norwegian
  "et",  // Estonian
  "lv",  // Latvian
  "lt",  // Lithuanian
  "sl",  // Slovenian
  "hr",  // Croatian
  "sr",  // Serbian
  "tr",  // Turkish
];
```

## Заблокированные регионы (0 кредитов)

- 🇮🇳 Индия (hi)
- 🇧🇩 Бангладеш (bn)
- 🇮🇩 Индонезия (id)
- 🇻🇳 Вьетнам (vi)
- 🇵🇭 Филиппины (tl)
- 🇹🇭 Таиланд (th)
- 🇮🇷 Иран (fa)
- 🇵🇰 Пакистан (ur)
- Арабские страны (ar)
- Африка
- Латинская Америка (кроме испано/португалоязычных)
- И все остальные, не в whitelist

---

## Реализация

### 1. Добавить в config.ts

```typescript
// Whitelist языков для бесплатных кредитов
allowedLangPrefixes: [
  // Россия + СНГ
  "ru", "uk", "be", "kk", "uz", "ky", "tg", "az", "hy", "ka",
  // США + Англоязычные + Европа
  "en", "de", "fr", "es", "it", "pt", "nl", "pl", "cs", "sk",
  "hu", "ro", "bg", "el", "sv", "da", "fi", "no", "et", "lv",
  "lt", "sl", "hr", "sr", "tr",
],
```

### 2. Хелпер функция

```typescript
function isAllowedLanguage(languageCode: string): boolean {
  const code = (languageCode || "").toLowerCase();
  return config.allowedLangPrefixes.some(prefix => code.startsWith(prefix));
}
```

### 3. Изменить /start (регистрация)

```typescript
// Сейчас:
await supabase.from("transactions").insert({
  user_id: user.id,
  amount: 2,  // всегда 2
  ...
});

// После:
const languageCode = ctx.from?.language_code || "";
const freeCredits = isAllowedLanguage(languageCode) ? 2 : 0;

if (freeCredits > 0) {
  await supabase.from("transactions").insert({
    user_id: user.id,
    amount: freeCredits,
    ...
  });
}
```

### 4. SQL миграция — сохранять оригинальный language_code

```sql
-- 038_language_code.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS language_code text;
```

### 5. Сохранять language_code при регистрации

```typescript
await supabase.from("users").insert({ 
  telegram_id: telegramId, 
  lang,  // ru или en (для UI)
  language_code: ctx.from?.language_code || null,  // оригинальный код
  ...
});
```

---

## Чеклист

- [ ] SQL миграция `038_language_code.sql`
- [ ] Добавить `allowedLangPrefixes` в config.ts
- [ ] Функция `isAllowedLanguage()`
- [ ] Сохранять `language_code` при регистрации
- [ ] Условное начисление кредитов в /start
- [ ] Тестирование

---

## Примечания

- `language_code` — язык интерфейса Telegram, не гарантирует страну
- Пользователь может сменить язык в настройках Telegram
- Для более точной фильтрации нужны платные сервисы (IP geolocation)
