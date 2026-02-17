# Inline Style Buttons — Требования v2

## Описание

Добавить inline-кнопки выбора стилей после загрузки фото. Пользователь может выбрать один из 8 пресетов или написать свой стиль текстом.

---

## Текущее поведение

После отправки фото бот отвечает:
```
Отлично! Теперь опиши стиль стикера (например: мульт, 3D, акварель, аниме).
```

---

## Новое поведение

После отправки фото бот отвечает:

**Текст (ключ `photo.ask_style`):**
```
Отлично! Теперь выбери стиль стикера из вариантов ниже или напиши свой текстом.
```

**Inline-кнопки (2 в ряд):**
```
[🎌 Аниме]      [🎨 Мультфильм]
[🧊 3D]         [👾 Пиксель арт]
[📺 Симпсоны]   [🍡 Чиби]
[💧 Акварель]   [💥 Комикс]
```

---

## Логика при нажатии кнопки

1. Пользователь нажимает кнопку (например, "🎌 Аниме")
2. Берётся `prompt_hint` для этого стиля из таблицы `style_presets`
3. `prompt_hint` отправляется в `generatePrompt()` как `userInput`
4. Далее стандартный флоу: проверка кредитов → создание job → генерация

---

## Логика при вводе текста

1. Пользователь пишет текст (например, "симпсоны грустный")
2. Текст отправляется в `generatePrompt()` как `userInput`
3. Далее стандартный флоу

---

## Состояния сессии

```
wait_photo → wait_style → processing
                ↓
           (кнопка) → prompt_hint → generatePrompt() → проверка кредитов → job
                ↓
           (текст)  → userInput   → generatePrompt() → проверка кредитов → job
```

**Изменение:** `wait_description` → `wait_style`

---

## Таблица `style_presets`

```sql
create table style_presets (
  id text primary key,
  name_ru text not null,
  name_en text not null,
  prompt_hint text not null,
  emoji text not null,
  sort_order int default 0,
  is_active boolean default true,
  created_at timestamptz default now()
);

create index style_presets_active_idx on style_presets (is_active, sort_order);

INSERT INTO style_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('anime', '🎌', 'Аниме', 'Anime', 'anime style, clean lines, expressive eyes, detailed hair', 1),
  ('cartoon', '🎨', 'Мультфильм', 'Cartoon', 'cartoon style, bold outlines, vibrant colors, exaggerated features', 2),
  ('3d', '🧊', '3D', '3D', '3D rendered style, volumetric lighting, smooth surfaces', 3),
  ('pixel', '👾', 'Пиксель арт', 'Pixel Art', 'pixel art style, retro game aesthetic, 8-bit', 4),
  ('simpsons', '📺', 'Симпсоны', 'Simpsons', 'The Simpsons cartoon style, yellow skin, flat 2D, overbite', 5),
  ('chibi', '🍡', 'Чиби', 'Chibi', 'chibi style, big head, small body, cute, kawaii', 6),
  ('watercolor', '💧', 'Акварель', 'Watercolor', 'watercolor painting style, soft edges, artistic', 7),
  ('comic', '💥', 'Комикс', 'Comic', 'comic book style, halftone dots, dynamic poses, speech bubbles', 8);
```

---

## Обновление `bot_texts_new`

```sql
UPDATE bot_texts_new 
SET text = 'Отлично! Теперь выбери стиль стикера из вариантов ниже или напиши свой текстом.',
    updated_at = now()
WHERE lang = 'ru' AND key = 'photo.ask_style';

UPDATE bot_texts_new 
SET text = 'Great! Now choose a sticker style from the options below or describe your own.',
    updated_at = now()
WHERE lang = 'en' AND key = 'photo.ask_style';
```

---

## Изменения в коде

### 1. Photo handler (`index.ts`)

```typescript
// После получения фото — состояние wait_style + показать кнопки
await supabase
  .from("sessions")
  .update({ photos, state: "wait_style" })
  .eq("id", session.id);

await sendStyleKeyboard(ctx, lang);
```

### 2. Новая функция `sendStyleKeyboard`

```typescript
async function sendStyleKeyboard(ctx: any, lang: string) {
  const presets = await getStylePresets();
  
  const buttons: any[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row = [];
    row.push(Markup.button.callback(
      `${presets[i].emoji} ${lang === "ru" ? presets[i].name_ru : presets[i].name_en}`,
      `style_${presets[i].id}`
    ));
    if (presets[i + 1]) {
      row.push(Markup.button.callback(
        `${presets[i + 1].emoji} ${lang === "ru" ? presets[i + 1].name_ru : presets[i + 1].name_en}`,
        `style_${presets[i + 1].id}`
      ));
    }
    buttons.push(row);
  }
  
  await ctx.reply(
    await getText(lang, "photo.ask_style"),
    Markup.inlineKeyboard(buttons)
  );
}
```

### 3. Callback handler для кнопок стиля

```typescript
bot.action(/^style_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const styleId = ctx.match[1];
  
  // Получить preset
  const presets = await getStylePresets();
  const preset = presets.find(p => p.id === styleId);
  if (!preset) return;
  
  // Использовать prompt_hint как userInput
  const userInput = preset.prompt_hint;
  
  // Далее стандартная логика генерации...
});
```

### 4. Text handler — обновить проверку состояния

```typescript
// Обрабатывать текст в состоянии wait_style
if (session.state !== "wait_style") {
  if (session.state === "wait_photo") {
    await ctx.reply(await getText(lang, "photo.need_photo"));
  }
  return;
}
```

---

## Кэширование стилей

```typescript
let stylePresetsCache: { data: any[]; timestamp: number } | null = null;
const STYLE_PRESETS_CACHE_TTL = 5 * 60 * 1000; // 5 минут

async function getStylePresets() {
  const now = Date.now();
  if (stylePresetsCache && now - stylePresetsCache.timestamp < STYLE_PRESETS_CACHE_TTL) {
    return stylePresetsCache.data;
  }

  const { data } = await supabase
    .from("style_presets")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");

  if (data) {
    stylePresetsCache = { data, timestamp: now };
  }
  return data || [];
}
```

---

## Чеклист реализации

- [ ] Создать таблицу `style_presets` в Supabase
- [ ] Добавить начальные данные (8 стилей)
- [ ] Обновить `photo.ask_style` в `bot_texts_new`
- [ ] Добавить функцию `getStylePresets()` с кэшированием
- [ ] Добавить функцию `sendStyleKeyboard()`
- [ ] Обновить Photo handler — state = `wait_style`, вызов `sendStyleKeyboard`
- [ ] Добавить callback handler `style_*`
- [ ] Обновить Text handler — обрабатывать состояние `wait_style`
- [ ] Тестирование
