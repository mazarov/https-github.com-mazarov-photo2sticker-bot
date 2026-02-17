# Идеи для стикера сразу после фото (AI Ассистент)

## Проблема

Текущий флоу AI Ассистента слишком длинный:
```
Фото → LLM спрашивает стиль → LLM спрашивает эмоцию → LLM спрашивает позу → Зеркало → Подтвердить → Генерация
```
5 шагов от фото до генерации. Пользователь теряется, отваливается.

## Новый флоу

```
/start → "Пришли фото" → Фото загружено
    ↓
⏳ "Подбираю идеи..." (LLM генерит идеи по фото + стилю, ~3-5 сек)
    ↓
💡 Идея 1/8
🎨 Стиль: 🎌 Аниме
😂 Хохочет до слёз
Персонаж смеётся, держась за живот

[🎨 Сгенерить (1💎)]
[🔄 Другой стиль] [➡️ Другая идея]
[✏️ Своя идея]
[⏭️ Пропустить — обычный диалог]
    ↓
Генерация: style + idea → generatePrompt() → Gemini
    ↓
Стикер + стандартные кнопки
```

**1 шаг** от фото до генерации. Стиль + эмоция + поза — всё предложено сразу.

## Откуда берутся идеи

### LLM генерит идеи (как `generatePackIdeas`)

Переиспользуем тот же подход что и фича "Идеи для пака":
- Отправляем **фото пользователя** + **prompt_hint выбранного стиля** в GPT-4o-mini
- Просим сгенерировать 8 разнообразных идей для стикера
- Формат ответа — тот же `StickerIdea[]`

Отличие от `generatePackIdeas`:
- `generatePackIdeas` анализирует **уже сгенерированный стикер** (содержит стиль, одежду)
- Здесь анализируем **оригинальное фото** (без стиля) — поэтому промпт адаптируется

Новая функция: `generateStickerIdeasFromPhoto(opts)`:
```typescript
async function generateStickerIdeasFromPhoto(opts: {
  photoFileId: string;     // оригинальное фото пользователя
  stylePresetId: string;   // выбранный стиль
  lang: string;
}): Promise<StickerIdea[]>
```

Системный промпт для LLM:
```
You are a professional sticker designer.
Analyze the user's photo and suggest 8 unique sticker ideas in the style: {styleName} ({styleHint}).

For each idea — describe a new expressive pose, emotion, or scene for the character.
Match ideas to the person in the photo (their appearance, vibe, energy).

CRITICAL: promptModification must describe what the CHARACTER is DOING, not the style.
The style comes from the preset — ideas add emotion/pose/action on top.

Categories: emotion, reaction, action, scene, text_meme, greeting, farewell, sarcasm...
```

**Fallback**: если LLM не ответил — используем `getDefaultIdeas(lang)` (захардкоженный список).

**Стоимость**: ~$0.003 за вызов GPT-4o-mini с фото. Приемлемо.
**Время**: ~3-5 сек. Показываем "⏳ Подбираю идеи..." пока ждём.

Стиль при первом показе — **случайный из `style_presets_v2`**.

## Как модифицировать промпт

Через `prompt_generator` агент (тот же LLM что и ручной/ассистентский режим):

```
userText = preset.prompt_hint + ", " + idea.promptModification
    ↓
generatePrompt(userText)
    ↓
promptFinal (полный промпт для Gemini image generation)
```

LLM-агент добавит: композицию, фон, качество, запрет на бордер и т.д.

Пример:
```
userText = "Anime style, big expressive eyes, clean lines, vibrant colors, laughing hysterically, holding belly, tears of joy"
    ↓
generatePrompt(userText)
    ↓
promptFinal = "Create a high-quality character illustration. Style: Anime with big expressive eyes...
Subject: Analyze the provided photo. If ONE person — use their face...
Composition: Head, shoulders visible with generous padding...
Background: Flat uniform single color...
..."
```

**Fallback**: если `generatePrompt` упал — `buildAssistantPrompt` как шаблон.

## Формат идеи

Переиспользуем существующий `StickerIdea` (тот же формат что в pack_ideas):
```typescript
interface StickerIdea {
  emoji: string;
  titleRu: string;
  titleEn: string;
  descriptionRu: string;
  descriptionEn: string;
  promptModification: string;
  hasText: boolean;
  textSuggestion: string | null;
  textPlacement: string | null;
  category: string;
}
```

## UI: карточка идеи

```
💡 Идея 1/8

🎨 Стиль: 🎌 Аниме
😂 Хохочет до слёз
Персонаж смеётся, держась за живот

[🎨 Сгенерить (1💎)]
[🔄 Другой стиль ▸] [➡️ Другая идея]
[✏️ Своя идея]
[⏭️ Пропустить]
```

### Кнопки

| Кнопка | Callback | Действие |
|--------|----------|----------|
| 🎨 Сгенерить | `asst_idea_gen:{idx}` | `prompt_hint + promptModification` → `generatePrompt()` → `startGeneration()` |
| 🔄 Другой стиль | `asst_idea_style:{idx}` | Показывает inline-кнопки со стилями (2-3 в ряд) |
| ➡️ Другая идея | `asst_idea_next:{idx}` | Следующая идея из списка (circular) |
| ✏️ Своя идея | `asst_idea_custom` | Переключает state → `assistant_chat`, LLM-диалог |
| ⏭️ Пропустить | `asst_idea_skip` | Переключает state → `assistant_chat`, обычный LLM-диалог |

### Мини-карусель стилей (при нажатии "Другой стиль")

```
🎨 Выбери стиль:

[🎌 Аниме] [🖌️ Мультфильм] [🎮 Пиксель]
[✏️ Скетч] [🧸 Chibi] [💎 3D]
```

Каждая кнопка = `asst_idea_restyle:{styleId}:{ideaIdx}`.
При смене стиля **обновляется только стиль** — идеи остаются те же, показывается текущая идея с новым стилем. Мгновенно, без LLM-вызова.

## Хранение состояния

В `sessions` новое JSONB-поле `sticker_ideas_state`:
```json
{
  "styleId": "anime_v2",
  "ideaIndex": 0,
  "ideas": [/* массив StickerIdea из LLM */]
}
```

- `styleId` — текущий выбранный стиль
- `ideaIndex` — текущая показанная идея
- `ideas` — сгенерированные LLM идеи (8 шт)

Альтернатива: хранить в `assistant_sessions` в поле `goal` или новом JSONB-поле.

## Изменения в коде

### 1. Новая функция `generateStickerIdeasFromPhoto()`

Аналог `generatePackIdeas`, но:
- На вход — оригинальное фото (не стикер)
- Промпт адаптирован: "analyze the person in the photo, suggest sticker ideas in style X"
- Fallback на `getDefaultIdeas(lang)`

### 2. Хэндлер `assistant_wait_photo` (src/index.ts, ~строка 2117)

Заменить блок "сохранить фото → callAIChat()" на:
- Сохранить фото, state → `assistant_wait_idea`
- Выбрать случайный стиль из `style_presets_v2`
- Показать "⏳ Подбираю идеи..."
- Вызвать `generateStickerIdeasFromPhoto(photo, style)`
- Сохранить идеи в `sticker_ideas_state`
- Показать `showStickerIdeaCard()`

### 3. Новый session state: `assistant_wait_idea`

Сессия в состоянии "фото есть, ждём выбор идеи/стиля".

### 4. Новая функция `showStickerIdeaCard()`

Формирует текст карточки + inline-клавиатуру (см. UI выше).

### 5. Callback handlers

- `asst_idea_gen:{idx}` — генерация с идеей:
  ```
  userText = preset.prompt_hint + ", " + idea.promptModification
  promptResult = await generatePrompt(userText)
  → startGeneration(ctx, user, session, lang, { generationType: "style", promptFinal, ... })
  ```
- `asst_idea_next:{idx}` — следующая идея (тот же стиль)
- `asst_idea_style:{idx}` — показать мини-карусель стилей
- `asst_idea_restyle:{styleId}:{idx}` — сменить стиль, перегенерировать идеи
- `asst_idea_custom` — state → `assistant_chat`, LLM-диалог
- `asst_idea_skip` — state → `assistant_chat`, LLM-диалог

### 6. SQL-миграция

```sql
ALTER TABLE sessions ADD COLUMN sticker_ideas_state jsonb DEFAULT NULL;
```

## Что НЕ меняется

- `worker.ts` — генерация стикера
- Кнопки после генерации
- Фича "Идеи для пака" (после генерации, `generatePackIdeas`) — работает как раньше
- `handleAssistantConfirm` / `buildAssistantPrompt` — остаются как fallback для LLM-диалога
- Ручной режим (карусель стилей без ассистента)
- `getDefaultIdeas()` — используется как fallback
