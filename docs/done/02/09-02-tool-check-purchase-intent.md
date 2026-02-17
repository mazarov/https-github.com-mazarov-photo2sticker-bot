# Tool: check_purchase_intent

## Цель

Ассистент уточняет у пользователя готовность купить пакет кредитов для генерации стикеров. Это позволяет:
- Квалифицировать намерение до генерации (не тратить API-ресурсы на тех, кто точно не купит)
- Предложить конкретный пакет, если пользователь готов
- Собрать аналитику: сколько пользователей готовы платить на этапе диалога

---

## Когда вызывается

LLM вызывает `check_purchase_intent` **после mirror** (все параметры собраны), **перед confirm**, если:
- `credits === 0` — у пользователя нет кредитов
- `has_purchased === false` — пользователь ещё не покупал

Если `credits > 0` — не спрашивать, сразу переходить к confirm.

---

## Tool Definition

```typescript
{
  name: "check_purchase_intent",
  description: "Call after showing the mirror message when user has no credits and hasn't purchased before. Ask if they're willing to buy a credit pack to generate the sticker. Do NOT call if user already has credits.",
  parameters: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["ready_to_buy", "thinking", "no"],
        description: "User's purchase intent: ready_to_buy = wants to purchase, thinking = not sure yet, no = declined"
      },
      preferred_pack: {
        type: "string",
        enum: ["start", "popular", "pro", "max"],
        nullable: true,
        description: "Which pack user prefers, if they mentioned one. null if not specified."
      },
    },
    required: ["intent"],
  },
}
```

---

## Обработка в коде

### `handleToolCall()` в `assistant-db.ts`

```typescript
if (toolCall.name === "check_purchase_intent") {
  return {
    updates: {
      // Сохраняем intent в goal или новое поле
      goal: `${aSession.goal || ""} [intent: ${args.intent}, pack: ${args.preferred_pack || "none"}]`.trim(),
    },
    action: "purchase_intent",
  };
}
```

### Обработка action в `index.ts`

```typescript
if (action === "purchase_intent") {
  const intent = result.toolCall?.args?.intent;
  
  if (intent === "ready_to_buy") {
    // Показать кнопки пакетов
    if (replyText) await ctx.reply(replyText);
    await sendBuyCreditsMenu(ctx, user);
  } else if (intent === "thinking") {
    // Мягкий nudge от LLM (текст генерирует LLM)
    if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
  } else {
    // intent === "no" — продолжить к confirm, LLM справится
    if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
  }
}
```

### Fallback (если LLM вернул только tool call без текста)

```typescript
if (action === "purchase_intent") {
  const intent = result.toolCall?.args?.intent;
  if (intent === "ready_to_buy") {
    return isRu
      ? "Отлично! Вот доступные пакеты:"
      : "Great! Here are the available packs:";
  }
  if (intent === "no") {
    return isRu
      ? "Понял! Если передумаешь — пакеты всегда доступны в меню 💰 Баланс"
      : "Got it! If you change your mind — packs are always available in 💰 Balance";
  }
  return isRu
    ? "Не торопись! Можешь сначала подтвердить параметры, а купить потом."
    : "No rush! You can confirm the parameters first and buy later.";
}
```

---

## System Prompt

Добавить в промпт:

```
## Purchase Intent
Available credit packs: Start (10 stickers), Popular (30), Pro (100), Max (250).
If user has no credits (see [SYSTEM STATE]):
  After mirror, ask naturally if they'd like to choose a pack.
  Call check_purchase_intent() with their response.
  If user has credits — skip this step entirely.
```

---

## Данные для [SYSTEM STATE]

В `buildStateInjection()` добавить:

```typescript
lines.push(`Credits: ${user.credits}`);
lines.push(`Has purchased before: ${user.has_purchased}`);
```

Это даст LLM контекст для принятия решения — спрашивать или нет.

---

## Аналитика

Из `assistant_sessions.goal` можно извлечь intent:

```sql
SELECT 
  CASE 
    WHEN goal LIKE '%intent: ready_to_buy%' THEN 'ready_to_buy'
    WHEN goal LIKE '%intent: thinking%' THEN 'thinking'
    WHEN goal LIKE '%intent: no%' THEN 'no'
    ELSE 'not_asked'
  END as purchase_intent,
  COUNT(*) as count
FROM assistant_sessions
WHERE status IN ('completed', 'abandoned')
  AND created_at > now() - interval '7 days'
GROUP BY 1;
```

---

## Файлы для изменений

| Файл | Что менять |
|---|---|
| `src/lib/ai-chat.ts` | Добавить tool в `ASSISTANT_TOOLS`, обновить system prompt |
| `src/lib/assistant-db.ts` | Добавить `"purchase_intent"` в `handleToolCall()`, обновить `buildStateInjection()` |
| `src/index.ts` | Добавить обработку `action === "purchase_intent"`, fallback |

**Оценка: ~1 час**
