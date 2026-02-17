# Chroma key — очистка зелёных артефактов после rembg

**Дата:** 2026-02-12
**Статус:** Спецификация
**Связано:** docs/bg-removal-fix.md (шаги 1 и 3 уже сделаны)

---

## Проблема

После rembg (даже с u2net) в сложных областях остаются зелёные артефакты:
- За шарами, между рукой и фоном
- На границах объектов с anti-aliasing
- В полупрозрачных краях маски

Gemini рисует `#00FF00` фон, rembg его в основном срезает, но не везде. Нужен финальный проход: пиксели близкие к зелёному → прозрачность.

---

## Решение

Добавить **post-processing chroma key** сразу после rembg, до `trim`/`resize`:

```
generatedBuffer → rembg → noBgBuffer → CHROMA KEY (новый шаг) → trim → resize → sticker
```

### Алгоритм

Для каждого пикселя (r, g, b, a):
- Вычислить «расстояние» до чисто зелёного (0, 255, 0)
- Если расстояние < порог → установить alpha = 0 (полная прозрачность)

**Формула расстояния** (упрощённая, без sqrt для скорости):
```ts
// Пиксель «зелёный», если зелёный канал доминирует и красный/синий малы
const isGreen = (r: number, g: number, b: number) => {
  const greenScore = g;
  const otherScore = Math.max(r, b);
  return greenScore > 200 && otherScore < 80;
};
```

Или по евклидову расстоянию:
```ts
const dist = (r - 0) ** 2 + (g - 255) ** 2 + (b - 0) ** 2;
if (dist < THRESHOLD_SQ) alpha = 0;  // THRESHOLD_SQ ≈ 3000–5000
```

### Параметры

| Параметр | Значение | Описание |
|----------|----------|----------|
| Целевой цвет | #00FF00 (0, 255, 0) | Как в промпте Gemini |
| Порог (threshold) | ~50–80 в RGB space | Подбирать по тестам: меньше = агрессивнее |
| Режим | Только уменьшение alpha | Не затирать непрозрачные пиксели персонажа |

Чтобы не задеть светлую зелень в одежде/деталях: дополнительная проверка — если текущий alpha уже высокий (например > 200), не трогать пиксель. Тогда chroma key чистит только «подозрительные» полупрозрачные зелёные края.

---

## Реализация

### Где

`src/worker.ts` — после получения `noBgBuffer` от rembg/Pixian, перед `sharp(noBgBuffer).trim()`.

### Как (sharp + raw buffer)

```ts
async function chromaKeyGreen(buffer: Buffer): Promise<Buffer> {
  const img = sharp(buffer);
  const { data, info } = await img
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const thresholdSq = 80 * 80; // ~80 единиц в RGB
  const targetR = 0, targetG = 255, targetB = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const a = channels === 4 ? data[i + 3] : 255;
    const distSq = (r - targetR) ** 2 + (g - targetG) ** 2 + (b - targetB) ** 2;
    if (distSq < thresholdSq) {
      data[i + 3] = 0; // alpha = 0
    }
  }

  return sharp(Buffer.from(data), { raw: { width, height, channels } })
    .png()
    .toBuffer();
}
```

### Вызов в worker

```ts
// После rembg/Pixian, перед trim
noBgBuffer = await chromaKeyGreen(noBgBuffer);
```

### Зависимости

Только `sharp` — уже есть в проекте.

---

## Защитные проверки (ОБЯЗАТЕЛЬНО)

### 1. Не трогать непрозрачные пиксели
Самая важная проверка. Без неё chroma key вырежет зелёные элементы персонажа (одежда, шары, растения, глаза).
```ts
if (a > 220) continue; // полностью непрозрачный пиксель — часть персонажа, не фон
```
Chroma key должен работать **только** по полупрозрачным/прозрачным краям, которые rembg не дочистил.

### 2. Запускать только после rembg, НЕ после Pixian
Pixian использует свою ML-модель и не ожидает зелёный фон. Если rembg упал и сработал Pixian fallback — chroma key может навредить (вырезать зелёные детали персонажа, которые Pixian корректно оставил).
```ts
let usedRembg = false;
// ... после rembg success:
usedRembg = true;
// ... после Pixian fallback:
// usedRembg остаётся false

// Chroma key только если использовали rembg
if (usedRembg) {
  noBgBuffer = await chromaKeyGreen(noBgBuffer);
}
```

### 3. Проверить долю зелёного в исходной картинке ДО rembg
Gemini не всегда рисует зелёный фон — иногда рисует стилевой (тёмный). Если зелёного в картинке < 10%, значит chroma key не нужен и может навредить (пятнистая прозрачность).
```ts
function getGreenPixelRatio(buffer: Buffer, width: number, height: number, channels: number): number {
  let greenCount = 0;
  let totalCount = 0;
  for (let i = 0; i < buffer.length; i += channels) {
    const r = buffer[i], g = buffer[i + 1], b = buffer[i + 2];
    totalCount++;
    if (g > 200 && r < 80 && b < 80) greenCount++;
  }
  return greenCount / totalCount;
}

// Перед rembg — проверяем исходную картинку
const { data: rawData, info: rawInfo } = await sharp(generatedBuffer)
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const greenRatio = getGreenPixelRatio(rawData, rawInfo.width, rawInfo.height, rawInfo.channels);
console.log(`[chromaKey] Green pixel ratio: ${(greenRatio * 100).toFixed(1)}%`);

// После rembg — применяем chroma key только если зелёного было достаточно
if (usedRembg && greenRatio > 0.10) {
  noBgBuffer = await chromaKeyGreen(noBgBuffer);
}
```

---

## Обновлённый алгоритм chromaKeyGreen

```ts
async function chromaKeyGreen(buffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const thresholdSq = 80 * 80;
  const targetR = 0, targetG = 255, targetB = 0;
  let cleaned = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];

    // Защита: не трогать непрозрачные пиксели (часть персонажа)
    if (a > 220) continue;

    const distSq = (r - targetR) ** 2 + (g - targetG) ** 2 + (b - targetB) ** 2;
    if (distSq < thresholdSq) {
      data[i + 3] = 0;
      cleaned++;
    }
  }

  console.log(`[chromaKey] Cleaned ${cleaned} green pixels out of ${data.length / channels} total`);

  return sharp(Buffer.from(data), { raw: { width, height, channels } })
    .png()
    .toBuffer();
}
```

---

## Риски

| Риск | Вероятность | Смягчение |
|------|------------|-----------|
| Дырки в зелёных деталях персонажа | Высокая без проверки alpha | `if (a > 220) continue` |
| Зелёный ореол на краях (anti-aliasing) | Средняя | Порог 80 ловит большинство; тонкий ореол — компромисс |
| Пятнистая прозрачность (Gemini дал частичный зелёный фон) | Средняя | `greenRatio > 0.10` — не запускать если зелёного мало |
| Урон от chroma key после Pixian | Низкая (Pixian редко) | Флаг `usedRembg` |
| Производительность | Низкая | ~10-30ms для 512×512, приемлемо |

---

## Полный pipeline в worker

```
generatedBuffer
  ↓
  Проверка greenRatio (% зелёных пикселей в оригинале)
  ↓
  rembg / Pixian → noBgBuffer, usedRembg=true/false
  ↓
  if (usedRembg && greenRatio > 0.10) → chromaKeyGreen(noBgBuffer)
  ↓
  sharp.trim().resize(512).webp() → stickerBuffer
```

---

## Чеклист

- [ ] Добавить `chromaKeyGreen()` в `src/lib/image-utils.ts`
- [ ] Добавить `getGreenPixelRatio()` — проверка доли зелёного до rembg
- [ ] Флаг `usedRembg` в worker — не запускать chroma key после Pixian
- [ ] Проверка `greenRatio > 0.10` — не запускать если зелёного мало
- [ ] Проверка `a > 220` внутри chroma key — не трогать непрозрачные пиксели
- [ ] Логирование: greenRatio, cleaned pixels count
- [ ] Подобрать threshold по тестам (50–100)
- [ ] Тест: Love Is (тёмный фон, зелёные артефакты)
- [ ] Тест: стикер с зелёной одеждой (не должна вырезаться)
- [ ] Тест: стикер без зелёного фона (chroma key пропускается)
- [ ] Коммит, push в test
