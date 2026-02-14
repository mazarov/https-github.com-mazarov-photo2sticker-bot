# Улучшения карусели идей для стикеров

## 1. Предвыбранный стиль из базы

### Новое поле в `style_presets_v2`
- `is_default` (boolean, default false) — один стиль помечен как дефолтный для новых юзеров

### Новое поле в `users`
- `last_style_id` (text, nullable) — последний использованный стиль

### Логика выбора стиля при показе идей
1. Если у юзера есть `last_style_id` и этот стиль `is_active` → использовать его
2. Иначе → взять стиль с `is_default = true`
3. Если нет дефолтного → случайный из активных (fallback)

### Сохранение
При каждой генерации через `asst_idea_gen` — обновлять `users.last_style_id = state.styleId`.

### SQL миграция
```sql
ALTER TABLE style_presets_v2 ADD COLUMN IF NOT EXISTS is_default boolean DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_style_id text;

-- Установить Телеграм как дефолтный
UPDATE style_presets_v2 SET is_default = true WHERE id = 'cartoon_telegram';
```

### Изменения в коде (`src/index.ts`)

**Функция выбора стиля** (заменяет `activePresets[random]`):
```typescript
async function pickStyleForIdeas(userId: string): Promise<StylePresetV2> {
  const user = await getUser(userId); // or pass user
  const allPresets = await getStylePresetsV2();
  const active = allPresets.filter(p => p.is_active);
  
  // 1. Последний стиль юзера
  if (user.last_style_id) {
    const last = active.find(p => p.id === user.last_style_id);
    if (last) return last;
  }
  
  // 2. Дефолтный стиль
  const def = active.find(p => p.is_default);
  if (def) return def;
  
  // 3. Случайный fallback
  return active[Math.floor(Math.random() * active.length)];
}
```

**Где вызывать:**
- `startAssistantDialog` (когда `lastPhoto` есть) — вместо `randomStyle`
- `assistant_wait_photo` handler — вместо `randomStyle`

**Сохранение `last_style_id`:**
- В `asst_idea_gen` handler после генерации:
  ```typescript
  await supabase.from("users").update({ last_style_id: state.styleId }).eq("id", user.id);
  ```

---

## 2. Перегенерация идей на последней карточке

### Текущее поведение
`asst_idea_next` использует `% state.ideas.length` — циклический переход на первую идею.

### Новое поведение
Когда `nextIndex === 0` (все идеи просмотрены):
1. Показать загрузочное сообщение
2. Вызвать `generateStickerIdeasFromPhoto` с текущим стилем
3. Сохранить новые идеи в `sticker_ideas_state`
4. Показать первую карточку из новых

### Изменения в `asst_idea_next` handler
```typescript
const nextIndex = (parseInt(ctx.match[1], 10) + 1) % state.ideas.length;

if (nextIndex === 0) {
  // Все идеи просмотрены — перегенерировать
  try { await ctx.deleteMessage(); } catch {}
  const loadingMsg = await ctx.reply(
    lang === "ru" ? "🔄 Генерирую новые идеи..." : "🔄 Generating new ideas..."
  );

  let ideas: StickerIdea[];
  try {
    ideas = await generateStickerIdeasFromPhoto({
      photoFileId: session.current_photo_file_id,
      stylePresetId: state.styleId,
      lang,
      holidayId: state.holidayId || null, // сохранить праздник если был
    });
  } catch {
    ideas = getDefaultIdeas(lang);
  }

  const newState = { ...state, ideaIndex: 0, ideas };
  await supabase.from("sessions").update({
    sticker_ideas_state: newState, is_active: true,
  }).eq("id", session.id);

  try { await ctx.deleteMessage(loadingMsg.message_id); } catch {}

  const preset = await getStylePresetV2ById(state.styleId);
  if (!preset) return;
  await showStickerIdeaCard(ctx, { idea: ideas[0], ideaIndex: 0, totalIdeas: ideas.length, style: preset, lang });
  return;
}

// Обычный переход к следующей
// ... existing code ...
```

---

## 3. Праздничные темы (универсальный механизм)

### Новая таблица `holiday_themes`

```sql
CREATE TABLE IF NOT EXISTS holiday_themes (
  id text PRIMARY KEY,
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  prompt_modifier text NOT NULL,
  is_active boolean DEFAULT false,
  sort_order int DEFAULT 0
);

INSERT INTO holiday_themes (id, emoji, name_ru, name_en, prompt_modifier, is_active, sort_order) VALUES
  ('valentines', '💘', 'Валентинка', 'Valentine', 
   'All ideas MUST be Valentine''s Day themed — romantic gestures, love confessions, heart symbols, couple moments, cupid arrows, love letters, blushing. Make ideas sweet, flirty and festive for February 14th.',
   true, 1),
  ('march_8', '🌷', 'С 8 марта', 'Women''s Day',
   'All ideas MUST be International Women''s Day themed — flowers, spring, beauty, feminine power, gifts, celebration of women. Warm, elegant, festive mood.',
   false, 2),
  ('new_year', '🎄', 'Новый год', 'New Year',
   'All ideas MUST be New Year / Christmas themed — Santa hat, snowflakes, gifts, champagne, fireworks, cozy winter, holiday decorations. Festive and joyful mood.',
   false, 3),
  ('halloween', '🎃', 'Хэллоуин', 'Halloween',
   'All ideas MUST be Halloween themed — costumes, pumpkins, spooky fun, trick or treat, witches, ghosts, bats. Fun and playful spooky mood, not scary.',
   false, 4)
ON CONFLICT (id) DO UPDATE SET
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_modifier = EXCLUDED.prompt_modifier,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;
```

### UI — кнопка в карточке идеи

Когда есть активный `holiday_theme` (берём первый по `sort_order`):

```
🎨 Сгенерить (1💎)
💘 Валентинка     ➡️ Другая
🔄 Другой стиль
✏️ Своя идея
⏭️ Пропустить
```

Callback: `asst_idea_holiday:{holidayId}:{ideaIdx}`

Если идеи УЖЕ праздничные (`state.holidayId === holidayId`) — кнопка НЕ показывается (чтобы не путать).

### Обработчик `asst_idea_holiday`

```typescript
bot.action(/^asst_idea_holiday:([^:]+):(\d+)$/, async (ctx) => {
  // 1. Получить holiday_theme из БД
  // 2. Показать загрузку
  // 3. Вызвать generateStickerIdeasFromPhoto с holidayModifier
  // 4. Сохранить в sticker_ideas_state с holidayId
  // 5. Показать первую карточку
});
```

### Изменения в `generateStickerIdeasFromPhoto`

Добавить опциональный параметр `holidayModifier`:
```typescript
async function generateStickerIdeasFromPhoto(opts: {
  photoFileId: string;
  stylePresetId: string;
  lang: string;
  holidayModifier?: string | null; // NEW
}): Promise<StickerIdea[]>
```

Если `holidayModifier` передан — добавить его в системный промпт LLM:
```
...suggest 8 unique sticker ideas in the style: ${styleName}.

IMPORTANT THEME: ${holidayModifier}
...
```

### Изменения в `sticker_ideas_state`

Добавить `holidayId` в структуру:
```typescript
{
  styleId: string;
  ideaIndex: number;
  ideas: StickerIdea[];
  holidayId?: string | null; // NEW — если идеи праздничные
}
```

### Получение активного праздника

```typescript
async function getActiveHoliday(): Promise<HolidayTheme | null> {
  const { data } = await supabase
    .from("holiday_themes")
    .select("*")
    .eq("is_active", true)
    .order("sort_order")
    .limit(1)
    .maybeSingle();
  return data;
}
```

Вызывать в `showStickerIdeaCard` для решения показывать ли праздничную кнопку.

---

## Порядок реализации

1. **SQL миграция 072**: `is_default` в styles, `last_style_id` в users, таблица `holiday_themes`
2. **pickStyleForIdeas()**: функция выбора стиля + сохранение last_style_id
3. **asst_idea_next**: перегенерация на последней идее
4. **holiday_themes**: getActiveHoliday, кнопка в карточке, handler, holidayModifier в generateStickerIdeasFromPhoto
5. **Тест**: проверить все три фичи
6. **Deploy на прод**
