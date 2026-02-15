# Улучшение качества стикеров — композиция и удаление фона

## Проблема

Пользователи получают стикеры с обрезанными частями тела:
- Руки, локти, пальцы срезаны краем изображения
- Плечи, шея "съедены" при удалении фона
- Заливка цветом теряется на краях

## Причины

### 1. rembg путает кожу с фоном

Gemini генерирует фон "flat uniform single color" — но **не указан конкретный цвет**.
Модель часто выбирает пастельные/бежевые/серые тона, которые близки к телесному цвету.

rembg (U2-Net, self-hosted) — бесплатная модель, не справляется с низким контрастом:
- Считает часть кожи фоном → удаляет куски плеч, шеи, рук
- Контур получается "рваный" — заливка теряется

### 2. Персонаж касается краёв изображения

Промпт содержит инструкцию "generous padding on all sides", но Gemini не всегда её соблюдает.
Когда руки/локти упираются в край → rembg не может определить замкнутый контур → "протекает" и удаляет часть тела.

### 3. prompt_generator выкидывает инструкции

Агент `prompt_generator` иногда опускает блок CRITICAL из system prompt при генерации финального промпта.

## Решение

### Composition suffix в `startGeneration`

Добавляем текст в конец **каждого** `promptFinal` перед сохранением в сессию.
Одно место в коде → покрывает все типы генерации (стиль, эмоция, движение, текст, идеи, ассистент).

**Suffix (добавляется в конец промпта):**

```
CRITICAL COMPOSITION AND BACKGROUND RULES:
1. Background MUST be flat uniform BRIGHT GREEN (#00FF00). This exact color is required for automated background removal. No other background colors allowed.
2. The COMPLETE character (including all limbs, hands, fingers, elbows, hair) must be fully visible with nothing cropped by image edges.
3. Leave at least 15% empty space on EVERY side of the character.
4. If the pose has extended arms or wide gestures — zoom out to include them fully. Better to make the character slightly smaller than to crop any body part.
5. Do NOT add any border, outline, stroke, or contour around the character. Clean raw edges only.
```

### Почему suffix, а не правка промпт-шаблонов в Supabase

| Подход | Покрытие | Надёжность |
|---|---|---|
| Правка `prompt_generator` агента | Только стили | LLM может "забыть" инструкцию |
| Правка `prompt_templates` (emotion/motion) | Только эмоции/движения | Надёжно, но 2 отдельных места |
| Suffix в `startGeneration` | **Все** генерации | 100% гарантия, одно место |

### Что меняется для пользователя

| До | После |
|---|---|
| Фон — случайный цвет (часто светлый) | Фон — ярко-зелёный (#00FF00) хромакей |
| Руки/плечи могут быть обрезаны | Персонаж целиком с отступами 15% |
| rembg путает кожу с фоном | rembg чётко различает зелёный фон |
| Заливка "съедается" на краях | Контур замкнут, заливка сохраняется |

## Файлы

- `src/index.ts` — функция `startGeneration` — добавление suffix к `promptFinal`

## Тестирование

1. Сгенерировать стикер в стиле "Телеграм" — проверить что фон зелёный, руки не обрезаны
2. Сменить эмоцию — проверить что плечи/шея целые
3. Сменить движение (wave, thumbs up) — проверить что руки полностью видны
4. Проверить через ассистента — тоже должен быть зелёный фон

## Риски

- Gemini может не всегда следовать инструкции #00FF00 → но даже приблизительно зелёный фон лучше чем бежевый
- Если персонаж одет в зелёное → rembg может удалить часть одежды → маловероятно для стикеров, но возможно
- Suffix увеличивает промпт на ~50 токенов → незначительно (лимит Gemini ~1M токенов)
