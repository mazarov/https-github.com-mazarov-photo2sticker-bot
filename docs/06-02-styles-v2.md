# Стили v2: Группы + Подстили

## Цель
Улучшить конверсию выбора стилей через иерархическую структуру: пользователь сначала выбирает категорию (группу), затем конкретный подстиль.

## Ограничения
- Feature flag: сначала только для тестового пользователя (telegram_id: 42269230)
- Обратная совместимость: текущие стили продолжают работать
- Без влияния на worker: генерация получает финальный `style_id`

## Изоляция (ВАЖНО!)

| Компонент | Старые пользователи | Тестовый пользователь (v2) |
|-----------|---------------------|---------------------------|
| Таблица стилей | `style_presets` | `style_presets_v2` (новая!) |
| Таблица групп | — | `style_groups` (новая!) |
| UI | Плоский список | Группы → подстили |
| Код | `sendStyleKeyboard()` | `sendStyleGroupsKeyboard()` |

**`style_presets` НЕ ИЗМЕНЯЕТСЯ!**

---

## 1. Структура групп

| # | ID | Emoji | Название RU | Название EN | Подстилей |
|---|-----|-------|-------------|-------------|-----------|
| 1 | `anime` | 🎌 | Аниме | Anime | 5 |
| 2 | `meme` | 😂 | Мемы | Memes | 4 |
| 3 | `cute` | 🥰 | Милый | Cute | 4 |
| 4 | `love` | 💕 | Романтика | Romance | 4 |
| 5 | `cartoon` | 🎨 | Мультфильм | Cartoon | 4 |
| 6 | `game` | 🎮 | Игровой | Gaming | 3 |
| 7 | `drawn` | ✏️ | Рисунок | Drawn | 3 |
| 8 | `manhwa` | 📚 | Манхва | Manhwa | 3 |
| 9 | `tv` | 📺 | Сериалы | TV Series | 5 |
| 10 | `russian` | 🇷🇺 | Русский стиль | Russian | 7 |

**Итого: 10 групп, 42 подстиля**

---

## 2. Подстили по группам

### 🎌 anime

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `anime_classic` | 🎯 | Классический | Classic | Japanese anime style, clean precise linework, cel-shading, large expressive eyes with detailed reflections, stylized flowing hair |
| `anime_dark` | 🌑 | Тёмный | Dark | Dark anime aesthetic, dramatic shadows, intense brooding eyes, muted colors with red/purple accents, seinen manga style |
| `anime_shonen` | ⚔️ | Сёнен | Shonen | Shonen anime style, dynamic action pose, spiky hair, determined fierce expression, vibrant saturated colors |
| `anime_romance` | 💗 | Романтик | Romance | Shoujo anime style, soft pastel colors, sparkles and bubbles, dreamy starry eyes, delicate features, bishoujo aesthetic |
| `anime_chibi` | 🍡 | Чиби | Chibi | Super-deformed chibi anime, oversized head 3x body, tiny limbs, kawaii expression, simplified features |

### 😂 meme

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `meme_classic` | 😤 | Классика | Classic | Internet meme style, rage comic aesthetic, bold black outlines, extremely exaggerated facial expression, simple shapes |
| `meme_pepe` | 🐸 | Пепе | Pepe | Pepe the frog meme style, green character, simple round shapes, expressive sad or smug face, iconic meme aesthetic |
| `meme_modern` | 🔥 | Современный | Modern | Modern zoomer meme style, ironic aesthetic, chaotic energy, distorted proportions, TikTok meme vibe |
| `meme_reaction` | 😱 | Реакция | Reaction | Reaction meme face, extremely over-the-top expression, screenshot aesthetic, viral meme energy |

### 🥰 cute

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `cute_kawaii` | ✨ | Каваий | Kawaii | Japanese kawaii style, pastel pink and blue colors, round soft shapes, sparkles, blush cheeks, heart eyes |
| `cute_cat` | 🐱 | Котик | Cat | Cute cat character style, cat ears added, whiskers, playful feline expression, fluffy and adorable |
| `cute_animal` | 🐾 | Зверушка | Animal | Cute anthropomorphic animal, round fluffy body, oversized sparkly eyes, soft fur texture, adorable pose |
| `cute_plush` | 🧸 | Плюшевый | Plush | Plush toy aesthetic, soft fabric texture, stitched details, huggable round shape, button eyes |

### 💕 love

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `love_soft` | 🌸 | Нежный | Soft | Soft romantic style, watercolor effect, floating hearts, warm pink tones, dreamy gentle expression |
| `love_couple` | 👫 | Парочки | Couple | Romantic couple style, two characters close together, loving gaze, holding hands or hugging pose |
| `love_heart` | 💖 | С сердечками | Hearts | Romantic style with heart decorations, heart-shaped elements, love symbols, pink and red palette |
| `love_passion` | 🔥 | Страстный | Passionate | Passionate romantic style, intense loving gaze, dramatic lighting, deep red and warm tones |

### 🎨 cartoon

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `cartoon_american` | 🇺🇸 | Американский | American | American cartoon style, bold black outlines, flat bright colors, exaggerated proportions, expressive |
| `cartoon_retro` | 📺 | Ретро | Retro | Retro Soviet cartoon style, warm nostalgic colors, hand-painted aesthetic, classic animation look |
| `cartoon_modern` | 💎 | Современный | Modern | Modern vector cartoon, clean geometric shapes, trendy flat design, minimalist features, stylish |
| `cartoon_3d` | 🎬 | 3D стиль | 3D Style | 3D animated movie style, soft subsurface lighting, Pixar-like render, smooth surfaces, cinematic |

### 🎮 game

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `game_pixel` | 👾 | Пиксель | Pixel | 8-bit pixel art style, retro game aesthetic, limited color palette, blocky pixelated look, nostalgic |
| `game_rpg` | ⚔️ | RPG | RPG | Fantasy RPG character style, epic hero pose, magical effects, detailed armor or costume, game art |
| `game_mobile` | 📱 | Мобильный | Mobile | Mobile game art style, bright saturated colors, cute proportions, casual game aesthetic |

### ✏️ drawn

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `drawn_sketch` | ✏️ | Скетч | Sketch | Pencil sketch style, hand-drawn rough lines, artistic strokes, unfinished aesthetic, graphite look |
| `drawn_watercolor` | 💧 | Акварель | Watercolor | Watercolor painting style, soft wet edges, color bleeding, artistic brush strokes, dreamy |
| `drawn_ink` | 🖤 | Тушь | Ink | Black ink drawing style, bold confident strokes, high contrast, artistic linework, monochrome |

### 📚 manhwa

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `manhwa_classic` | 📖 | Классика | Classic | Korean manhwa webtoon style, sharp defined features, detailed eyes, clean digital art, vertical scroll aesthetic |
| `manhwa_romance` | 💕 | Романтик | Romance | Romance manhwa style, beautiful detailed characters, soft coloring, emotional expression, webtoon romance |
| `manhwa_action` | 💥 | Экшн | Action | Action manhwa style, dynamic poses, intense expression, dramatic angles, powerful energy effects |

### 📺 tv

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `tv_american` | 🇺🇸 | Американский мультсериал | American Cartoon | American TV cartoon style like Simpsons or Family Guy, yellow skin tone optional, bold outlines, flat colors, overbite, simplified features |
| `tv_adult` | 🔞 | Взрослая анимация | Adult Animation | Adult animated series style like South Park or Rick and Morty, crude simple shapes, satirical exaggerated features, bold flat colors |
| `tv_kids` | 👶 | Детский мультик | Kids Cartoon | Children's cartoon style like Gravity Falls or Adventure Time, round friendly shapes, bright colors, cute expressive characters |
| `tv_disney` | 🏰 | Дисней/Пиксар | Disney/Pixar | Disney or Pixar animation style, 3D rendered look, expressive big eyes, soft lighting, polished animated movie aesthetic |
| `tv_hellish` | 😈 | Адская тема | Hellish Theme | Hazbin Hotel or Helluva Boss style, demon aesthetic, sharp angles, red and black palette, edgy cartoon look |

### 🇷🇺 russian

| ID | Emoji | Название RU | Название EN | prompt_hint |
|----|-------|-------------|-------------|-------------|
| `ru_90s` | 📼 | 90-е | 90s Style | Russian 90s aesthetic, VHS quality, grainy texture, post-Soviet style, tracksuit gopnik vibe, nostalgic faded colors |
| `ru_love_is` | 💑 | Любовь это... | Love Is... | Love Is comic strip style, simple cute couple, minimal lines, sweet romantic, Kim Casali inspired, heart-shaped elements |
| `ru_soviet_cartoon` | 🎬 | Советский мультик | Soviet Cartoon | Soviet animation style like Nu Pogodi or Cheburashka, hand-painted aesthetic, warm nostalgic colors, classic USSR cartoon |
| `ru_ussr_aesthetic` | ☭ | Эстетика СССР | USSR Aesthetic | Soviet propaganda poster style, constructivist aesthetic, bold red and gold colors, heroic worker pose, socialist realism, vintage USSR design |
| `ru_bogatyr` | ⚔️ | Богатырь | Russian Hero | Russian bogatyr hero style, Tri Bogatyrya animation aesthetic, Slavic folklore, epic warrior, traditional Russian elements |
| `ru_gopnik` | 🧢 | Пацан | Gopnik | Gopnik style, squatting pose, tracksuit Adidas aesthetic, Slavic meme culture, cigarette and semechki optional |
| `ru_criminal` | 🎰 | Бригада/90е кино | 90s Crime | Russian 90s crime movie aesthetic, Brigada or Brat style, dark gritty, leather jacket, serious intense expression |

---

## 3. Миграция БД

### 3.1 Таблица `style_groups`

```sql
CREATE TABLE IF NOT EXISTS style_groups (
  id text PRIMARY KEY,
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS style_groups_active_idx 
ON style_groups (is_active, sort_order);
```

### 3.2 Новая таблица `style_presets_v2` (полная изоляция)

```sql
-- Отдельная таблица для подстилей v2 - НЕ трогаем style_presets!
CREATE TABLE IF NOT EXISTS style_presets_v2 (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES style_groups(id),
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  prompt_hint text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS style_presets_v2_idx 
ON style_presets_v2 (group_id, is_active, sort_order);
```

**Важно:** Существующая таблица `style_presets` НЕ изменяется. Старый UI продолжает работать как раньше.

### 3.3 Аналитика

```sql
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS selected_style_group text;
```

---

## 4. Feature Flag

### 4.1 Конфиг

```typescript
// src/config.ts
export const STYLES_V2_ENABLED_USERS: number[] = [
  42269230,  // тестовый пользователь
];
```

### 4.2 Хелпер

```typescript
function useStylesV2(telegramId: number): boolean {
  return config.stylesV2EnabledUsers?.includes(telegramId) ?? false;
}
```

---

## 5. UI Flow

### 5.1 Выбор группы (первый экран)

**Сообщение:** "Выбери категорию стиля:"

**Кнопки (2 колонки):**
```
[🎌 Аниме] [😂 Мемы]
[🥰 Милый] [💕 Романтика]
[🎨 Мультфильм] [🎮 Игровой]
[✏️ Рисунок] [📚 Манхва]
[📺 Сериалы] [🇷🇺 Русский]
[✍️ Свой стиль]
```

**Callback группы:** `style_group:{group_id}`
**Callback свой стиль:** `style_custom_v2`

### 5.2 Выбор подстиля (второй экран)

**Сообщение:** "🎌 Аниме — выбери стиль:"

**Кнопки (1 колонка):**
```
[🎯 Классический]
[🌑 Тёмный]
[⚔️ Сёнен]
[💗 Романтик]
[🍡 Чиби]
[⬅️ Назад]
```

**Callback подстиля:** `style_v2:{substyle_id}`
**Callback назад:** `style_groups_back`

### 5.3 Свой стиль (custom)

**Флоу аналогичен custom эмоциям:**

1. Пользователь нажимает "✍️ Свой стиль"
2. Бот: "Опиши желаемый стиль (например: в стиле комиксов Marvel, как персонаж Наруто, в стиле советского плаката):"
3. Пользователь вводит текст
4. Генерация с `style_id = 'custom'` и `custom_style_prompt = введённый текст`

**Session state:** `wait_custom_style_v2`

**Callback:** `style_custom_v2` → устанавливает state, просит ввести текст

---

## 6. Код изменения

### 6.1 Новые хендлеры

```typescript
// Показать группы
bot.action("show_style_groups", async (ctx) => { ... });

// Выбрана группа → показать подстили
bot.action(/^style_group:(.+)$/, async (ctx) => { ... });

// Выбран подстиль → генерация
bot.action(/^style_v2:(.+)$/, async (ctx) => { ... });

// Назад к группам
bot.action("style_groups_back", async (ctx) => { ... });

// Свой стиль (кнопка) → запрос текста
bot.action("style_custom_v2", async (ctx) => {
  // Устанавливаем state = wait_custom_style_v2
  // Отправляем сообщение "Опиши желаемый стиль:"
});

// Обработка текстового ввода для custom стиля
// В message handler проверяем session.state === 'wait_custom_style_v2'
// Сохраняем текст в session.custom_style_prompt
// Запускаем генерацию
```

### 6.2 Изменить точку входа

```typescript
// В photo handler, после загрузки фото:
if (useStylesV2(telegramId)) {
  // Новый UI: группы → подстили из style_presets_v2
  await sendStyleGroupsKeyboard(ctx, user, session);
} else {
  // Старый UI: плоский список из style_presets (без изменений!)
  await sendStyleKeyboard(ctx, user, session);
}
```

### 6.3 Изоляция данных

```typescript
// Для v2 пользователей:
// - Группы из style_groups
// - Подстили из style_presets_v2

// Для обычных пользователей:
// - Стили из style_presets (как сейчас, без изменений)

// Worker получает style_id и работает одинаково для обоих случаев
// prompt_hint берётся из соответствующей таблицы
```

---

## 7. Тексты

```typescript
"style.select_group": {
  ru: "Выбери категорию стиля:",
  en: "Choose style category:"
},
"style.select_substyle": {
  ru: "{emoji} {name} — выбери стиль:",
  en: "{emoji} {name} — choose style:"
},
"style.custom_prompt": {
  ru: "✍️ Опиши желаемый стиль:\n\nНапример:\n• в стиле комиксов Marvel\n• как персонаж Наруто\n• в стиле советского плаката\n• пиксельный ретро-стиль",
  en: "✍️ Describe the style you want:\n\nExamples:\n• Marvel comics style\n• like a Naruto character\n• Soviet poster style\n• pixel retro style"
},
"btn.custom_style": {
  ru: "✍️ Свой стиль",
  en: "✍️ Custom style"
},
"btn.back_to_groups": {
  ru: "⬅️ Назад",
  en: "⬅️ Back"
}
```

---

## 8. Аналитика

```sql
-- Популярность групп
SELECT selected_style_group, COUNT(*) 
FROM sessions 
WHERE selected_style_group IS NOT NULL 
GROUP BY selected_style_group 
ORDER BY count DESC;

-- Конверсия группа → подстиль
SELECT 
  selected_style_group,
  COUNT(*) FILTER (WHERE selected_style_id IS NOT NULL) as completed,
  COUNT(*) as started,
  ROUND(100.0 * COUNT(*) FILTER (WHERE selected_style_id IS NOT NULL) / COUNT(*), 1) as conversion
FROM sessions
WHERE selected_style_group IS NOT NULL
GROUP BY selected_style_group;
```

---

## 9. Checklist

### Фаза 1: БД
- [x] Миграция `036_style_groups.sql` — создать `style_groups`
- [x] Миграция `036_style_groups.sql` — создать `style_presets_v2` (отдельная таблица!)
- [x] Вставить группы в `style_groups`
- [x] Вставить подстили в `style_presets_v2`
- [x] **НЕ трогать** существующую `style_presets`

### Фаза 2: Код
- [x] Feature flag в config
- [x] Хелпер `useStylesV2()`
- [x] Функция `sendStyleGroupsKeyboard()`
- [x] Функция `sendSubstylesKeyboard()`
- [x] Хендлер `style_group:*`
- [x] Хендлер `style_v2:*`
- [x] Хендлер `style_groups_back`
- [x] Хендлер `style_custom_v2` (кнопка → запрос текста)
- [x] Обработка текста для custom стиля (state: `wait_custom_style_v2`)
- [x] Изменить photo handler

### Фаза 3: Тест
- [ ] Тест на своём аккаунте
- [ ] Проверить все группы
- [ ] Проверить генерацию для каждого подстиля
- [ ] Проверить кнопку "Назад"
- [ ] Проверить "Свой стиль" (custom)

### Фаза 4: Раскатка
- [ ] Добавить еще тестовых юзеров
- [ ] Собрать фидбек
- [ ] Включить для всех (убрать feature flag)

---

## 10. Риски

| Подстиль | Риск | Митигация |
|----------|------|-----------|
| `tv_*` | Авторские права | Используем "в стиле", без персонажей |
| `ru_love_is` | Trademark | Делаем "в стиле", не копируем |
| `ru_gopnik` | Может оскорбить | Позиционируем как мем-культуру |
| `anime_*` | Низкий | Общий стиль без IP |

---

## Источник данных

Анализ основан на Wordstat запросах "стикеры тг" за период 05.01.2026 — 05.02.2026 (файл `wordstat_top_queries.csv`).

Топ-запросы по категориям:
- Аниме: 8,460+
- Мемы: 11,442+
- Милые/котики: 7,000+
- Любовь/романтика: 15,000+
- TV/сериалы: 5,000+
- Русская культура: 2,500+
