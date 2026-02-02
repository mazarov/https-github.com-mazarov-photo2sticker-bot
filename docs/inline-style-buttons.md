# Inline Style Buttons — Требования

## Описание

Добавить inline-кнопки выбора стилей на шаге после загрузки фото. Пользователь может выбрать один из 8 пресетов или ввести свой стиль текстом.

---

## 1. Таблица `style_presets` в Supabase

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

-- Начальные данные
insert into style_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order) values
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

## 2. Новые состояния сессии

| Состояние | Описание |
|-----------|----------|
| `wait_style` | Ожидание выбора стиля (inline-кнопки) |
| `wait_custom_style` | Ожидание текстового описания стиля |

### Обновлённая диаграмма состояний

```
wait_photo → wait_style → wait_custom_style (если custom) → processing
                       ↘ processing (если пресет)
```

---

## 3. User Flow

```
1. Пользователь отправляет фото
   ↓
2. Бот сохраняет фото, state = "wait_style"
   ↓
3. Бот отправляет сообщение с inline-кнопками:
   
   "Выберите стиль, в котором будет создан стикер 🎨"
   
   [🎌 Аниме]     [🎨 Мультфильм]
   [🧊 3D]        [👾 Пиксель арт]
   [📺 Симпсоны]  [🍡 Чиби]
   [💧 Акварель]  [💥 Комикс]
   [✍️ Свой стиль]
   
4a. Пользователь нажимает пресет → генерация с prompt_hint
4b. Пользователь нажимает "Свой стиль" → state = "wait_custom_style"
    ↓
5. Бот: "Пришлите новое описание для стикера ✍️"
   ↓
6. Пользователь пишет текст → валидация LLM
   ↓
   OK → генерация
   FAIL → показать кнопки стилей заново (state = "wait_style")
```

---

## 4. Изменения в коде

### 4.1 Photo handler (`index.ts`)

```typescript
// После получения фото — изменить состояние на wait_style
await supabase
  .from("sessions")
  .update({ photos, state: "wait_style" })  // было wait_description
  .eq("id", session.id);

await sendStyleKeyboard(ctx, lang);
```

### 4.2 Новая функция `sendStyleKeyboard`

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
  
  // Кнопка "Свой стиль"
  buttons.push([Markup.button.callback(
    lang === "ru" ? "✍️ Свой стиль" : "✍️ Custom style",
    "style_custom"
  )]);
  
  await ctx.reply(
    await getText(lang, "state.choose_style"),
    Markup.inlineKeyboard(buttons)
  );
}
```

### 4.3 Кэширование стилей

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

### 4.4 Callback handler для выбора стиля

```typescript
bot.action(/^style_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getUser(telegramId);
  if (!user?.id) return;

  const lang = user.lang || "en";
  const session = await getActiveSession(user.id);
  if (!session?.id || session.state !== "wait_style") return;

  const styleId = ctx.match[1];

  if (styleId === "custom") {
    // Переход к текстовому вводу
    await supabase
      .from("sessions")
      .update({ state: "wait_custom_style" })
      .eq("id", session.id);

    await ctx.reply(await getText(lang, "state.new_description"));
    return;
  }

  // Получить prompt_hint для выбранного стиля
  const presets = await getStylePresets();
  const preset = presets.find((p: any) => p.id === styleId);
  if (!preset) return;

  const photosCount = Array.isArray(session.photos) ? session.photos.length : 0;

  // Проверка кредитов
  if (user.credits < photosCount) {
    await supabase
      .from("sessions")
      .update({ 
        state: "wait_buy_credit", 
        user_input: preset.prompt_hint,
        prompt_final: preset.prompt_hint 
      })
      .eq("id", session.id);

    await ctx.reply(await getText(lang, "photo.not_enough_credits", {
      needed: photosCount,
      balance: user.credits,
    }));
    await sendBuyCreditsMenu(ctx, user);
    return;
  }

  // Списание кредитов и создание job
  await supabase
    .from("users")
    .update({ credits: user.credits - photosCount })
    .eq("id", user.id);

  // Генерация промпта через LLM с hint пресета
  const promptResult = await generatePrompt(preset.prompt_hint);
  const generatedPrompt = promptResult.prompt || preset.prompt_hint;

  await supabase
    .from("sessions")
    .update({ 
      user_input: preset.prompt_hint,
      prompt_final: generatedPrompt, 
      state: "processing" 
    })
    .eq("id", session.id);

  await supabase.from("jobs").insert({
    session_id: session.id,
    user_id: user.id,
    status: "queued",
    attempts: 0,
  });

  await ctx.reply(await getText(lang, "photo.generation_started"));
});
```

### 4.5 Text handler — обновить проверку состояния

```typescript
bot.on("text", async (ctx) => {
  // ... existing code ...

  // Обрабатывать текст только в состоянии wait_custom_style
  if (session.state !== "wait_custom_style") {
    if (session.state === "wait_style") {
      // Если пользователь пишет текст вместо нажатия кнопки — показать кнопки
      await sendStyleKeyboard(ctx, lang);
    }
    if (session.state === "wait_photo") {
      await ctx.reply(await getText(lang, "photo.need_photo"));
    }
    return;
  }

  // ... existing prompt generation logic ...
  
  // При ошибке валидации — вернуться к выбору стиля
  if (!promptResult.ok || promptResult.retry) {
    await supabase
      .from("sessions")
      .update({ state: "wait_style" })
      .eq("id", session.id);
    
    await ctx.reply(await getText(lang, "photo.invalid_style"));
    await sendStyleKeyboard(ctx, lang);
    return;
  }

  // ... continue with generation ...
});
```

---

## 5. Локализация

### Существующие ключи (уже добавлены в bot_texts)

| Ключ | RU | EN |
|------|----|----|
| `state.choose_style` | Выберите стиль, в котором будет создан стикер 🎨 | Choose the style in which the sticker will be created 🎨 |
| `state.new_description` | Пришлите новое описание для стикера ✍️ | Send a new description for the sticker ✍️ |

### Новый ключ (добавить)

| Ключ | RU | EN |
|------|----|----|
| `btn.custom_style` | ✍️ Свой стиль | ✍️ Custom style |

---

## 6. Чеклист реализации

- [ ] Создать таблицу `style_presets` в Supabase
- [ ] Добавить начальные данные (8 стилей)
- [ ] Добавить функцию `getStylePresets()` с кэшированием
- [ ] Добавить функцию `sendStyleKeyboard()`
- [ ] Обновить Photo handler — state = `wait_style`
- [ ] Добавить callback handler `style_*`
- [ ] Обновить Text handler — обрабатывать `wait_custom_style`
- [ ] При ошибке валидации — возврат к `wait_style`
- [ ] Добавить ключ локализации `btn.custom_style`
- [ ] Тестирование
