# Tool: grant_trial_credit

## Цель

AI-ассистент выступает как менеджер по конверсии: анализирует диалог с пользователем и решает, стоит ли инвестировать 1 бесплатный кредит, чтобы увеличить вероятность покупки пакета.

**Конечная цель — не раздача кредитов, а покупка.**

---

## Бюджет

- **20 бесплатных кредитов в день** (глобальный лимит, все пользователи)
- AI видит остаток бюджета в `[SYSTEM STATE]`
- Чем меньше осталось — тем жёстче критерии
- При `remaining = 0` — tool не вызывается, сразу paywall

---

## Когда вызывается

AI вызывает `grant_trial_credit` **ВМЕСТО** `confirm_and_generate`, когда:
- Пользователь подтвердил все параметры (стиль, эмоция, поза)
- `credits === 0` — нет кредитов
- `has_purchased === false` — никогда не покупал
- `total_generations <= 2` — не более 2 генераций (новые пользователи)
- `remaining > 0` — бюджет не исчерпан
- Пользователь ещё **не получал** trial credit ранее (проверка тега `[trial: grant` в `assistant_sessions.goal`)

Если хоть одно условие не выполнено — AI вызывает `confirm_and_generate` как обычно.

---

## Tool Definition

```typescript
{
  name: "grant_trial_credit",
  description: `Call INSTEAD of confirm_and_generate when user confirmed parameters but has 0 credits and never purchased.
Your goal: decide if giving 1 free credit will lead to a PURCHASE.
You are spending a limited daily budget — be strategic.

GRANT if user shows HIGH conversion potential:
- Specific, personal goal (gift, team stickers, business use)
- Detailed style/emotion preferences (shows they care about quality)
- Engaged conversation (3+ meaningful messages, not just 'ok')
- Premium Telegram user (higher purchasing power)

DENY if user shows LOW conversion potential:
- Vague goal ('just checking', 'want to try')
- Minimal effort (one-word answers, no details)
- No clear use case
- Seems to only want freebies

When budget is low (< 5 remaining): only grant to EXCEPTIONAL leads.
When denied: be warm, explain the value, and naturally transition to pricing.`,
  parameters: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["grant", "deny"],
      },
      confidence: {
        type: "number",
        description: "How confident you are this user will purchase after trial (0.0 to 1.0)"
      },
      reason: {
        type: "string",
        description: "Brief reason for analytics (e.g. 'specific business use case, premium user' or 'vague intent, one-word answers')"
      }
    },
    required: ["decision", "confidence", "reason"]
  }
}
```

---

## Критерии решения AI

### GRANT (дать кредит)

| Сигнал | Пример |
|---|---|
| Конкретная цель | "стикеры для команды на работе", "подарок другу на ДР" |
| Детальные предпочтения | "в стиле вкладыша Love Is", "аниме с грустной эмоцией" |
| Вовлечённый диалог | 3+ развёрнутых сообщений |
| Premium пользователь | `is_premium: true` |
| Бизнес-применение | "для Telegram-канала", "для мерча" |

### DENY (не дать, показать paywall)

| Сигнал | Пример |
|---|---|
| Размытая цель | "просто посмотреть", "хз", "а что это" |
| Минимум усилий | односложные ответы: "ок", "ну давай", "любой" |
| Нет ясной потребности | не может объяснить зачем ему стикеры |
| Пробует ради бесплатного | "а бесплатно можно?", "дайте попробовать" |

### Адаптация к бюджету

| Остаток | Стратегия |
|---|---|
| 15-20 | Стандартные критерии |
| 5-14 | Повышенные требования: нужна конкретная цель + детальные предпочтения |
| 1-4 | Только исключительные лиды: Premium + конкретная бизнес-потребность |
| 0 | Не вызывать tool, сразу paywall |

---

## System Prompt — секция Trial Credit

```
## Trial Credit (when credits = 0, has_purchased = false)
After user confirms parameters, call grant_trial_credit() INSTEAD of confirm_and_generate().
You're a conversion manager. Your daily budget is limited (see [SYSTEM STATE]).
Goal: give free credit ONLY to users who will likely PURCHASE after seeing the result.

Decision framework:
- Ask yourself: "Will this user buy a pack after seeing a great sticker?"
- High signals: specific goal, personal use case, detailed preferences, premium user
- Low signals: "just trying", minimal effort, no clear need

If you GRANT: say something like "I'll generate this one for free — I'm sure you'll love it!"
If you DENY: be warm and encouraging, explain the quality, and naturally transition to pricing.
  Example: "Your sticker idea is great! To bring it to life, choose a pack below —
  10 stickers is enough to get started."

NEVER mention the word "trial", "free credit", or "budget".
The user should feel this is a natural gift, not a calculated decision.
```

---

## Данные для [SYSTEM STATE]

В `buildStateInjection()` добавить (только если `credits === 0`, `has_purchased === false` и `total_generations <= 2`):

```typescript
const todayGranted = await getTodayTrialCreditsCount();
const remaining = Math.max(0, 20 - todayGranted);
lines.push(`Trial budget today: ${remaining}/20 remaining`);
if (remaining === 0) {
  lines.push(`Budget exhausted — do NOT call grant_trial_credit, show paywall instead`);
} else if (remaining <= 5) {
  lines.push(`Budget low — grant ONLY to exceptional leads`);
}
```

---

## Счётчик выданных кредитов за сегодня

Без новых таблиц — используем тег в `assistant_sessions.goal`:

```typescript
async function getTodayTrialCreditsCount(): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("assistant_sessions")
    .select("id", { count: "exact", head: true })
    .eq("env", config.appEnv)
    .gte("updated_at", todayStart.toISOString())
    .like("goal", "%[trial: grant%");

  return count || 0;
}
```

---

## Обработка в коде

### `handleToolCall()` в `assistant-db.ts`

```typescript
if (toolCall.name === "grant_trial_credit") {
  const tag = `[trial: ${args.decision}, confidence: ${args.confidence}, reason: ${args.reason}]`;
  return {
    updates: {
      goal: `${aSession.goal || ""} ${tag}`.trim()
    },
    action: args.decision === "grant" ? "grant_credit" : "deny_credit",
  };
}
```

Добавить в `ToolAction`:
```typescript
export type ToolAction = "params" | "confirm" | "photo" | "grant_credit" | "deny_credit" | "none";
```

### Обработка action в `index.ts`

```typescript
if (action === "grant_credit") {
  // Код ВСЕГДА проверяет лимиты — даже если AI сказал "grant"
  const todayCount = await getTodayTrialCreditsCount();
  const canGrant = todayCount < 20
    && user.credits === 0
    && !user.has_purchased
    && user.total_generations <= 2
    && !alreadyGranted;  // проверка: пользователь ещё не получал trial

  if (canGrant) {
    await supabase
      .from("users")
      .update({ credits: 1 })
      .eq("id", user.id);

    sendAlert({
      type: "trial_credit_granted",
      message: `🎁 Trial credit #${todayCount + 1}/20`,
      details: {
        user: `@${user.username || user.telegram_id}`,
        confidence: result.toolCall?.args?.confidence,
        reason: result.toolCall?.args?.reason,
        isPremium: user.is_premium,
        lang: user.language_code,
      }
    }).catch(console.error);

    // Re-fetch user with updated credits, then generate
    const freshUser = await getUser(user.telegram_id);
    if (replyText) await ctx.reply(replyText);
    await handleAssistantConfirm(ctx, freshUser, session.id, lang);
  } else {
    // Budget exhausted or guard triggered — fallback to paywall
    const paywallText = lang === "ru"
      ? "К сожалению, сейчас не могу сгенерировать бесплатно. Выбери пакет — 10 стикеров хватит для старта:"
      : "Unfortunately, I can't generate for free right now. Choose a pack — 10 stickers is enough to start:";
    await ctx.reply(paywallText);
    await sendBuyCreditsMenu(ctx, user);
  }

} else if (action === "deny_credit") {
  sendAlert({
    type: "trial_credit_denied",
    message: `❌ Trial denied`,
    details: {
      user: `@${user.username || user.telegram_id}`,
      confidence: result.toolCall?.args?.confidence,
      reason: result.toolCall?.args?.reason,
    }
  }).catch(console.error);

  if (replyText) await ctx.reply(replyText);
  await sendBuyCreditsMenu(ctx, user);
}
```

### Fallback Reply

```typescript
if (action === "grant_credit") {
  return isRu
    ? "Отлично! Сгенерирую этот стикер для тебя — уверен, результат понравится! 🎨"
    : "Great! I'll generate this sticker for you — I'm sure you'll love it! 🎨";
}
if (action === "deny_credit") {
  return isRu
    ? "Твоя идея отличная! Чтобы воплотить её, выбери пакет — 10 стикеров хватит для старта:"
    : "Your idea is great! To bring it to life, choose a pack — 10 stickers is enough to start:";
}
```

---

## Flow (поток)

```
User confirms all params → AI checks [SYSTEM STATE]:
  ├── credits > 0 → confirm_and_generate() (как сейчас)
  ├── credits = 0, has_purchased = true → confirm_and_generate() → paywall в коде
  └── credits = 0, has_purchased = false, total_generations ≤ 2, no prior grant:
      ├── budget > 0 → AI вызывает grant_trial_credit(grant/deny)
      │   ├── grant → код проверяет лимит → +1 credit → generate
      │   └── deny → тёплый текст от AI + sendBuyCreditsMenu
      └── budget = 0 → AI НЕ вызывает tool, пишет текст + paywall
```

---

## Аналитика

### Конверсия trial → purchase

```sql
SELECT
  CASE
    WHEN a.goal LIKE '%[trial: grant%' THEN 'granted'
    WHEN a.goal LIKE '%[trial: deny%' THEN 'denied'
  END as decision,
  COUNT(*) as total,
  COUNT(CASE WHEN u.has_purchased THEN 1 END) as purchased,
  ROUND(100.0 * COUNT(CASE WHEN u.has_purchased THEN 1 END) / NULLIF(COUNT(*), 0), 1) as conversion_pct
FROM assistant_sessions a
JOIN users u ON u.id = a.user_id
WHERE a.goal LIKE '%[trial:%'
  AND a.created_at > now() - interval '30 days'
GROUP BY 1;
```

### Средний confidence по группам

```sql
SELECT
  CASE WHEN u.has_purchased THEN 'purchased' ELSE 'not_purchased' END as outcome,
  AVG(
    CAST(
      SUBSTRING(a.goal FROM 'confidence: ([0-9.]+)') AS NUMERIC
    )
  ) as avg_confidence
FROM assistant_sessions a
JOIN users u ON u.id = a.user_id
WHERE a.goal LIKE '%[trial: grant%'
GROUP BY 1;
```

Если `avg_confidence` для `not_purchased` высокий — AI переоценивает, нужно ужесточить промпт.

### Расход бюджета по дням

```sql
SELECT
  DATE(updated_at) as day,
  COUNT(*) as credits_granted
FROM assistant_sessions
WHERE goal LIKE '%[trial: grant%'
  AND env = 'prod'
GROUP BY 1
ORDER BY 1 DESC
LIMIT 14;
```

---

## Защита от злоупотреблений

1. **Код всегда проверяет лимит** — даже если AI сказал grant
2. **`total_generations <= 2`** — только новые пользователи (до 2 генераций включительно)
3. **Максимум 1 trial на пользователя** — явная проверка тега `[trial: grant` в `assistant_sessions.goal` (повторный grant блокируется даже если `total_generations <= 2`)
4. **Глобальный лимит 20/день** — через `getTodayTrialCreditsCount()`
5. **AI не знает слово "trial"** — в промпте запрещено упоминать бесплатные кредиты и бюджет

---

## Файлы для изменений

| Файл | Что менять |
|---|---|
| `src/lib/ai-chat.ts` | Добавить tool в `ASSISTANT_TOOLS`, секцию Trial Credit в system prompt |
| `src/lib/assistant-db.ts` | Добавить `"grant_credit" \| "deny_credit"` в `ToolAction`, обработку в `handleToolCall()`, расширить `buildStateInjection()` бюджетом |
| `src/index.ts` | Добавить `getTodayTrialCreditsCount()`, обработку action `grant_credit` / `deny_credit`, fallback replies |
| `src/lib/alerts.ts` | Добавить `trial_credit_granted`, `trial_credit_denied` в AlertType |

**Оценка: ~2-3 часа**
