# Умный ассистент v2: Agent с Function Calling

## Проблема текущей архитектуры

LLM-ассистент работает как FSM (конечный автомат), замаскированный под диалог:

| Проблема | Где в коде |
|---|---|
| Жёсткие шаги 0-6, LLM обязан возвращать `step: N` в `<!-- PARAMS -->` | `ai-chat.ts:282-310` |
| Код парсит текст LLM regex-ом вместо получения структурированных данных | `parseAssistantMetadata()` |
| Confirm-логика — 9 слов в массиве | `index.ts:1375` `confirmWords` |
| Нет merge параметров — LLM может потерять ранее собранные данные | `mapParamsToSessionFields()` |
| Промпт 215 строк — LLM плохо следует сложным пошаговым алгоритмам | `buildSystemPrompt()` |
| Fallback extraction — дополнительный API call при потере metadata | `extractParamsFromConversation()` |

---

## Решения (принятые)

| # | Вопрос | Решение |
|---|--------|---------|
| a | `text` параметр | Убираем из tools (шаг удалён) |
| b | OpenAI fallback | Поддерживаем оба провайдера (Gemini + OpenAI) |
| c | `request_photo` tool | Tool call меняет session state → `assistant_wait_photo` |
| d | Multi-part response | Обрабатываем и text, и functionCall из одного ответа |
| e | Confirm button | Оставляем inline `[✅ Подтвердить]` |
| f | Фазы | Сразу Фаза 2 — полный переход на function calling |

---

## Целевая архитектура

### Принцип

Вместо пошагового алгоритма — **цель + инструменты**:
- LLM получает цель (собрать параметры) и набор функций (tools)
- LLM сам решает когда вызвать функцию, код получает чистый JSON
- Код управляет состоянием, LLM управляет диалогом

### Сравнение

| Текущий подход | Agent-архитектура |
|---|---|
| Step-based FSM (`step: 0-6`) | Intent-based routing через tools |
| `<!-- PARAMS:{} -->` в тексте | Function calling → структурированный JSON |
| Regex confirm (`["да", "ок"]`) | LLM вызывает `confirm_and_generate()` |
| Промпт 215 строк с алгоритмом | Промпт ~60 строк с целью + tools |
| Код парсит текст LLM | Код получает JSON из function calls |
| `extractParamsFromConversation()` — доп. API call | Не нужен — данные всегда в function calls |

---

## Tools Definition

3 инструмента для LLM:

```typescript
const ASSISTANT_TOOLS = [
  {
    name: "update_sticker_params",
    description: "Call when user provides sticker parameters. Can update one or several at once. Call every time user mentions any parameter.",
    parameters: {
      type: "object",
      properties: {
        style: { type: "string", description: "Sticker visual style (e.g. anime, cartoon, minimal, line art)" },
        emotion: { type: "string", description: "Emotion to express (e.g. happy, sad, surprised, love)" },
        pose: { type: "string", description: "Pose or gesture (e.g. peace sign, thumbs up, waving)" },
      },
    },
  },
  {
    name: "confirm_and_generate",
    description: "Call when user explicitly confirms all parameters and is ready to generate the sticker. User must say something like 'yes', 'ok', 'confirm', 'go ahead'.",
  },
  {
    name: "request_photo",
    description: "Call when you need to ask the user for a photo to create a sticker from.",
  },
];
```

### Как работает

**Сценарий 1: пользователь даёт один параметр**
1. User: "аниме стиль"
2. LLM text: "Аниме — отличный выбор! Какую эмоцию хочешь?"
3. LLM function_call: `update_sticker_params({ style: "anime" })`
4. Код: мержит `{ style: "anime" }` с existing → сохраняет в `assistant_sessions`

**Сценарий 2: пользователь даёт несколько параметров**
1. User: "аниме, весёлый, руки вверх"
2. LLM text: "Всё понял! Проверь: ..."
3. LLM function_call: `update_sticker_params({ style: "anime", emotion: "happy", pose: "hands up" })`
4. Код: мержит все 3 → все собраны → показываем `[✅ Подтвердить]`

**Сценарий 3: подтверждение**
1. User: "да, всё верно"
2. LLM function_call: `confirm_and_generate()`
3. Код: `handleAssistantConfirm()` → генерация

**Сценарий 4: запрос фото**
1. LLM text: "Пришли мне фото для стикера"
2. LLM function_call: `request_photo()`
3. Код: state → `assistant_wait_photo`

---

## System Prompt (новый, ~60 строк)

```
You are a sticker creation assistant. Your goal: collect 3 parameters 
from the user (style, emotion, pose) and confirm them before generation.

You have these tools:
- update_sticker_params() — call when user provides any parameter(s)
- confirm_and_generate() — call ONLY when user explicitly confirms
- request_photo() — call when you need to ask for a photo

Rules:
1. First, understand user's goal (why they need stickers)
2. Then ask for a photo via request_photo()
3. After photo received, collect style, emotion, pose — one at a time
4. If user gives multiple params at once — accept all via single tool call
5. NEVER ask for parameters already collected (see [SYSTEM STATE])
6. When all 3 params collected — show mirror message and STOP
7. After mirror — wait for user. If they confirm → call confirm_and_generate()
8. If they want changes → call update_sticker_params() with new values

Mirror message format (when all 3 collected):
  – **Style:** value
  – **Emotion:** value  
  – **Pose:** value
NEVER use quotes around values. Plain text only.

For experienced users (total_generations > 10):
  Combine style + emotion + pose into one question.

Speak in user's language. Address by first_name.
Be calm, confident, collaborative. No marketing language.
Do NOT mention AI, models, or neural networks.
```

---

## State Injection

Перед каждым вызовом LLM — инжектируем состояние из `assistant_sessions`:

```typescript
function buildStateInjection(aSession: AssistantSessionRow): string {
  const collected: Record<string, string | null> = {
    style: aSession.style || null,
    emotion: aSession.emotion || null,
    pose: aSession.pose || null,
  };

  const missing = Object.entries(collected)
    .filter(([_, v]) => v === null)
    .map(([k]) => k);

  const lines = [
    `[SYSTEM STATE]`,
    `Collected: ${JSON.stringify(collected)}`,
  ];

  if (missing.length > 0) {
    lines.push(`Still need: ${missing.join(", ")}`);
  } else {
    lines.push(`All parameters collected. Show mirror and wait for user confirmation.`);
  }

  lines.push(`DO NOT ask for already collected parameters.`);
  return lines.join("\n");
}
```

---

## Merge параметров

Tool calls обрабатываются кодом с merge (данные никогда не теряются):

```typescript
function handleToolCall(
  toolName: string,
  args: Record<string, any>,
  aSession: AssistantSessionRow
): { updates: Partial<AssistantSessionRow>; action: "params" | "confirm" | "photo" | "none" } {
  if (toolName === "update_sticker_params") {
    return {
      updates: {
        style: args.style || aSession.style || undefined,
        emotion: args.emotion || aSession.emotion || undefined,
        pose: args.pose || aSession.pose || undefined,
      },
      action: "params",
    };
  }
  if (toolName === "confirm_and_generate") {
    return { updates: { confirmed: true }, action: "confirm" };
  }
  if (toolName === "request_photo") {
    return { updates: {}, action: "photo" };
  }
  return { updates: {}, action: "none" };
}
```

---

## Gemini Function Calling API

```typescript
// Request
const response = await axios.post(
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
  {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: messages,
    tools: [{ function_declarations: ASSISTANT_TOOLS }],
    tool_config: { function_calling_config: { mode: "AUTO" } },
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  },
  { headers: { "x-goog-api-key": GEMINI_API_KEY }, timeout: 15000 }
);

// Response parsing — может содержать и text, и functionCall
const parts = response.data?.candidates?.[0]?.content?.parts || [];
let textResponse = "";
let toolCall: { name: string; args: Record<string, any> } | null = null;

for (const part of parts) {
  if (part.text) textResponse += part.text;
  if (part.functionCall) {
    toolCall = { name: part.functionCall.name, args: part.functionCall.args || {} };
  }
}
```

## OpenAI Function Calling API

```typescript
// Request
const response = await axios.post(
  "https://api.openai.com/v1/chat/completions",
  {
    model: MODEL,
    messages: openaiMessages,
    tools: ASSISTANT_TOOLS.map(t => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: "object", properties: {} },
      },
    })),
    tool_choice: "auto",
    temperature: 0.7,
    max_tokens: 1024,
  },
  {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    timeout: 15000,
  }
);

// Response parsing
const choice = response.data?.choices?.[0];
const textResponse = choice?.message?.content || "";
const toolCalls = choice?.message?.tool_calls || [];
let toolCall: { name: string; args: Record<string, any> } | null = null;

if (toolCalls.length > 0) {
  const tc = toolCalls[0];
  toolCall = {
    name: tc.function.name,
    args: JSON.parse(tc.function.arguments || "{}"),
  };
}
```

---

## Что удаляем

| Код | Файл | Причина |
|---|---|---|
| `parseAssistantMetadata()` | `ai-chat.ts` | Заменяется function calling |
| `stripMetadata()` | `ai-chat.ts` | Больше нет `<!-- PARAMS -->` |
| `extractParamsFromConversation()` | `ai-chat.ts` | Не нужен fallback — данные из tool calls |
| `PARAMS_REGEX` | `ai-chat.ts` | Не нужен |
| `confirmWords` массив | `index.ts:1375` | LLM сам вызывает `confirm_and_generate()` |
| `step === 5` проверки | `index.ts` | Нет step-based логики |
| `AssistantParams.step` | `ai-chat.ts` | Нет step |
| `AssistantParams.text` | `ai-chat.ts` | Убран |
| `current_step` column | `assistant_sessions` | Больше не нужен (оставим в БД, не используем) |
| System prompt 215 строк | `buildSystemPrompt()` | Заменяется ~60 строк |

---

## Что оставляем

| Код | Причина |
|---|---|
| `assistant_wait_photo` state | Нужен для фото-потока |
| `assistant_chat` state | Основной диалоговый state |
| `wait_assistant_confirm` state | НЕ нужен — убираем (LLM решает через tool) |
| Inline `[✅ Подтвердить]` кнопка | Оставляем — показываем когда все params собраны |
| `assistant_confirm` callback | Оставляем — вызывает `handleAssistantConfirm()` |
| `handleAssistantConfirm()` | Оставляем — запускает генерацию |
| `buildAssistantPrompt()` | Оставляем — строит промпт для Gemini Image |
| `assistant_sessions` таблица | Оставляем — хранит state |
| `getActiveAssistantSession()` | Оставляем |
| `updateAssistantSession()` | Оставляем |
| Retry/backoff в `callAIChat()` | Оставляем |
| `bot.on("photo")` хендлер для assistant | Оставляем, упрощаем |
| `assistant_new_photo` / `assistant_keep_photo` | Оставляем (замена фото mid-dialog) |

---

## Что меняем

### `wait_assistant_confirm` → убираем

Сейчас есть 3 state: `assistant_wait_photo`, `assistant_chat`, `wait_assistant_confirm`.

В новой архитектуре `wait_assistant_confirm` **не нужен** — LLM сам вызовет `confirm_and_generate()`. Но inline-кнопка `[✅ Подтвердить]` остаётся.

Новая логика:
- Все params собраны + tool call `update_sticker_params` → показываем кнопку, state остаётся `assistant_chat`
- User нажимает кнопку → `handleAssistantConfirm()` (как раньше)
- User пишет текст "да" → уходит в LLM → LLM вызывает `confirm_and_generate()` → `handleAssistantConfirm()`
- User пишет "измени стиль" → уходит в LLM → LLM вызывает `update_sticker_params({ style: "..." })`

Это упрощает routing в `bot.on("text")` — нет отдельной ветки для `wait_assistant_confirm`.

---

## Подробный план реализации

### Шаг 1. Новые типы и tools definition (~30 мин)

**Файл: `src/lib/ai-chat.ts`**

1. Добавить `ASSISTANT_TOOLS` — массив tool definitions (3 инструмента)
2. Добавить `ToolCall` interface:
   ```typescript
   interface ToolCall {
     name: string;
     args: Record<string, any>;
   }
   ```
3. Изменить `AIChatResult`:
   ```typescript
   interface AIChatResult {
     text: string;          // Текст для пользователя
     toolCall: ToolCall | null;  // Function call (если есть)
   }
   ```
4. Убрать `AssistantParams` interface (больше не нужен)
5. Убрать `parseAssistantMetadata()`, `stripMetadata()`, `PARAMS_REGEX`
6. Убрать `extractParamsFromConversation()` (fallback не нужен)

### Шаг 2. Новый system prompt (~30 мин)

**Файл: `src/lib/ai-chat.ts`**

1. Переписать `buildSystemPrompt()` — ~60 строк вместо 215
2. Убрать все `<!-- PARAMS -->` инструкции
3. Убрать step-based логику
4. Добавить параметр `stateInjection: string` — инжектируется в конец промпта

### Шаг 3. Gemini function calling в `callGemini()` (~1 час)

**Файл: `src/lib/ai-chat.ts`**

1. Добавить `tools` и `tool_config` в request body:
   ```typescript
   tools: [{ function_declarations: ASSISTANT_TOOLS }],
   tool_config: { function_calling_config: { mode: "AUTO" } },
   ```
2. Парсить response — извлекать все `parts`:
   - Если `part.functionCall` → вернуть как `toolCall`
   - Если `part.text` → вернуть как `text`
3. Вернуть `{ text, toolCall }`

### Шаг 4. OpenAI function calling в `callOpenAI()` (~30 мин)

**Файл: `src/lib/ai-chat.ts`**

1. Добавить `tools` в request body (формат OpenAI: `type: "function"`)
2. Парсить response:
   - `choice.message.content` → text
   - `choice.message.tool_calls[0]` → toolCall
3. Вернуть `{ text, toolCall }`

### Шаг 5. `handleToolCall()` в `assistant-db.ts` (~30 мин)

**Файл: `src/lib/assistant-db.ts`**

1. Добавить `handleToolCall()` — обрабатывает tool call с merge:
   - `update_sticker_params` → мержит с existing данными
   - `confirm_and_generate` → `{ confirmed: true }`
   - `request_photo` → `{ action: "photo" }`
2. Добавить `buildStateInjection()` — формирует `[SYSTEM STATE]` блок
3. Добавить `allParamsCollected()` — проверяет что style + emotion + pose заполнены
4. Убрать `mapParamsToSessionFields()` (заменяется `handleToolCall`)
5. Оставить `getAssistantParams()` — используется в `handleAssistantConfirm()`

### Шаг 6. Рефакторинг `index.ts` — основная работа (~2-3 часа)

**Файл: `src/index.ts`**

#### 6a. `startAssistantDialog()` — упрощение

- Убрать step-based логику
- State injection не нужен на первом вызове (нет параметров)
- Обработать `toolCall` из первого ответа (обычно `request_photo`)

#### 6b. `bot.on("photo")` — `assistant_wait_photo` хендлер

- После сохранения фото и получения ответа LLM:
  - Проверить `result.toolCall` → `handleToolCall()` → сохранить params
  - Если `allParamsCollected()` → показать mirror + `[✅ Подтвердить]`
  - Отправить `result.text` пользователю

#### 6c. `bot.on("text")` — `assistant_chat` хендлер (КЛЮЧЕВОЕ ИЗМЕНЕНИЕ)

Текущий код:
```
if assistant_wait_photo → ...
if assistant_chat → callAIChat → parseMetadata → check step === 5 → ...
if wait_assistant_confirm → check confirmWords → handleAssistantConfirm ...
```

Новый код (одна ветка для `assistant_chat`):
```
if assistant_wait_photo → callAIChat → check toolCall → ...
if assistant_chat → callAIChat → check toolCall:
  - update_sticker_params → merge, save, if allCollected → show confirm button
  - confirm_and_generate → handleAssistantConfirm()
  - request_photo → state → assistant_wait_photo
  - no toolCall → just send text
```

Убрать отдельную ветку `wait_assistant_confirm` — всё через `assistant_chat`.

#### 6d. `assistant_confirm` callback

- Оставить как есть — кнопка вызывает `handleAssistantConfirm()`
- Добавить проверку: если state не `assistant_chat` — игнорировать

#### 6e. State injection перед каждым `callAIChat`

В каждом месте где вызываем `callAIChat` для ассистента:
```typescript
const stateInjection = buildStateInjection(aSession);
const systemPrompt = buildSystemPrompt(ctx) + "\n\n" + stateInjection;
```

#### 6f. Очистка imports

- Убрать: `parseAssistantMetadata`, `stripMetadata`, `extractParamsFromConversation`, `AssistantParams`
- Добавить: `handleToolCall`, `buildStateInjection`, `allParamsCollected`

### Шаг 7. Миграция session states (~15 мин)

**SQL миграция:**

```sql
-- Удаляем state wait_assistant_confirm — больше не используется
-- Existing rows с этим state переводим в assistant_chat
UPDATE sessions SET state = 'assistant_chat' 
WHERE state = 'wait_assistant_confirm';
```

Или оставляем state в enum но не используем (безопаснее).

### Шаг 8. Тестирование (~1 час)

**На тестовом боте проверяем:**

1. `/start` → приветствие → просит фото (tool `request_photo`)
2. Фото → просит стиль
3. "аниме" → tool `update_sticker_params({style})` → просит эмоцию
4. "весёлый, руки вверх" → tool `update_sticker_params({emotion, pose})` → mirror + `[✅]`
5. Нажатие `[✅]` → генерация
6. Текстовый confirm "да" → LLM вызывает `confirm_and_generate()` → генерация
7. "измени стиль на 3D" → tool `update_sticker_params({style: "3D"})` → новый mirror
8. Новое фото mid-dialog → `assistant_new_photo` / `assistant_keep_photo`
9. Опытный пользователь → LLM объединяет вопросы
10. OpenAI провайдер (если доступен)

---

## Файлы для изменений

| Файл | Действие | Объём |
|---|---|---|
| `src/lib/ai-chat.ts` | Полная переработка: tools, новый prompt, function calling | ~300 строк |
| `src/lib/assistant-db.ts` | Добавить: `handleToolCall`, `buildStateInjection`, `allParamsCollected` | ~60 строк |
| `src/index.ts` | Рефакторинг: упростить routing, убрать step/params/confirm логику | ~200 строк меняем |

**Общая оценка: 5-6 часов работы**

---

## Риски и mitigation

| Риск | Mitigation |
|---|---|
| Gemini не всегда вызывает tool | `tool_config: { mode: "AUTO" }` + fallback: если нет tool call, обрабатываем как обычный текст |
| LLM вызывает `confirm_and_generate` преждевременно | Проверка в коде: `allParamsCollected()` перед генерацией, иначе игнорируем |
| OpenAI и Gemini разный формат tool calls | Абстракция в `callAIChat()` — обе реализации возвращают одинаковый `AIChatResult` |
| Потеря данных при merge | `args.style \|\| aSession.style` — новые значения перезаписывают, старые сохраняются |
| `wait_assistant_confirm` state в existing sessions | SQL миграция: перевести в `assistant_chat` |
