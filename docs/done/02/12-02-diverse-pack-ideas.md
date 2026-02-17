# Разнообразные идеи для стикерпака — улучшение промпта

**Дата:** 2026-02-12
**Статус:** Требования

---

## Проблема

Идеи для стикерпака генерируются однообразно:
- Одни и те же эмоции (смех, злость, грусть, шок)
- Одни и те же текстовые варианты ("ОК", "Привет", "Спасибо")
- Одни и те же сцены (кофе, вечеринка)
- Каждый запрос даёт практически идентичный набор

### Причины

1. **Фиксированная структура категорий** — промпт жёстко задаёт "2-3 emotion, 1-2 action, 2-3 text/meme, 1-2 scene". GPT каждый раз идёт по шаблону.
2. **Нет рандомизации** — при каждом вызове одинаковый system prompt → модель выдаёт одинаковый результат.
3. **Фиксированные примеры** — `"ОК", "Нет", "Жиза", "Привет!"` в промпте → модель крутится вокруг этих слов.
4. **Нет контекста о пользователе** — не передаётся зачем стикеры, что могло бы разнообразить тематику.

---

## Решение

### 1. Рандомизированные темы (seed-категории)

Вместо фиксированных категорий — при каждом вызове случайно выбирать 4 темы из большого пула:

```typescript
const themePool = [
  "everyday reactions",
  "work & study life",
  "food & drinks",
  "relationships & love",
  "gaming & internet culture",
  "celebrations & holidays",
  "passive-aggressive responses",
  "motivational & inspiring",
  "sarcastic comebacks",
  "party & nightlife",
  "morning & evening routine",
  "pet owner life",
  "introvert vs extrovert",
  "sports & fitness",
  "weather & seasons",
  "shopping & money",
  "travel & vacation",
  "procrastination & deadlines",
  "self-care & relaxation",
  "friendship & loyalty",
  "awkward situations",
  "nostalgia & childhood",
  "compliments & flirting",
  "apologies & forgiveness",
];
const selectedThemes = shuffle(themePool).slice(0, 4);
```

В промпт: `"Create ideas that fit these themes: ${selectedThemes.join(', ')}. Distribute ideas across these themes — at least 1 per theme."`

### 2. Повышенная температура

Явно задать `temperature: 1.2` в вызове GPT-4o-mini для большей креативности. Сейчас используется дефолт (~1.0).

### 3. Убрать фиксированные примеры текстов

**Было:**
```
Text should be casual/memey: "ОК", "Нет", "Жиза", "Привет!", "Ору", "Спасибо"
```

**Стало:**
```
Text should be creative and unexpected — avoid cliché like "OK", "Hello", "Thanks".
Think of funny, niche, or culturally relevant phrases that match the theme.
Examples of GOOD text: inside jokes, meme references, emotional outbursts, sarcastic comments.
```

### 4. Рандомизированная тональность пака

Случайно выбирать тональность при каждом вызове:

```typescript
const tones = [
  "wholesome & cute",
  "sarcastic & edgy",
  "meme energy",
  "chill & minimal",
  "chaotic & absurd",
  "dramatic & expressive",
];
const selectedTone = tones[Math.floor(Math.random() * tones.length)];
```

В промпт: `"Pack vibe: ${selectedTone}. All ideas should match this mood."`

### 5. Расширенные категории + уникальность

**Было:** `emotion, action, scene, text_meme, holiday, outfit` (6 категорий)

**Стало:** добавить:
```
reaction, greeting, farewell, approval, disapproval, question, 
celebration, flirt, sarcasm, passive_aggressive, motivation, 
procrastination, surprise, confusion, tired, proud
```

Правило: `"Each idea MUST be from a DIFFERENT category. No two ideas should have the same category."`

---

## Изменения в коде

**Файл:** `src/index.ts`, функция `generatePackIdeas` (~строка 4238)

1. Добавить массив `themePool` и функцию `shuffle`
2. Добавить массив `tones`
3. При каждом вызове — random `selectedThemes` (4 шт) и `selectedTone` (1 шт)
4. Обновить `systemPrompt`:
   - Заменить фиксированные категории на `selectedThemes`
   - Заменить примеры текстов на "be creative, avoid cliché"
   - Добавить тональность `selectedTone`
   - Добавить правило уникальности категорий
5. Добавить `temperature: 1.2` в вызов GPT-4o-mini

---

## Пример обновлённого промпта

```
You are a professional sticker pack designer. Analyze the sticker image and create 8 unique ideas.

Style: ${styleName} (${styleHint})
Pack vibe: ${selectedTone}
Themes to explore: ${selectedThemes.join(', ')}

Already existing stickers (DO NOT repeat):
${existingList}

CRITICAL — Preserving character appearance:
- Analyze outfit, accessories, hairstyle in the image
- EVERY promptModification must describe the same outfit
- Do NOT change clothes/hat/glasses/hairstyle

Rules:
1. Each idea MUST be from a DIFFERENT category — no duplicates
2. Distribute ideas across the given themes (at least 1 per theme)
3. Match the pack vibe: ${selectedTone}
4. For text ideas: be creative and unexpected — avoid cliché.
   Think of funny, niche, culturally relevant phrases.
5. promptModification in English, detailed for image generation
6. Keep the same character/subject — same face, body, outfit
7. titleRu/descriptionRu in Russian, titleEn/descriptionEn in English

Categories: emotion, reaction, action, scene, text_meme, greeting, farewell,
sarcasm, motivation, celebration, question, flirt, tired, proud, confusion, surprise

Return JSON array of exactly 8 ideas...
```

---

## Ожидаемый результат

| Метрика | Было | Станет |
|---------|------|--------|
| Уникальность между запросами | ~30% (одинаковые эмоции) | ~80% (разные темы/тональность) |
| Разнообразие текстов | "ОК", "Привет", "Спасибо" | Контекстные фразы по теме |
| Категории | 6 фиксированных | 16+, уникальные в каждом наборе |
| Повторяемость при повторном клике | Высокая | Низкая (рандом тем + temperature) |

---

## Чеклист

- [ ] Добавить `themePool` и `shuffle` функцию
- [ ] Добавить `tones` массив
- [ ] Обновить `systemPrompt` в `generatePackIdeas`
- [ ] Убрать фиксированные примеры текстов
- [ ] Добавить `temperature: 1.2` в GPT вызов
- [ ] Добавить правило уникальности категорий
- [ ] Расширить список категорий
- [ ] Деплой на test
- [ ] Тест: 3 раза нажать "Идеи для пака" — проверить разнообразие
- [ ] Деплой на prod
