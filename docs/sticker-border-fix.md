# Исправление обрезки обводки стикера — Требования

## Проблема

При удалении фона (Pixian) и обрезке (Sharp trim) иногда теряется часть обводки/контура стикера. Алгоритм принимает тонкую обводку за фон и обрезает её.

---

## Решение

### 1. Уменьшить агрессивность trim

**Текущий код:**
```typescript
const stickerBuffer = await sharp(noBgBuffer)
  .trim()
  .resize(512, 512, { ... })
```

**Новый код:**
```typescript
const stickerBuffer = await sharp(noBgBuffer)
  .trim({ threshold: 10 }) // менее агрессивный trim
  .resize(512, 512, { ... })
```

`threshold` — чувствительность к прозрачности (по умолчанию ~10-50).  
Меньшее значение = менее агрессивная обрезка = сохраняется больше краёв.

---

### 2. Добавить padding перед Pixian

Добавить "воздух" вокруг изображения **перед** отправкой в Pixian.  
Это даёт алгоритму больше контекста по краям и он меньше обрезает контуры.

**Текущий код:**
```typescript
const generatedBuffer = Buffer.from(imageBase64, "base64");

// Сразу отправляем в Pixian
pixianForm.append("image", generatedBuffer, { ... });
```

**Новый код:**
```typescript
const generatedBuffer = Buffer.from(imageBase64, "base64");

// Добавляем padding перед Pixian
const paddedBuffer = await sharp(generatedBuffer)
  .extend({
    top: 30,
    bottom: 30,
    left: 30,
    right: 30,
    background: { r: 255, g: 255, b: 255, alpha: 1 }, // белый фон
  })
  .toBuffer();

// Отправляем padded версию в Pixian
pixianForm.append("image", paddedBuffer, { ... });
```

**Примечание:** Padding в 30px — стартовое значение, можно подстроить.

---

## Порядок операций (после изменений)

```
Gemini → generatedBuffer
    ↓
Sharp extend (padding +30px)
    ↓
Pixian (удаление фона)
    ↓
Sharp trim (threshold: 10) + resize 512x512
    ↓
Готовый стикер
```

---

## Технические изменения (worker.ts)

### Шаг 1: Padding перед Pixian

```typescript
await updateProgress(4);
const generatedBuffer = Buffer.from(imageBase64, "base64");

// Добавляем padding для лучшего удаления фона
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
// Remove background with Pixian
const pixianForm = new FormData();
pixianForm.append("image", paddedBuffer, {  // <-- paddedBuffer вместо generatedBuffer
  filename: "image.png",
  contentType: "image/png",
});
```

### Шаг 2: Threshold для trim

```typescript
await updateProgress(6);
// Trim transparent borders and fit into 512x512
const stickerBuffer = await sharp(noBgBuffer)
  .trim({ threshold: 10 })  // <-- добавлен threshold
  .resize(512, 512, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .webp()
  .toBuffer();
```

---

## Ожидаемый результат

| Метрика | До | После |
|---------|-----|-------|
| Обрезка обводки | Часто | Редко |
| Качество краёв | Рваные | Чёткие |

---

## Чеклист

- [ ] Добавить padding (extend) перед Pixian
- [ ] Добавить threshold для trim
- [ ] Тестирование на 5-10 стикерах
- [ ] Подобрать оптимальные значения (padding/threshold)
