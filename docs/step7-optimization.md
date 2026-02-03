# Оптимизация шага 7 генерации — Требования

## Проблема

Шаг 7 («📦 Подготавливаю стикер...») занимает непропорционально много времени по сравнению с другими шагами. Пользователь видит этот статус дольше всего, что создаёт ощущение зависания.

---

## Текущая логика (последовательная)

```
updateProgress(7)
    ↓
Upload to Supabase Storage (~1-3 сек)
    ↓
Insert into stickers table (~0.1 сек)
    ↓
sendSticker to Telegram (~5-10 сек)
    ↓
clearProgress()
    ↓
Update session
```

**Итого шаг 7: ~6-13 сек**

---

## Предлагаемые оптимизации

### 1. Параллельное выполнение

Запускать upload в Storage и sendSticker **параллельно**:

```typescript
await updateProgress(7);

const [uploadResult, stickerFileId] = await Promise.all([
  // Upload to storage
  supabase.storage
    .from(bucket)
    .upload(path, stickerBuffer, { contentType: "image/webp", upsert: true }),
  // Send sticker to Telegram
  sendSticker(telegramId, stickerBuffer, replyMarkup),
]);

// Insert history (depends on uploadResult path)
await supabase.from("stickers").insert({ ... });

await clearProgress();
```

**Ожидаемый выигрыш:** ~3-5 сек (если upload и send примерно равны по времени)

---

### 2. Разбить шаг 7 на подшаги

Добавить шаги 8 и 9 для более плавного UX:

| Шаг | Текст | Операция |
|-----|-------|----------|
| 7 | 📦 Сохраняю стикер... (7/9) | Upload to Storage |
| 8 | 📤 Отправляю стикер... (8/9) | sendSticker |
| 9 | ✅ Готово! (9/9) | clearProgress + update session |

**Плюсы:** Прогресс движется, пользователь видит активность
**Минусы:** Больше правок, больше текстов

---

### 3. Логирование таймингов (для диагностики)

Добавить замеры времени каждой операции:

```typescript
console.time("step7_upload");
await supabase.storage.from(bucket).upload(...);
console.timeEnd("step7_upload");

console.time("step7_insert");
await supabase.from("stickers").insert(...);
console.timeEnd("step7_insert");

console.time("step7_sendSticker");
await sendSticker(...);
console.timeEnd("step7_sendSticker");
```

Это позволит точно определить, какая операция тормозит.

---

### 4. Отложенная запись истории

Перенести `insert into stickers` **после** отправки стикера или в фоновый процесс. Пользователю важнее быстро получить стикер, а запись в историю может подождать.

```typescript
// Сначала отправляем
const stickerFileId = await sendSticker(...);
await clearProgress();

// Потом записываем историю (не блокирует UX)
await supabase.from("stickers").insert(...);
```

---

## Рекомендуемый план

### Фаза 1: Диагностика
- [ ] Добавить логирование таймингов
- [ ] Собрать данные по 10-20 генерациям
- [ ] Определить bottleneck

### Фаза 2: Быстрая оптимизация
- [ ] Параллелить upload + sendSticker
- [ ] Отложить insert после clearProgress

### Фаза 3 (опционально): UX улучшения
- [ ] Разбить на шаги 7/8/9
- [ ] Обновить тексты и SQL

---

## Технические изменения (Фаза 2)

### worker.ts — параллельное выполнение

```typescript
await updateProgress(7);

// Parallel: upload + send
const [_, stickerFileId] = await Promise.all([
  supabase.storage
    .from(config.supabaseStorageBucket)
    .upload(filePathStorage, stickerBuffer, { contentType: "image/webp", upsert: true }),
  sendSticker(telegramId, stickerBuffer, replyMarkup),
]);

// Clear progress first (user sees sticker)
await clearProgress();

// Then save history (non-blocking for UX)
await supabase.from("stickers").insert({
  user_id: session.user_id,
  session_id: session.id,
  source_photo_file_id: sourceFileId,
  user_input: session.user_input || null,
  generated_prompt: session.prompt_final || null,
  result_storage_path: filePathStorage,
  sticker_set_name: user?.sticker_set_name || null,
});

// Update session
await supabase.from("sessions").update({ ... }).eq("id", session.id);
```

---

## Ожидаемый результат

| Метрика | До | После |
|---------|-----|-------|
| Шаг 7 длительность | ~6-13 сек | ~3-8 сек |
| Субъективное ощущение | «Завис» | «Работает» |

---

## Чеклист

- [ ] Добавить логирование таймингов
- [ ] Проанализировать результаты
- [ ] Реализовать Promise.all для upload + send
- [ ] Перенести insert после clearProgress
- [ ] Тестирование
