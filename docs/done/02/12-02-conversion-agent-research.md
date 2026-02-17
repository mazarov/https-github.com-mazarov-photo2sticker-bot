# Conversion Agent — исследование архитектуры

**Дата:** 2026-02-12
**Статус:** Исследование (не реализовано)
**Связано:** docs/12-02-early-trial-decision.md (текущая задача с trial credits)

## Контекст

При обсуждении раннего grant/deny кредита возникла идея: вместо того чтобы один AI агент и вёл диалог, и принимал бизнес-решения — разделить на двух агентов.

## Проблема одного агента

Сейчас Gemini одновременно:
- Ведёт дружелюбный диалог (ассистент)
- Собирает параметры стикера (style, emotion, pose)
- Действует как "скрытый conversion specialist"
- Принимает решение о бесплатном кредите

Конфликт ролей: LLM плохо справляется когда нужно быть одновременно дружелюбным ассистентом И жёстким оценщиком конверсии. AI либо раздаёт кредиты всем, либо никому.

## Предлагаемая архитектура

```
Пользователь → Dialog Agent (собирает параметры, дружелюбный)
                    ↓ (передаёт транскрипт)
              Conversion Agent (наблюдает, решает)
                    ↓
              { action: "grant" | "deny" | "discount_15" | "wait" }
```

### Dialog Agent (текущий, упрощённый)
- **Роль**: дружелюбный ассистент, собирает style/emotion/pose
- **Убрать**: `grant_trial_credit` tool, всю Trial Credit секцию из промпта
- **Результат**: промпт короче и чище, LLM лучше справляется с основной задачей

### Conversion Agent (новый, observer)
- **Роль**: анализирует транскрипт диалога, принимает бизнес-решения
- **Не общается** с пользователем напрямую
- **Вход**: полный массив `messages` из assistant_session + user context
- **Выход**: JSON с решением

### Tools Conversion Agent'а

| Tool | Описание |
|------|----------|
| `grant_credit` | Выдать 1 бесплатный кредит |
| `deny_credit` | Отказать (тихо, пользователь не узнает) |
| `offer_discount(percent)` | Предложить скидку 10-25% |
| `wait` | Не хватает данных, подождать ещё |

### Промпт Conversion Agent

```
You are a conversion analyst. You receive a conversation transcript between a sticker bot and a user.
The user has 0 credits and never purchased.

Analyze the conversation and decide:

CONTEXT:
- User: {name}, language: {lang}, premium: {isPremium}
- Traffic source: {source}
- Trial budget remaining: {remaining}/20
- Conversation messages: {messages}

DECIDE one action:
- "grant" — user will likely purchase after seeing a great result
- "deny" — low conversion potential, save budget
- "discount_N" — offer N% discount instead of free credit (for borderline cases)
- "wait" — not enough data yet, observe more

Return JSON: { "action": "grant", "confidence": 0.85, "reason": "specific gift goal, premium user" }
```

## Когда запускать Conversion Agent

### Вариант 1: Sync после фото + 1 сообщение (РЕКОМЕНДУЕТСЯ для текущего этапа)

```
Фото получено → Dialog Agent отвечает
User: первое сообщение → Dialog Agent отвечает + Conversion Agent (sync) → решение
```

| Параметр | Значение |
|----------|----------|
| Латентность | +500-1000ms (один раз за сессию) |
| Сложность | Низкая — один вызов в handler'е |
| Wow-эффект | Органично через Dialog Agent |
| Race condition | Невозможен |
| Дебаг | Просто — в том же handler'е |

### Вариант 2: Async (фоном) — для масштабирования

```
Фото получено → Dialog Agent отвечает мгновенно
                → Fire-and-forget: Conversion Agent работает параллельно
                → Решение записывается в БД
Следующее действие пользователя → уже видит результат
```

#### Плюсы async

1. **Нулевая латентность** — пользователь не ждёт. Dialog Agent отвечает за ~1-2с. Conversion Agent может думать 5с — пользователь этого не заметит, он читает ответ.

2. **Решение готово ДО confirm** — типичный flow: фото → 3-5 сообщений → confirm (60-180с). Conversion Agent завершится за 2-5с. К confirm решение давно в БД.

3. **Тяжёлая модель** — синхронно нужно быстро (gpt-4o-mini, ~500ms). Асинхронно — можно gpt-4o или claude-3.5-sonnet с глубоким анализом.

4. **Retry при ошибке** — если AI call упал, тихо повторить через 3с. Синхронно — fallback пользователю.

5. **Повторный запуск с бОльшим контекстом** — первый вызов: `wait`. Второй через 30с (после 2-3 сообщений): `grant`. Пользователь ничего не заметил.

#### Минусы async

1. **Race condition: решение не готово к confirm** — если пользователь очень быстрый (9с до confirm). Митигация: при confirm подождать до 3с или fallback на sync.

2. **Координация состояния** — нужно поле `conversion_decision` в `assistant_sessions` и проверка во всех handler'ах.

3. **Нет wow-эффекта "подарка"** — кредит начисляется тихо. Митигация: инжектить в system state Dialog Agent'а: `[SYSTEM: trial credit granted — mention naturally]`.

4. **Повторный запуск при `wait`** — когда? Два fire-and-forget (после фото и после первого текста) — простейший вариант.

5. **Дебаг сложнее** — логи не привязаны к конкретному сообщению. Нужна корреляция по session_id.

### Вариант 3: На каждое сообщение

Дорого (×2 AI вызовов на каждый шаг). Не рекомендуется.

## Рекомендация

### Этап 1 (сейчас): sync, без отдельного агента
- Починить баг с тегом `[trial: grant]` (docs/early-trial-decision.md, шаг 0)
- Ранний вызов `grant_trial_credit` через существующего Dialog Agent'а
- Минимальные изменения, быстрый результат

### Этап 2 (при росте): sync Conversion Agent
- Вынести решение в отдельную функцию `evaluateConversion()`
- Отдельный AI call с коротким focused промптом
- Разные модели: Dialog = flash (дёшево), Conversion = gpt-4o-mini (точнее)
- Убрать `grant_trial_credit` из tools Dialog Agent'а

### Этап 3 (1000+ юзеров/день): async Conversion Agent
- Fire-and-forget после фото
- Поле `conversion_decision` в assistant_sessions
- Повторный запуск с бОльшим контекстом
- Новые tools: скидки, отложенные предложения, A/B тесты

## Преимущества разделения

1. **Separation of concerns** — Dialog Agent не знает про бюджеты, пишет чище
2. **Разные модели** — оптимизация стоимости и качества для каждой задачи
3. **Новые инструменты** — скидки, спец. предложения, сегментация
4. **Тестирование** — прогон 100 реальных транскриптов через Conversion Agent offline
5. **Нет конфликта ролей** — LLM не пытается быть одновременно другом и продавцом
