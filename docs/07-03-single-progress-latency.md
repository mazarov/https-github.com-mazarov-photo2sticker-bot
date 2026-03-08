# Single Flow: задержка показа прогресса после клика на "Эмоция / Движение"

## Контекст

Во флоу `Создать стикер` пользователь нажимает `😊 Эмоция` или `🏃 Движение`, но визуальный прогресс (`progress.step1`) появляется с задержкой примерно 1-2 секунды.

## Симптом

- Клик по inline-кнопке отрабатывает.
- В течение ~1-2 секунд нет заметного UI-изменения.
- После этого появляется сообщение прогресса.

## Architecture Check

- **Source of truth:** общий запуск генерации в `startGeneration()` (`src/index.ts`), т.к. именно там выполняется запуск job и показ прогресса.
- **Затронутые flow/состояния:**
  - `single`: `emotion_*`, `motion_*`, также `style`/`text` через тот же запуск.
  - `assistant`: использует тот же `startGeneration()` для фактического старта.
  - `pack`: отдельный путь с ранним UI-lock (`lockPackUiForProcessing`), поэтому UX отличается.
- **Класс проблемы:** порядок операций в shared-слое (поздний UI-feedback), а не ошибка конкретной кнопки.

## Root Cause

В `single/assistant` сообщение прогресса отправляется в самом конце `startGeneration()` после цепочки последовательных операций:

1. optimistic claim сессии (`session_rev`);
2. `deduct_credits` (RPC);
3. `increment_generations` (RPC);
4. update `sessions` в `processing_*`;
5. `enqueueJob`;
6. и только затем `sendProgressStart()`.

Из-за этого пользователь не видит мгновенного визуального подтверждения после клика.

Для `pack` flow задержка менее заметна, потому что там есть ранний UI-lock:

- `lockPackUiForProcessing()` меняет inline-кнопки на `⏳ ...` сразу;
- затем отправляется progress message.

## Fix type: architectural

`Fix type: architectural`

**Почему:** требуется изменить общий порядок UI-feedback в shared-цепочке запуска генерации, а не локально "подкрутить" один callback-хендлер.

## Предлагаемое решение

1. Добавить ранний визуальный отклик для `single/assistant` до тяжелых DB/RPC шагов:
   - либо ранний progress message,
   - либо UI-lock текущей клавиатуры (аналог pack flow).
2. Сохранить атомарность бизнес-операций:
   - не менять порядок списания кредитов и постановки job в очередь в рискованный вариант.
3. Исключить дубль прогресс-сообщений:
   - если ранний прогресс уже показан, поздний `sendProgressStart()` должен обновлять/переиспользовать сообщение, а не отправлять второе.
4. Добавить измерение latency:
   - `callback_received_at`,
   - `progress_shown_at`,
   - `progress_latency_ms`.

## Проверка после правки

- `single` → `emotion`: прогресс виден сразу после клика.
- `single` → `motion`: прогресс виден сразу после клика.
- `single` → `style` и `text`: нет регрессии.
- `assistant` запуск: нет регрессии.
- `pack` flow: поведение не ухудшилось.
- При ошибке/недостатке кредитов не остается "висячего" ложного прогресса.
- При двойном клике нет дублирования `jobs` и лишних progress-сообщений.

## Критерии приемки

- Визуальный feedback после клика на `emotion_*` / `motion_*` появляется <= 300 ms в большинстве случаев.
- Нет дублей progress message.
- Нет роста ошибок `session_not_found`, `stale_callback`, duplicate generation.

## Риски

- Ложный ранний прогресс при последующем отказе в запуске (нужен rollback UI).
- Повторные клики могут создавать коллизию по состояниям, если не сохранить idempotency-guard.

## Пошаговая реализация

### Файл: `src/index.ts`

---

### Шаг 1. Добавить новый параметр `earlyProgressMessageId` в `startGeneration`

В сигнатуру `startGeneration` (строка ~1290) добавить опциональное поле:

```typescript
options: {
  generationType: "style" | "emotion" | "motion" | "text" | "replace_subject";
  promptFinal: string;
  // ... существующие поля ...
  earlyProgressMessageId?: number | null;  // <-- ДОБАВИТЬ
}
```

Это позволит передавать ID уже отправленного progress-сообщения из callback-хендлера.

---

### Шаг 2. Изменить `sendProgressStart` — переиспользовать раннее сообщение

Текущий код (строка ~1041):

```typescript
async function sendProgressStart(ctx: any, sessionId: string, lang: string) {
  const msg = await ctx.reply(await getText(lang, "progress.step1"));
  if (msg?.message_id && ctx.chat?.id) {
    await supabase
      .from("sessions")
      .update({ progress_message_id: msg.message_id, progress_chat_id: ctx.chat.id })
      .eq("id", sessionId);
  }
}
```

Заменить на:

```typescript
async function sendProgressStart(
  ctx: any,
  sessionId: string,
  lang: string,
  existingMessageId?: number | null
) {
  const progressText = await getText(lang, "progress.step1");

  if (existingMessageId && ctx.chat?.id) {
    // Переиспользуем ранний progress: обновляем текст (на случай если отличается)
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        existingMessageId,
        undefined,
        progressText
      );
    } catch {
      // Если edit не удался — не критично, текст уже показан
    }
    await supabase
      .from("sessions")
      .update({ progress_message_id: existingMessageId, progress_chat_id: ctx.chat.id })
      .eq("id", sessionId);
    return;
  }

  const msg = await ctx.reply(progressText);
  if (msg?.message_id && ctx.chat?.id) {
    await supabase
      .from("sessions")
      .update({ progress_message_id: msg.message_id, progress_chat_id: ctx.chat.id })
      .eq("id", sessionId);
  }
}
```

---

### Шаг 3. Передать `earlyProgressMessageId` в вызов `sendProgressStart`

В конце `startGeneration` (строка ~1591) заменить:

```typescript
await sendProgressStart(ctx, session.id, lang);
```

на:

```typescript
await sendProgressStart(ctx, session.id, lang, options.earlyProgressMessageId);
```

---

### Шаг 4. Добавить helper `sendEarlyProgress`

Рядом с `sendProgressStart` (после строки ~1049) добавить:

```typescript
async function sendEarlyProgress(ctx: any, lang: string): Promise<number | null> {
  try {
    const text = lang === "ru" ? "⏳ Запускаю генерацию..." : "⏳ Starting generation...";
    const msg = await ctx.reply(text);
    return msg?.message_id || null;
  } catch {
    return null;
  }
}
```

---

### Шаг 5. Вызвать `sendEarlyProgress` в callback-хендлерах emotion/motion

#### 5a. Хендлер `emotion_*` (строка ~8598, перед `await startGeneration`)

Текущий код:

```typescript
  const emotionTemplate = await getPromptTemplate("emotion");
  const promptFinal = buildPromptFromTemplate(emotionTemplate, preset.prompt_hint);
  await startGeneration(ctx, user, session, lang, {
    generationType: "emotion",
    promptFinal,
    emotionPrompt: preset.prompt_hint,
    selectedEmotion: preset.id,
  });
```

Заменить на:

```typescript
  const earlyMsgId = await sendEarlyProgress(ctx, lang);
  const emotionTemplate = await getPromptTemplate("emotion");
  const promptFinal = buildPromptFromTemplate(emotionTemplate, preset.prompt_hint);
  await startGeneration(ctx, user, session, lang, {
    generationType: "emotion",
    promptFinal,
    emotionPrompt: preset.prompt_hint,
    selectedEmotion: preset.id,
    earlyProgressMessageId: earlyMsgId,
  });
```

#### 5b. Хендлер `motion_*` (строка ~8810, перед `await startGeneration`)

Аналогично: добавить `const earlyMsgId = await sendEarlyProgress(ctx, lang);` перед `getPromptTemplate("motion")` и передать `earlyProgressMessageId: earlyMsgId` в `startGeneration`.

---

### Шаг 6. Обработка ошибок — удалить ранний прогресс при отказе

В `startGeneration`, в местах где генерация НЕ запускается (paywall, insufficient credits, claim failed), нужно удалить ранний progress, чтобы не оставлять "висячее" сообщение.

После каждого `return` в ветках ошибок (строки ~1312, ~1332, ~1345, ~1438-1445, ~1478-1482) добавить перед `return`:

```typescript
if (options.earlyProgressMessageId && ctx.chat?.id) {
  ctx.telegram.deleteMessage(ctx.chat.id, options.earlyProgressMessageId).catch(() => {});
}
```

Для удобства можно вынести в helper:

```typescript
function deleteEarlyProgress(ctx: any, messageId?: number | null) {
  if (messageId && ctx.chat?.id) {
    ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {});
  }
}
```

И вызывать `deleteEarlyProgress(ctx, options.earlyProgressMessageId)` перед каждым `return` в ветках ошибок.

---

### Шаг 7. НЕ трогать pack flow

Pack flow использует свой `lockPackUiForProcessing` и не проходит через `startGeneration` для preview/approve. Ничего менять в pack flow не нужно.

---

### Шаг 8. Логирование latency (опционально)

В callback-хендлерах `emotion_*` / `motion_*` в начале добавить:

```typescript
const callbackReceivedAt = Date.now();
```

После `sendEarlyProgress`:

```typescript
console.log("[single.gen.api] early_progress", {
  generationType: "emotion", // или "motion"
  latencyMs: Date.now() - callbackReceivedAt,
});
```

---

### Итого: какие функции/места меняются

| Что | Где | Действие |
|-----|-----|----------|
| `sendProgressStart` | строка ~1041 | Добавить параметр `existingMessageId`, логика переиспользования |
| `startGeneration` signature | строка ~1290 | Добавить `earlyProgressMessageId` в options |
| `startGeneration` конец | строка ~1591 | Передать `earlyProgressMessageId` в `sendProgressStart` |
| `startGeneration` ветки ошибок | строки ~1312, ~1332, ~1345, ~1469, ~1491 | Удалять ранний progress при отказе |
| `sendEarlyProgress` | новая функция после строки ~1049 | Создать |
| `deleteEarlyProgress` | новая функция после строки ~1049 | Создать |
| `emotion_*` хендлер | строка ~8642 | Вызвать `sendEarlyProgress` + передать ID |
| `motion_*` хендлер | строка ~8810 | Вызвать `sendEarlyProgress` + передать ID |

---

### Чего НЕ делать

- Не менять порядок `deduct_credits` / `enqueueJob` — бизнес-атомарность важнее.
- Не трогать pack flow (`lockPackUiForProcessing`, `pack_preview_pay`, `pack_approve`).
- Не отправлять второе progress-сообщение, если `earlyProgressMessageId` уже передан.
- Не добавлять ранний прогресс в `style` flow (там пользователь выбирает стиль из списка, задержка менее заметна). Можно добавить позже отдельным шагом.

## Обновление архитектурной документации после реализации

После внедрения изменения обновить:

- `docs/architecture/01-api-bot.md` (изменение последовательности callback -> UI feedback -> generation start),
- при необходимости `docs/architecture/09-known-issues.md` (если останутся ограничения/workaround).
