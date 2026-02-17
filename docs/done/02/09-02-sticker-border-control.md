# Sticker Border Control

## Цель

Дать пользователю контроль над белой обводкой стикера и улучшить качество вырезания фона за счёт контрастного фона в промпте генерации.

---

## Проблемы сейчас

1. **Промпт говорит "White/transparent background"** — если персонаж светлый, rembg теряет границу
2. **Воркер добавляет 30px белый padding** перед rembg — бесполезен или вредит (rembg удаляет его вместе с фоном, или оставляет артефакты)
3. **Пользователь не может выбрать** — обводка либо есть, либо нет, зависит от удачи генерации

---

## Решение

### 1. Новый параметр `border` в ассистенте

Добавить `border: boolean` в tool `update_sticker_params`.

#### Tool Definition (в `ai-chat.ts`)

```typescript
{
  name: "update_sticker_params",
  description: "...",
  parameters: {
    type: "object",
    properties: {
      style: { ... },
      emotion: { ... },
      pose: { ... },
      border: {
        type: "boolean",
        description: "Whether to add a bold white outline/border around the sticker character. Ask the user if they want it."
      },
    },
  },
}
```

#### System Prompt — новое правило

В секции `## Conversation Flow`, после сбора style/emotion/pose:

```
After collecting style, emotion, pose — ask if user wants a white border/outline around the sticker.
Example: "Добавить белую обводку вокруг стикера?" / "Want a white border around the sticker?"
Accept: yes/no, да/нет. Default: no (if user skips or unclear).
```

#### `assistant_sessions` — новая колонка

```sql
ALTER TABLE assistant_sessions ADD COLUMN border boolean DEFAULT false;
```

#### `AssistantSessionRow` — обновить interface

```typescript
export interface AssistantSessionRow {
  // ... existing fields ...
  border: boolean;  // NEW
}
```

#### `handleToolCall()` — обработка border

```typescript
if (toolCall.name === "update_sticker_params") {
  const args = toolCall.args;
  // ... existing style/emotion/pose merge ...
  if (args.border !== undefined) updates.border = Boolean(args.border);
  return { updates, action: "params" };
}
```

#### `buildStateInjection()` — отображение border

```typescript
const collected: Record<string, string | boolean | null> = {
  style: aSession.style || null,
  emotion: aSession.emotion || null,
  pose: aSession.pose || null,
  border: aSession.border ?? null,
};
```

**Важно**: `allParamsCollected()` НЕ меняется — border необязательный, mirror показывается после style+emotion+pose. Border спрашивается параллельно или после mirror.

#### Mirror Message — добавить border

```
> – **Style:** anime
> – **Emotion:** happy
> – **Pose:** peace sign
> – **Border:** yes ✅ / no ❌
```

#### `getAssistantParams()` — обновить

```typescript
export function getAssistantParams(session: AssistantSessionRow): {
  style: string;
  emotion: string;
  pose: string;
  border: boolean;
} {
  return {
    style: session.style || "cartoon",
    emotion: session.emotion || "happy",
    pose: session.pose || "default",
    border: session.border ?? false,
  };
}
```

---

### 2. Промпт генерации — контрастный фон

#### `buildAssistantPrompt()` в `index.ts`

**Было:**
```
Requirements:
- White/transparent background
- Sticker-like proportions (head slightly larger)
- Clear outlines
- Expressive and recognizable
```

**Стало:**
```typescript
function buildAssistantPrompt(params: {
  style: string;
  emotion: string;
  pose: string;
  border: boolean;
}): string {
  const borderLine = params.border
    ? "- Bold white outline/border around the character (thick, clearly visible, uniform width)"
    : "- No outline/border around the character";

  return `Create a telegram sticker of the person from the photo.

Style: ${params.style}
Emotion: ${params.emotion}
Pose/gesture: ${params.pose}

Requirements:
- Solid black background (NOT white, NOT transparent) — critical for clean cutout
- Sticker-like proportions (head slightly larger)
${borderLine}
- Expressive and recognizable
- High contrast between character and background`;
}
```

**Ключевое изменение**: `Solid black background` вместо `White/transparent background`. Чёрный фон даёт максимальный контраст для rembg при любом стиле и цветовой гамме персонажа.

#### Ручной режим (`prompt_generator` agent в БД)

В `agents.system_prompt` для `prompt_generator` нужно обновить инструкцию:
- Заменить "white background" / "transparent background" на "solid black background"
- Это делается через SQL update в Supabase

```sql
-- Проверить текущий промпт:
SELECT name, system_prompt FROM agents WHERE name = 'prompt_generator';

-- Обновить (заменить white/transparent background на solid black):
-- UPDATE agents SET system_prompt = '...' WHERE name = 'prompt_generator';
```

#### Emotion/Motion промпты (`prompt_templates` в БД)

Проверить таблицу `prompt_templates` — если там есть упоминания "white background" или "transparent background", тоже заменить на "solid black background".

```sql
SELECT id, template FROM prompt_templates WHERE template ILIKE '%background%';
```

---

### 3. Воркер — убрать белый padding

#### `worker.ts` — удалить `.extend()`

**Было:**
```typescript
const generatedBuffer = Buffer.from(imageBase64, "base64");
const paddedBuffer = await sharp(generatedBuffer)
  .extend({
    top: 30,
    bottom: 30,
    left: 30,
    right: 30,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  })
  .toBuffer();

await updateProgress(5);
const imageSizeKb = Math.round(paddedBuffer.length / 1024);
```

**Стало:**
```typescript
const generatedBuffer = Buffer.from(imageBase64, "base64");

await updateProgress(5);
const imageSizeKb = Math.round(generatedBuffer.length / 1024);
```

Все последующие использования `paddedBuffer` заменить на `generatedBuffer`:
- rembg resize input
- rembg form data
- Pixian form data

---

## Flow

```
Ассистент:
  Сбор style → emotion → pose → border (да/нет?)
  ↓
  Mirror: стиль / эмоция / поза / обводка
  ↓
  Подтверждение → генерация

Промпт в Gemini:
  "Solid black background" + условно "Bold white outline" если border=true
  ↓
  Gemini рисует персонажа на чёрном фоне (± обводка)

Воркер:
  Получает картинку → БЕЗ padding → rembg вырезает чёрный фон → trim → 512x512 webp
```

---

## Файлы для изменений

| Файл | Что менять |
|---|---|
| `src/lib/ai-chat.ts` | Добавить `border` в `update_sticker_params` tool, обновить system prompt |
| `src/lib/assistant-db.ts` | Добавить `border` в `AssistantSessionRow`, `handleToolCall()`, `buildStateInjection()`, `getAssistantParams()` |
| `src/index.ts` | Обновить `buildAssistantPrompt()` — чёрный фон + условный border, обновить mirror message |
| `src/worker.ts` | Убрать `.extend()` padding, заменить `paddedBuffer` → `generatedBuffer` |
| SQL | `ALTER TABLE assistant_sessions ADD COLUMN border boolean DEFAULT false` |
| Supabase | Обновить `agents.system_prompt` и `prompt_templates` — заменить white/transparent → solid black background |

---

## Риски

1. **rembg + чёрный фон** — нужно протестировать. rembg обучен на разных фонах, чёрный должен работать хорошо, но стоит проверить на 5-10 генерациях
2. **Существующие стили** — few-shot примеры в `prompt_generator` могут содержать "white background". Если LLM видит противоречие между system prompt и few-shot, может проигнорировать system prompt
3. **Ручной режим** — border пока только через ассистента. Для ручного режима можно добавить позже как кнопку

---

## Оценка: ~2 часа

- 30 мин — SQL + assistant-db.ts + ai-chat.ts (border param)
- 30 мин — buildAssistantPrompt + mirror message + system prompt
- 15 мин — worker.ts (убрать padding)
- 45 мин — тестирование на тестовом боте (проверить rembg с чёрным фоном)
