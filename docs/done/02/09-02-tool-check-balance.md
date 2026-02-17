# Tool `check_balance` — Требования

## Назначение

Новый инструмент AI-ассистента для получения **актуального баланса** пользователя и доступных пакетов кредитов. Позволяет агенту принимать data-driven решения о продажах в реальном времени.

## Зачем

Сейчас AI видит `Has credits: true/false` (boolean) — установленный в начале сообщения. Проблемы:
1. Нет точной цифры — агент не может адаптировать sales-подход (upsell vs первая покупка)
2. Данные могут устареть если пользователь купил кредиты во время диалога
3. Агент не знает доступные пакеты — не может рекомендовать конкретный

## Когда AI вызывает tool

- **Перед sales-питчем** — чтобы знать текущий баланс и подобрать правильный пакет
- **После paywall** — проверить, купил ли пользователь
- **Когда пользователь спрашивает про баланс** — "сколько у меня кредитов?"
- **Перед рекомендацией пакета** — чтобы предложить оптимальный

## Tool Definition

```typescript
{
  name: "check_balance",
  description: `Check user's current credit balance and available packs.
Call when:
- User asks about their balance ("сколько у меня?", "my credits?")
- Before recommending a specific pack
- After user might have purchased (returned from payment)
- When you need to adapt your approach based on credits

Returns: exact credit count, purchase history, and available packs with per-sticker prices.
Do NOT tell the user you are "checking" anything — just use the data naturally.`,
  parameters: {
    type: "object",
    properties: {}
  }
}
```

Без параметров — tool всегда проверяет баланс текущего пользователя.

## Возвращаемые данные

Tool возвращает структурированную строку, которая добавляется в `messages` как `assistant` content:

```
[BALANCE]
Credits: 13
Has purchased: true
Total generations: 5

Available packs:
• 10 credits — 150⭐ (15.0⭐/стикер) ⭐ Старт
• 30 credits — 300⭐ (10.0⭐/стикер) 💎 Популярный
• 100 credits — 700⭐ (7.0⭐/стикер) 👑 Про
• 250 credits — 1500⭐ (6.0⭐/стикер) 🚀 Макс
```

## Обработка в коде

### `ToolCall` interface (`ai-chat.ts`)

Расширить:
```typescript
export interface ToolCall {
  name: "update_sticker_params" | "confirm_and_generate" | "request_photo" 
    | "show_style_examples" | "grant_trial_credit" | "check_balance";
  args: Record<string, any>;
}
```

### `ASSISTANT_TOOLS` array (`ai-chat.ts`)

Добавить новый tool в массив.

### `ToolAction` type (`assistant-db.ts`)

```typescript
export type ToolAction = "params" | "confirm" | "photo" | "show_examples" 
  | "grant_credit" | "deny_credit" | "check_balance" | "none";
```

### `handleToolCall()` (`assistant-db.ts`)

```typescript
if (toolCall.name === "check_balance") {
  return { updates: {}, action: "check_balance" };
}
```

### Обработчик action в `index.ts`

В каждом handler (`assistant_chat`, `assistant_photo`, `wait_photo_text`):

```typescript
} else if (action === "check_balance") {
  // Re-fetch fresh user data
  const freshUser = await getUser(user.telegram_id);
  const u = freshUser || user;
  
  // Build balance info with packs
  const packs = CREDIT_PACKS
    .filter(p => !p.adminOnly && !p.hidden)
    .map(p => `• ${p.credits} credits — ${p.price}⭐ (${(p.price / p.credits).toFixed(1)}⭐/стикер) ${lang === "ru" ? p.label_ru : p.label_en}`)
    .join("\n");
  
  const balanceInfo = [
    `[BALANCE]`,
    `Credits: ${u.credits || 0}`,
    `Has purchased: ${!!u.has_purchased}`,
    `Total generations: ${u.total_generations || 0}`,
    ``,
    `Available packs:`,
    packs,
  ].join("\n");
  
  // Add balance info to messages and call AI again for a natural response
  messages.push({ role: "assistant", content: balanceInfo });
  
  const systemPrompt2 = await getAssistantSystemPrompt(messages, aSession, {
    credits: u.credits || 0,
    hasPurchased: !!u.has_purchased,
    totalGenerations: u.total_generations || 0,
  });
  
  const result2 = await callAIChat(messages, systemPrompt2);
  // ... process result2 normally (reply to user)
}
```

### Промпт (system prompt в `ai-chat.ts`)

Добавить в список tools:
```
- check_balance() — check user's current credit balance and available packs. 
  Returns exact credits, purchase history, and packs with per-sticker prices.
```

Добавить в Behavior Rules:
```
## Balance & Pricing
- Call check_balance() when user asks about credits or when you need pricing data
- When recommending a pack: use per-sticker price, compare to everyday items
- Do NOT reveal that you "checked" the balance — use the data naturally
- If user has credits > 0 and all params confirmed: proceed to confirm_and_generate()
```

### `generateFallbackReply` (`index.ts`)

Добавить case для `check_balance`:
```typescript
if (action === "check_balance") {
  return isRu ? "Проверяю..." : "Checking...";
}
```

## Взаимодействие с существующими tools

| Ситуация | Поведение |
|----------|-----------|
| AI вызывает `check_balance` → credits > 0 | AI видит баланс, предлагает `confirm_and_generate` |
| AI вызывает `check_balance` → credits = 0 | AI использует пакеты для sales pitch |
| AI вызывает `check_balance` после paywall | AI не повторяет paywall, использует новый угол с конкретными ценами |
| Юзер спрашивает "сколько у меня кредитов?" | AI вызывает `check_balance`, отвечает естественно |

## Multi-turn handling

`check_balance` — это "информационный" tool. После получения данных AI делает **второй вызов** к LLM с обновлённым контекстом, чтобы сгенерировать естественный ответ на основе баланса.

## Безопасность

- Tool только читает данные, не изменяет
- Не показывать adminOnly или hidden пакеты
- Не показывать скидочные пакеты (hidden: true)
- Лимит: не более 3 вызовов `check_balance` за сессию (anti-loop)

## SQL миграция

Не требуется — tool работает с существующими таблицами (`users`, `CREDIT_PACKS` hardcoded).

## План реализации

| Шаг | Задача | Файл |
|-----|--------|------|
| 1 | Добавить tool definition в `ASSISTANT_TOOLS` | `ai-chat.ts` |
| 2 | Расширить `ToolCall` interface | `ai-chat.ts` |
| 3 | Расширить `ToolAction` type | `assistant-db.ts` |
| 4 | Добавить `handleToolCall` case | `assistant-db.ts` |
| 5 | Добавить обработчик `check_balance` action в 3 handler'а | `index.ts` |
| 6 | Обновить системный промпт | `ai-chat.ts` |
| 7 | Обновить `generateFallbackReply` для `check_balance` | `index.ts` |
