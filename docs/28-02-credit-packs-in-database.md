# Вынос тарифов кредитов (credit packs) из кода в БД

**Область применения:** только бот **photo2sticker** (репозиторий photo2sticker-bot). Другие проекты (aiphoto и т.д.) не затрагиваются; у них свои тарифы в коде.

---

## Цель

Хранить пакеты кредитов (цены в Stars, кредиты, бонусы, метки, флаги hidden/adminOnly/trialOnly) в базе данных вместо константы `CREDIT_PACKS` в `src/index.ts` **бота photo2sticker**. Это позволит:

- Менять цены и добавлять/скрывать пакеты без деплоя.
- Разводить тарифы по окружениям (test/prod) при необходимости.
- Единый источник правды для бота и (при необходимости) лендинга/админки.

---

## Текущее состояние

- **Источник:** массив `CREDIT_PACKS` в `src/index.ts` (строки ~1473–1499).
- **Поля одного пакета:** `credits`, `bonus_credits?`, `price` (Stars), `price_rub`, `label_ru`, `label_en`, `adminOnly?`, `trialOnly?`, `hidden?`.
- **Callback:** `pack_{credits}_{price}` (например `pack_10_75`). Валидация и поиск пакета: `CREDIT_PACKS.find(p => p.credits === credits && p.price === price)`.
- **Таблица `transactions`:** хранит `amount` (кредиты), `price` (Stars); пакет не привязан по FK. Бонусные кредиты начисляются в коде: после `successful_payment` ищется пакет по `(amount, price)` и при `bonus_credits > 0` создаётся вторая транзакция с `amount = bonus_credits`, `price = 0`, `state = 'done'` (триггер добавляет кредиты).
- **Использование в коде:** `sendBuyCreditsMenu`, callback `pack_N_PRICE`, `successful_payment` (поиск пакета для бонуса и подписи), abandoned cart (поиск по amount/price для текста и кнопки скидки), админ-дисконты (фильтр по `hidden` и суффиксу `-N%`), баланс для AI (`buildBalanceInfo`), проверка trialOnly.

---

## 1. Схема БД

### 1.1. Таблица `credit_packs`

| Колонка | Тип | Ограничения | Описание |
|--------|-----|--------------|----------|
| `id` | text | PK | Уникальный идентификатор пакета (например `start`, `start_10`, `try_25`). Используется в callback или для отладки; основной резолв по паре (credits, price). |
| `credits` | int | NOT NULL | Количество оплачиваемых кредитов. |
| `bonus_credits` | int | DEFAULT 0 | Бонусные кредиты (начисляются вместе с credits). |
| `price` | int | NOT NULL | Цена в Telegram Stars. |
| `price_rub` | int | NOT NULL | Ориентир в рублях (для отображения и отчётов). |
| `label_ru` | text | NOT NULL | Название на русском (для кнопок и уведомлений). |
| `label_en` | text | NOT NULL | Название на английском. |
| `admin_only` | boolean | DEFAULT false | Показывать только админам. |
| `trial_only` | boolean | DEFAULT false | Только для первой покупки (скрывать после has_purchased). |
| `hidden` | boolean | DEFAULT false | Не показывать в основном меню; использовать по прямой ссылке/callback (промо, abandoned cart, админ-скидки). |
| `sort_order` | int | DEFAULT 0 | Порядок отображения в меню (меньше — выше). |
| `env` | text | DEFAULT 'prod' | Окружение: `prod` / `test`. Позволяет разные тарифы в тестовом и продовом боте. |
| `created_at` | timestamptz | now() | — |
| `updated_at` | timestamptz | now() | — |

**Уникальность:** один пакет в рамках окружения определяется парой `(credits, price)` и `env`. Ограничение: `UNIQUE (env, credits, price)`.

**Индексы:**

- `(env, credits, price)` — поиск пакета по callback и при successful_payment.
- `(env, hidden, admin_only, trial_only)` — выборка для меню и админ-дисконтов (при необходимости составной индекс по фильтрам).

### 1.2. Таблица `transactions`

Изменения (опционально на первом этапе):

- Добавить колонку `credit_pack_id` (text, nullable, FK → credit_packs.id). При создании транзакции записывать id пакета, если найден в БД. Это даёт явную связь «транзакция → пакет» для аналитики и для будущего расчёта бонуса в триггере (если захотим перенести логику бонуса в БД). На первом этапе можно не добавлять и продолжать определять пакет по `(amount, price)`.

---

## 2. Миграции

### 2.1. Миграция 1: создание таблицы и сиды

- Создать таблицу `credit_packs` с полями и ограничением `UNIQUE (env, credits, price)`.
- Заполнить данными из текущего `CREDIT_PACKS` в коде (для `env = config.appEnv` или для обоих `prod` и `test` одинаковыми данными).
- Присвоить каждому пакету осмысленный `id` (например `test`, `try`, `start`, `pop`, `pro`, `max`, `try_10`, `start_10`, …) и `sort_order`, чтобы порядок в меню совпадал с текущим.

### 2.2. Миграция 2 (опционально): transactions.credit_pack_id

- Добавить колонку `credit_pack_id`, при желании — FK и индекс. Заполнять при новых транзакциях; старые остаются с NULL.

---

## 3. Изменения в коде

### 3.1. Загрузка пакетов из БД

- Добавить функцию `getCreditPacks(env?: string): Promise<CreditPack[]>` (env по умолчанию = `config.appEnv`), запрос к `credit_packs` с `ORDER BY sort_order, credits, price`.
- Опционально: in-memory кэш с TTL (например 60–300 с) или инвалидация по `updated_at`, чтобы не дергать БД на каждый callback. При изменении тарифов в БД кэш обновится за TTL или после рестарта.

### 3.2. Замена использования CREDIT_PACKS

| Место | Текущее поведение | Новое поведение |
|-------|-------------------|------------------|
| `sendBuyCreditsMenu` | `CREDIT_PACKS.filter(...)` | `(await getCreditPacks()).filter(...)` с теми же условиями по `!hidden`, `adminOnly`, `trialOnly`. |
| Callback `pack_(\d+)_(\d+)` | `CREDIT_PACKS.find(p => p.credits === credits && p.price === price)` | Поиск в `getCreditPacks()` по `(credits, price)`; при отсутствии — «invalid pack». |
| `successful_payment` | `CREDIT_PACKS.find(...)` для бонуса и подписи | То же: пакет из `getCreditPacks()` по `(transaction.amount, transaction.price)`. |
| Abandoned cart (напоминание и алерт) | `CREDIT_PACKS.find(...)` для названия и totalCredits | Пакет из БД по `(tx.amount, tx.price)`. |
| Админ-дисконты | `CREDIT_PACKS.filter(p => p.hidden && p.label_en.endsWith(-N%))` | `getCreditPacks()` затем фильтр по `hidden` и по `label_en` (или завести поле `discount_percent` при необходимости). |
| `buildBalanceInfo` (AI) | `CREDIT_PACKS.filter(!adminOnly && !hidden)` | То же с пакетами из БД. |

Имена полей в БД: `admin_only`, `trial_only`, `hidden`, `bonus_credits` — в коде маппить в camelCase при возврате из слоя БД, либо везде использовать snake_case в типах, приведённых к текущему формату объекта пакета (`adminOnly`, `trialOnly`, `hidden`, `bonus_credits`), чтобы минимизировать правки.

### 3.3. Обратная совместимость

- Callback остаётся `pack_{credits}_{price}`. Старые ссылки (промо, abandoned cart, админ-кнопки) продолжают работать, если соответствующий пакет есть в БД с теми же `credits` и `price`.
- Существующие транзакции без `credit_pack_id`: резолв пакета по `(amount, price)` из `credit_packs`; если пакет удалён из БД, для отображения использовать только amount/price (как сейчас при отсутствии в CREDIT_PACKS).

### 3.4. Удаление из кода

- Удалить константу `CREDIT_PACKS` и оставить только тип/интерфейс `CreditPack` и хелпер `getPackTotalCredits(pack)` (принимает объект из БД с полями `credits`, `bonus_credits`).

---

## 4. Окружения (env)

- В первой итерации можно заполнить `credit_packs` одним набором для обоих `env` (prod и test), чтобы поведение не изменилось.
- Позже при необходимости: разнести тарифы по `env` (например, тестовый бот с ценой 1 Star для пакета «Старт») и везде передавать `config.appEnv` в `getCreditPacks(config.appEnv)`.

---

## 5. Документация и админка

- **docs/architecture/04-database.md:** добавить описание таблицы `credit_packs` и при необходимости колонки `transactions.credit_pack_id`.
- **docs/architecture/05-payment.md:** указать, что каталог пакетов хранится в БД, таблица `credit_packs`; пример структуры и ссылка на миграцию.
- Админка (если есть): раздел «Тарифы» — просмотр/редактирование `credit_packs` по env с валидацией уникальности `(env, credits, price)`.

---

## 6. Чеклист реализации

- [ ] SQL: миграция создания таблицы `credit_packs` и сиды из текущего `CREDIT_PACKS`.
- [ ] Код: слой доступа `getCreditPacks(env?)`, маппинг полей в формат, совместимый с текущим использованием (camelCase где нужно).
- [ ] Код: замена всех обращений к `CREDIT_PACKS` на данные из `getCreditPacks()` (меню, callback, successful_payment, abandoned cart, админ-дисконты, buildBalanceInfo).
- [ ] Код: удаление константы `CREDIT_PACKS`, сохранение типа и `getPackTotalCredits`.
- [ ] (Опционально) Кэш пакетов с TTL и миграция `transactions.credit_pack_id`.
- [ ] Обновить docs/architecture/04-database.md и 05-payment.md.
- [ ] Проверка: оплата основными и скрытыми пакетами, бонус trial, abandoned cart, админ-дисконты.

---

## 7. Риски и откат

- **Риск:** сбой БД или долгий ответ — меню/оплата тормозят. Снижение: кэш пакетов; при ошибке загрузки пакетов можно fallback на захардкоженный минимальный набор (например только trial + один платный) до восстановления БД.
- **Откат:** вернуть в коде чтение из `CREDIT_PACKS` и задеплоить; таблицу можно не трогать. Старые callback и транзакции остаются валидными по `(credits, price)`.
