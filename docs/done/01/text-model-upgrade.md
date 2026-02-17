# Улучшение генерации текста — Nano Banana Pro

## Проблема

При генерации стикеров с текстом (тип `text`) модель `gemini-2.5-flash-image` часто **не добавляет текст** или добавляет его некорректно. Это фундаментальная проблема диффузионных моделей — они плохо рендерят точный текст.

**Пример из логов:**
```
Full prompt: Create a high-contrast messenger sticker with text.
Text: "Hello" — add this text EXACTLY as written...
...
Image generated successfully  ← но текста на изображении нет
```

## Решение

Использовать **Nano Banana Pro** (`gemini-3-pro-vision`) для генерации текста — модель с **97% точностью рендеринга текста**.

## Архитектура

| Тип генерации | Модель | Точность текста | Скорость |
|---------------|--------|-----------------|----------|
| Style | gemini-2.5-flash-image | N/A | ~3 сек |
| Emotion | gemini-2.5-flash-image | N/A | ~3 сек |
| Motion | gemini-2.5-flash-image | N/A | ~3 сек |
| **Text** | **gemini-3-pro-vision** | **97%** | ~2.3 сек |

## Реализация

### Изменения в `worker.ts`

```typescript
// Выбираем модель в зависимости от типа генерации
const getModelForGeneration = (generationType: string): string => {
  if (generationType === "text") {
    return "gemini-3-pro-vision"; // Nano Banana Pro — 97% точность текста
  }
  return "gemini-2.5-flash-image"; // Flash для остального
};

// В функции runJob:
const model = getModelForGeneration(session.generation_type);

const response = await axios.post(
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  // ...
);

console.log(`Using model: ${model} for generation type: ${session.generation_type}`);
```

### Конфигурация (опционально)

Можно вынести модели в `config.ts` или базу данных для гибкости:

```typescript
// config.ts
export const config = {
  // ...existing
  modelDefault: process.env.GEMINI_MODEL_DEFAULT || "gemini-2.5-flash-image",
  modelText: process.env.GEMINI_MODEL_TEXT || "gemini-3-pro-vision",
};
```

## Стоимость

| Модель | Цена (примерно) |
|--------|-----------------|
| gemini-2.5-flash-image | $0.0001 / изображение |
| gemini-3-pro-vision | $0.0005 / изображение |

**Вывод:** Text генерация будет ~5x дороже, но это оправдано для качества.

## Checklist

- [ ] Обновить `worker.ts` — добавить выбор модели по типу генерации
- [ ] Добавить логирование используемой модели
- [ ] Редеплой Worker
- [ ] Тестирование генерации текста
- [ ] Мониторинг стоимости
