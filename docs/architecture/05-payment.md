# Оплата — Telegram Stars

## Экономика

### Курсы и себестоимость

| Параметр | Значение |
|---|---|
| 100 Telegram Stars | $1.30 |
| 1 Star | $0.013 ≈ 1.04 ₽ |
| Курс ₽/$ | 80 ₽ за $1 |
| 1 пак стикеров | 10 кредитов (10 генераций) |
| Себестоимость 1 пака | **15 ₽** |
| Себестоимость 1 генерации | ~1.5 ₽ |

### Формула маржи

```
Маржа % = (Выручка ₽ − Себестоимость ₽) / Себестоимость ₽ × 100

Выручка ₽ = Stars × 1.04
Себестоимость ₽ = (Кредиты / 10) × 15₽
```

Для trial-пакета себестоимость считается от **итого кредитов** (оплаченных + бонусных),
потому что генерации расходуют ресурсы независимо от того, оплачены они или нет.

---

## Пакеты кредитов

### Основные пакеты

| ID | Название | Кредиты | Бонус | Итого | Цена Stars | ~₽ | Stars/ген | Маржа % | Условие |
|---|---|---|---|---|---|---|---|---|---|
| test | 🔧 Тест | 1 | — | 1 | 1⭐ | 1₽ | 1.0 | — | adminOnly |
| try | 🎁 Попробуй | 5 | +5 | **10** | 49⭐ | 51₽ | 4.9 | 247% | trialOnly (1я покупка) |
| start | ⭐ Старт | 10 | — | 10 | 75⭐ | 78₽ | 7.5 | 420% | — |
| pop | 💎 Поп | 30 | — | 30 | 175⭐ | 182₽ | 5.8 | 304% | — |
| pro | 👑 Про | 100 | — | 100 | 500⭐ | 520₽ | 5.0 | 247% | — |
| max | 🚀 Макс | 250 | — | 250 | 1125⭐ | 1170₽ | 4.5 | 212% | — |

### Скидочные пакеты (hidden)

Не показываются в UI. Используются для промо, abandoned cart, admin-дисконтов.

| Скидка | Попробуй | Старт | Поп | Про | Макс |
|---|---|---|---|---|---|
| Базовая | 49⭐ | 75⭐ | 175⭐ | 500⭐ | 1125⭐ |
| -10% | 44⭐ | 68⭐ | 158⭐ | 450⭐ | 1013⭐ |
| -15% | 42⭐ | 64⭐ | 149⭐ | 425⭐ | 956⭐ |
| -25% | 37⭐ | 56⭐ | 131⭐ | 375⭐ | 844⭐ |

### Trial-пакет: bonus_credits

Пакет `🎁 Попробуй` использует `bonus_credits`:
- Пользователь платит за 5 кредитов, получает 10 (5 + 5 бонус).
- В `successful_payment` начисляется `credits + bonus_credits`.
- Скрывается после `has_purchased = true`.

---

## Флоу оплаты

```mermaid
sequenceDiagram
    participant U as Пользователь
    participant BOT as Bot
    participant TG as Telegram
    participant DB as PostgreSQL

    U->>BOT: Выбор пакета (pack_10_75)
    BOT->>DB: Find active created tx (TTL lock)
    alt Fresh active tx exists
        BOT->>BOT: Reuse existing transaction
    else No fresh active tx
        BOT->>DB: INSERT transaction (state: created)
    end
    BOT->>TG: sendInvoice (Stars)
    TG->>U: Показать платёжную форму

    U->>TG: Оплатить
    TG->>BOT: pre_checkout_query
    BOT->>TG: answerPreCheckoutQuery(ok: true)
    Note over BOT: Instant OK — без запросов к БД

    TG->>BOT: successful_payment
    BOT->>DB: Idempotency check (charge_id)
    BOT->>DB: UPDATE transaction → state: done
    Note over DB: Trigger: add_credits_on_transaction
    BOT->>DB: credits += pack.credits + pack.bonus_credits
    DB-->>BOT: User credits updated

    alt Первая покупка
        BOT->>DB: has_purchased = true
    end

    alt Сессия ждёт кредиты
        BOT->>BOT: Автопродолжение генерации
    end

    BOT->>U: "Кредиты зачислены! ✅"
```

## Paywall

### Когда показывается

```mermaid
flowchart TD
    START[startGeneration] --> CHECK{credits >= needed?}
    CHECK -->|Да| DEDUCT[Списать кредиты<br/>→ генерация]
    CHECK -->|Нет| PURCHASED{has_purchased?}
    PURCHASED -->|Нет| FIRST[wait_first_purchase<br/>Специальное сообщение:<br/>"Первый стикер бесплатный<br/>не получился? Купи пакет!"]
    PURCHASED -->|Да| BUY[wait_buy_credit<br/>"Кредиты закончились,<br/>выбери пакет"]
    FIRST --> PACKS[Показать пакеты]
    BUY --> PACKS
```

### Автопродолжение после оплаты

Если сессия была в `wait_first_purchase` или `wait_buy_credit`:
1. Проверяем `session.prompt_final` — есть ли готовый промпт
2. Если да — автоматически запускаем генерацию
3. Если нет — показываем сообщение "Кредиты зачислены, выбери стиль"

Это работает и для ручного режима, и для ассистента.

### Onboarding Stars offers (09-03)

- Отдельные onboarding-оферы:
  - `✨ Создать стикерпак — 75 ⭐`
  - `🙂 Сделать одну эмоцию — 25 ⭐`
- Payload для single-ветки: `buy_single_emotion`.
- Payload для full-pack ветки: `buy_onboarding_full_pack`.
- В onboarding-UI не используются термины `кредиты`, `💎`, `баланс` (прямая цена в Stars в кнопках).

## Идемпотентность

Защита от двойного зачисления:
1. `telegram_payment_charge_id` проверяется перед обработкой
2. UPDATE с условием `state = 'created'` — только первый запрос сработает
3. Recovery-path: если `created` не найден (гонка callback-ов), выполняется безопасная попытка завершить tx по `id`
4. Если charge_id уже есть — пропускаем

## Антидубль инвойсов

В `pack_select` действует единый lock на активную транзакцию (`state='created'`, TTL 15 минут):
- Повторный клик по тому же пакету переиспользует текущую transaction/payload.
- Клик по другому пакету при активной оплате блокируется сообщением пользователю.
- Новая transaction создаётся только при отсутствии свежей активной.

Это покрывает все способы входа в оплату, потому что hidden/admin/abandoned-cart тарифы идут через тот же callback `pack_{credits}_{price}`.

---

## Яндекс Метрика — офлайн-конверсии

**Назначение:** передавать факт оплаты в Яндекс.Метрику по yclid, чтобы Директ мог оптимизировать кампании на покупки (а не на клики). Подробный сценарий и настройка целей — в `docs/13-02-yandex-direct-conversions.md`.

### Кто за что отвечает

| Компонент | Роль |
|-----------|------|
| **Лендинг** (`/landing`) | Собирает `utm_*` и `yclid` из URL, формирует deep link в бота. События в Метрику **не** шлёт. |
| **Бот (API)** | Парсит start payload → сохраняет `users.yclid` (first-click). При `successful_payment` отправляет офлайн-конверсию в API Метрики. |
| **Метрика** | Принимает загрузки (multipart/form-data, CSV с UserId=yclid, Target, DateTime Unix, Price, Currency). |

### Когда отправляется конверсия

- В обработчике `successful_payment`, после зачисления кредитов.
- **Условия:** у пользователя есть `yclid` (или он извлекается из `start_payload` при пустом `users.yclid`), `transaction.price > 0`, по этой транзакции ещё не отправляли (`yandex_conversion_sent_at` пусто).
- Отправка асинхронная, не блокирует ответ пользователю. При ошибке API — алерт `metrika_error`, в `transactions` пишется `yandex_conversion_error`, повторная отправка не делается (антидубль по `yandex_conversion_sent_at`).

### Цели (Target) по пакетам

Бот шлёт в поле Target одно из значений; в Метрике должны быть созданы цели с **такими же идентификаторами** (тип «JavaScript-событие» для офлайн-загрузок):

| Пакет | Target |
|-------|--------|
| Trial (5+5) | `purchase_try` |
| Старт 10 | `purchase_start` |
| Поп 30 | `purchase_pop` |
| Про 100 | `purchase_pro` |
| Макс 250 | `purchase_max` |
| Прочее (скрытые/скидочные) | `purchase` |

### Код и конфиг

- **Модуль:** `src/lib/yandex-metrika.ts` — `sendYandexConversion()`, маппинг пакета в target через `getMetrikaTargetForPack()`.
- **Env (опционально):** `YANDEX_METRIKA_COUNTER_ID`, `YANDEX_METRIKA_TOKEN` (OAuth **access token** с правом `metrika:write` или `metrika:offline_data`). Без них отправка пропускается, в лог пишется `[metrika] Skipped` или `[metrika] Conversion skipped ... reason: no yclid`.
- **БД:** `users.yclid`, `transactions.yandex_conversion_sent_at`, `yandex_conversion_error`, `yandex_conversion_attempts` (миграция `sql/089_yclid_tracking.sql`).

### First-click

`users.yclid` заполняется только при первом переходе (или если поле было пусто). Повторный заход по ссылке с другим yclid не перезаписывает значение.

---

## Trial Credits (AI-ассистент)

AI-ассистент может давать бесплатный кредит через `grant_trial_credit`:

- **Лимит**: 20 trial credits в день (глобально)
- **Условия**: `credits = 0`, `has_purchased = false`
- **Факторы решения**: engagement, intent quality, traffic source
- **Traffic source бонус**: yandex, google и другие платные каналы получают более лёгкое одобрение

## Abandoned Cart

Транзакции в `state: created` более N минут — abandoned cart:
- Отправляется reminder пользователю
- Alert в канал для мониторинга
- Индексы: `idx_transactions_abandoned_cart`, `idx_transactions_abandoned_cart_alert`
