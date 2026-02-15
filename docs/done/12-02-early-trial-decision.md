# Ранний grant/deny кредита — решение по ходу разговора

**Дата:** 2026-02-12
**Статус:** Спецификация
**Связано:** docs/12-02-conversion-agent-research.md (исследование архитектуры с отдельным агентом)

## Проблема

1. AI принимает решение о бесплатном кредите **только после нажатия "Подтвердить"** — слишком поздно. Многие пользователи не доходят до этой точки.
2. **CRITICAL BUG**: тег `[trial: grant]` записывается в `goal` через `processAssistantResult` **ДО** того, как `handleTrialCreditAction` проверяет `alreadyGranted`. Результат: кредит **никогда не выдаётся**.

## Цель

1. Починить баг с тегом (Вариант A — записывать тег в `handleTrialCreditAction`, не в `processAssistantResult`)
2. AI оценивает конверсионный потенциал **во время сбора параметров** и принимает решение раньше

## Текущий flow

```
/start → фото → стиль → эмоция → поза → зеркало → [Подтвердить] → AI решает grant/deny → генерация
```

## Новый flow

```
/start → фото → AI по ходу разговора оценивает → grant/deny → стиль → эмоция → поза → [Подтвердить] → генерация
```

AI может вызвать `grant_trial_credit` в любой момент после получения фото, когда уверен в оценке.

---

## Изменения

### 0. FIX CRITICAL BUG: перенос записи `[trial:]` тега из `processAssistantResult` в `handleTrialCreditAction`

**Проблема:**

Сейчас `handleToolCall` в `assistant-db.ts` записывает тег в `goal`:
```typescript
// assistant-db.ts, handleToolCall, grant_trial_credit
const tag = `[trial: ${args.decision}, confidence: ${args.confidence}, reason: ${args.reason}]`;
return {
  updates: {
    goal: `${aSession.goal || ""} ${tag}`.trim(),  // ← тег в updates
  },
  action: args.decision === "grant" ? "grant_credit" : "deny_credit",
};
```

Этот `updates.goal` сохраняется в БД внутри `processAssistantResult` (строка 1044):
```typescript
await updateAssistantSession(aSession.id, { messages, ...sessionUpdates });
// sessionUpdates включает goal с тегом [trial: grant] — записано в БД!
```

Затем `handleTrialCreditAction` проверяет `alreadyGranted`:
```typescript
.like("goal", "%[trial: grant%");
const alreadyGranted = (userTrialCount || 0) > 0;  // ← ВСЕГДА true, т.к. тег уже в БД
```

**Результат: `canGrant` всегда `false`, кредит никогда не выдаётся.**

**Fix (Вариант A):**

**Шаг A1.** В `assistant-db.ts` — убрать `goal` update из `handleToolCall` для `grant_trial_credit`:
```typescript
if (toolCall.name === "grant_trial_credit") {
  const args = toolCall.args;
  return {
    updates: {},   // ← НЕ записываем тег здесь
    action: args.decision === "grant" ? "grant_credit" : "deny_credit",
  };
}
```

**Шаг A2.** В `handleTrialCreditAction` (index.ts) — записывать тег ПОСЛЕ фактического grant/deny:
```typescript
if (action === "grant_credit") {
  // ... canGrant check ...
  if (canGrant) {
    await supabase.from("users").update({ credits: 1 }).eq("id", user.id);

    // Записать тег ПОСЛЕ реального grant
    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      const tag = `[trial: grant, confidence: ${result.toolCall?.args?.confidence}, reason: ${result.toolCall?.args?.reason}]`;
      await updateAssistantSession(aSession.id, {
        goal: `${aSession.goal || ""} ${tag}`.trim(),
      });
    }
    // ... alert, generation ...
  } else {
    // Budget exhausted — записать тег canGrant=false
    const aSession = await getActiveAssistantSession(user.id);
    if (aSession) {
      const tag = `[trial: grant_blocked, reason: canGrant=false]`;
      await updateAssistantSession(aSession.id, {
        goal: `${aSession.goal || ""} ${tag}`.trim(),
      });
    }
    // ... paywall ...
  }
} else {
  // deny_credit — записать тег deny
  const aSession = await getActiveAssistantSession(user.id);
  if (aSession) {
    const tag = `[trial: deny, confidence: ${result.toolCall?.args?.confidence}, reason: ${result.toolCall?.args?.reason}]`;
    await updateAssistantSession(aSession.id, {
      goal: `${aSession.goal || ""} ${tag}`.trim(),
    });
  }
  // ... deny logic ...
}
```

### 1. `handleTrialCreditAction` — не запускать генерацию при раннем grant

**Сейчас** (строка ~1267 в index.ts):
```typescript
if (canGrant) {
  await supabase.from("users").update({ credits: 1 }).eq("id", user.id);
  const freshUser = await getUser(user.telegram_id);
  if (replyText) await ctx.reply(replyText);
  if (freshUser) await handleAssistantConfirm(ctx, freshUser, session.id, lang);
  // ← сразу запускает генерацию!
}
```

**Нужно:**
- Проверить, все ли параметры собраны (`allParamsCollected`)
- Если **все собраны** → grant + генерация (как сейчас)
- Если **НЕ все собраны** → только начислить кредит + reply text, продолжить разговор

```typescript
if (canGrant) {
  await supabase.from("users").update({ credits: 1 }).eq("id", user.id);
  // ... записать тег, alert ...

  const aSession = await getActiveAssistantSession(user.id);
  const paramsReady = aSession && allParamsCollected(aSession);

  if (paramsReady) {
    // Все параметры собраны — grant + генерация
    const freshUser = await getUser(user.telegram_id);
    if (replyText) await ctx.reply(replyText);
    if (freshUser) await handleAssistantConfirm(ctx, freshUser, session.id, lang);
  } else {
    // Ранний grant — просто начислить кредит, продолжить разговор
    if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
    // Генерация запустится штатно при [Подтвердить]
  }
}
```

### 2. `handleTrialCreditAction` deny — мягкий deny без paywall

**Сейчас:**
```typescript
// deny_credit — сразу показывает paywall
if (replyText) await ctx.reply(replyText);
await sendBuyCreditsMenu(ctx, user);
```

**Нужно:**
- Если параметры **НЕ все собраны** → только reply text (мягкий deny), НЕ показывать paywall
- Paywall покажется позже при confirm (`startGeneration` → credits < 1 → paywall)

```typescript
// deny_credit
// ... записать тег, alert ...

const aSession = await getActiveAssistantSession(user.id);
const paramsReady = aSession && allParamsCollected(aSession);

if (paramsReady) {
  // Параметры собраны — показать paywall (как сейчас)
  if (replyText) await ctx.reply(replyText);
  await sendBuyCreditsMenu(ctx, user);
  // ... mark paywall_shown ...
} else {
  // Ранний deny — мягко, без paywall, продолжить разговор
  if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
}
```

### 3. `!canGrant` fallback — тоже проверять параметры

**Сейчас** (строка ~1269): при `!canGrant` (бюджет исчерпан) — сразу paywall. При раннем вызове с неполными параметрами — плохой UX.

**Нужно:**
```typescript
} else {
  // Budget exhausted or guard triggered
  const aSession = await getActiveAssistantSession(user.id);
  const paramsReady = aSession && allParamsCollected(aSession);

  if (paramsReady) {
    // Параметры собраны — paywall (как сейчас)
    const paywallText = lang === "ru" ? "К сожалению..." : "Unfortunately...";
    await ctx.reply(paywallText);
    await sendBuyCreditsMenu(ctx, user);
    // ... mark paywall_shown ...
  } else {
    // Ранний вызов, бюджет исчерпан — тихо продолжить разговор
    // AI текст уже отправлен через replyText, paywall не показываем
    if (replyText) await ctx.reply(replyText, getMainMenuKeyboard(lang));
  }
}
```

### 4. Tool description — разрешить ранний вызов

**Файл:** `src/lib/ai-chat.ts`, tool `grant_trial_credit`

**Сейчас:**
```
Call INSTEAD of confirm_and_generate when user confirmed parameters but has 0 credits and never purchased.
```

**Нужно:**
```
Call when you've assessed the user's conversion potential. You can call this at ANY point after receiving the photo — you don't need to wait for all parameters or confirmation.
Your goal: decide if giving 1 free credit will lead to a PURCHASE.
You are spending a limited daily budget — be strategic.

Call EARLY (after photo + 1-2 messages) if you see clear signals.
The sooner you decide, the smoother the experience for the user.

GRANT if user shows HIGH conversion potential:
- Specific, personal goal (gift, team stickers, business use)
- Sent a real photo quickly (shows genuine intent)
- Engaged conversation (not just one-word answers)
- Premium Telegram user (higher purchasing power)
- Came from paid ads (traffic_source = "paid")

DENY if user shows LOW conversion potential:
- Vague goal ('just checking', 'want to try')
- Minimal effort (one-word answers, no details)
- No clear use case
- Seems to only want freebies

When budget is low (< 5 remaining): only grant to EXCEPTIONAL leads.
When denied: be warm, continue collecting parameters naturally. Don't mention pricing.
When granted: say something natural like "Этот сделаю в подарок!" and continue collecting parameters.
```

### 5. System prompt trial section

**Файл:** `src/lib/ai-chat.ts`, `buildSystemPrompt()`

**Сейчас:**
```
## Trial Credit (when credits = 0, has_purchased = false)
After user confirms parameters, call grant_trial_credit() INSTEAD of confirm_and_generate().
```

**Нужно:**
```
## Trial Credit (when credits = 0, has_purchased = false)
Assess the user's conversion potential DURING the conversation.
Call grant_trial_credit() as soon as you're confident — don't wait for confirmation.
Ideal timing: after photo received + 1-2 meaningful messages.

If you GRANT: continue collecting parameters normally. Say something natural like "Этот сделаю в подарок!" / "I'll make this one as a gift!" — don't break the flow.
If you DENY: continue collecting parameters. Don't mention pricing — paywall will appear naturally at confirmation.

NEVER mention "trial", "free credit", or "budget" to the user.
The user should feel this is a natural gift, not a calculated decision.
```

---

## Поведение при "Подтвердить" после раннего grant/deny

### Ранний grant сработал:
- `user.credits = 1`
- При "Подтвердить": `qualifiesForTrial = false` (credits > 0) → идёт напрямую в `handleAssistantConfirm` → `startGeneration` → генерация. **Корректно.**

### Ранний deny:
- `user.credits = 0`
- При "Подтвердить": `qualifiesForTrial = true` → AI вызывается повторно
- `alreadyGranted = false` (тег `[trial: deny]`, не `[trial: grant]`)
- AI получает "второй шанс" — может пересмотреть решение
- **Это feature**: пользователь дошёл до confirm = дополнительный engagement signal

### Ранний grant заблокирован (`!canGrant`):
- `user.credits = 0`, тег `[trial: grant_blocked]`
- При "Подтвердить": `qualifiesForTrial = true` → AI вызывается
- `alreadyGranted = false` (тег `grant_blocked`, не `grant`)
- AI может попробовать снова, `canGrant` проверит лимиты заново
- **Корректно**: бюджет мог восстановиться (новый день)

---

## Подводные камни (учтены)

| Риск | Защита |
|------|--------|
| `[trial: grant]` записывается до проверки → кредит не выдаётся | **FIX**: тег записывается в `handleTrialCreditAction` после факта (Вариант A) |
| Grant при неполных параметрах → попытка генерации | Проверка `allParamsCollected` перед `handleAssistantConfirm` |
| Deny в середине разговора → paywall ломает UX | Мягкий deny без paywall при неполных параметрах |
| `!canGrant` fallback → paywall в середине разговора | Проверка `allParamsCollected`, тихий fallback при неполных |
| Двойной вызов grant_trial_credit | `alreadyGranted` проверка (теперь работает корректно) |
| LLM вызывает grant + update_sticker_params одновременно | Текущая архитектура обрабатывает один tool call. Промпт: вызывать отдельно |
| Кредит выдан, пользователь ушёл | Приемлемый риск — engagement signal уже есть (фото + разговор) |
| Ранний deny → повторный AI call при confirm | Feature: "второй шанс" для пользователя с высоким engagement |

---

## Checklist

- [ ] **FIX BUG**: убрать `goal` update из `handleToolCall` для `grant_trial_credit` в `assistant-db.ts`
- [ ] **FIX BUG**: добавить запись тега в `handleTrialCreditAction` после факта grant/deny
- [ ] Обновить `handleTrialCreditAction` grant — проверка `allParamsCollected`, ранний grant без генерации
- [ ] Обновить `handleTrialCreditAction` deny — мягкий deny без paywall при неполных параметрах
- [ ] Обновить `handleTrialCreditAction` `!canGrant` — тихий fallback при неполных параметрах
- [ ] Обновить tool description `grant_trial_credit` в `ai-chat.ts`
- [ ] Обновить system prompt Trial Credit section в `ai-chat.ts`
- [ ] Деплой на test
- [ ] Тест: новый пользователь, проверить что AI вызывает grant после фото
- [ ] Мониторинг алертов `trial_credit_granted` / `trial_credit_denied`
