# Известные проблемы и workaround'ы

## 1. `is_active` всегда false на сессиях

**Проблема**: при любом `UPDATE` на таблице `sessions`, поле `is_active` сбрасывается в `false`.
Основной запрос `getActiveSession` (`WHERE is_active = true`) никогда не находит сессию.

**Workaround**: fallback-запрос без фильтра по `is_active`:

```typescript
// Fallback: some DB setups flip is_active to false on update
const { data: fallback } = await supabase
  .from("sessions")
  .select("*")
  .eq("user_id", userId)
  .eq("env", config.appEnv)
  .neq("state", "canceled")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
```

**Как диагностировать**: выполнить в Supabase SQL Editor:

```sql
-- Триггеры на sessions
SELECT tgname, tgrelid::regclass, proname
FROM pg_trigger t JOIN pg_proc p ON t.tgfoid = p.oid
WHERE tgrelid = 'sessions'::regclass;

-- RLS-политики
SELECT * FROM pg_policies WHERE tablename = 'sessions';

-- Default для is_active
SELECT column_name, column_default
FROM information_schema.columns
WHERE table_name = 'sessions' AND column_name = 'is_active';
```

**Статус**: workaround работает, но добавляет лишний запрос к БД.

---

## 2. `telegram_file_id` привязан к боту

**Проблема**: `telegram_file_id` стикера уникален для каждого бота.
Стикер, сохранённый через test-бота, не может быть отправлен prod-ботом.

**Решение**: фильтр по `env` при поиске примеров стилей в карусели.

```typescript
// Ищем стикеры только для текущего окружения
.eq("env", config.appEnv)
```

---

## 3. Supabase Storage бакет может не существовать

**Проблема**: `createSignedUrl` зависает на 2 минуты, если бакет не создан.
Это блокирует бота и вызывает backlog сообщений.

**Решение**: не использовать Supabase Storage URLs для отображения в Telegram.
Вместо этого используем `telegram_file_id`.
Storage используется только для бэкапа.

---

## 4. Race condition: Стили + Ассистент

**Проблема**: пользователь может нажать "Стили" пока ассистент обрабатывает запрос.
Оба хендлера работают параллельно, ассистент может ответить после переключения в ручной режим.

**Решение**: race condition guard в `assistant_chat` хендлере:

```typescript
// Re-check session state after AI call
const freshSession = await getActiveSession(user.id);
if (freshSession && freshSession.state !== "assistant_chat") {
  console.log("session state changed during AI call — skipping reply");
  return;
}
```

---

## 5. Фото теряется при переключении режимов

**Проблема**: при переключении между Помощником и Стилями бот мог просить
загрузить фото заново, хотя пользователь уже загружал.

**Решение**: `users.last_photo_file_id` — сохраняем последнее фото пользователя.
При переключении режимов проверяем через `getUserPhotoFileId()`.

**Миграция**: `sql/063_users_last_photo_file_id.sql`

---

## 6. `wait_first_purchase` / `wait_buy_credit` не в DB enum

**Проблема**: код использует состояния `wait_first_purchase` и `wait_buy_credit`,
но они не были добавлены в enum `session_state` в БД.
UPDATE на session state падал с ошибкой.

**Решение**: миграция:

```sql
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_first_purchase';
ALTER TYPE session_state ADD VALUE IF NOT EXISTS 'wait_buy_credit';
```

**Статус**: исправлено.

---

## 7. LLM вызывает `confirm_and_generate` при неполных параметрах

**Проблема**: AI иногда вызывает `confirm_and_generate` хотя emotion или pose
ещё не собраны. Код это ловит и делает fallback, но это лишний round-trip.

**Решение**:
1. Усиленная инструкция в tool description
2. Guard в `processAssistantResult`: проверка `allParamsCollected()`
3. Fallback: вместо confirm спрашиваем следующий недостающий параметр

---

## 8. AI таймауты на длинных диалогах

**Проблема**: при 7-9 сообщениях в контексте, gpt-4o-mini может не успеть
ответить за 15 секунд. Таймаут → retry → ещё таймаут → задержка 30+ сек.

**Решение**: увеличен таймаут с 15с до 30с (`ai-chat.ts`, `gemini-chat.ts`).

---

## 9. `drop_pending_updates` при рестарте

**Проблема**: при рестарте бота Telegram отправляет все накопившиеся сообщения.
Если бот был в даун 5 минут — получает все сообщения за это время разом,
вызывая дублирование обработки.

**Решение**:

```typescript
await bot.telegram.deleteWebhook({ drop_pending_updates: true });
bot.launch({ dropPendingUpdates: true });
```

---

## 10. `assistant_wait_photo` без `assistant_session`

**Проблема**: если пользователь нажал "Стили" (закрыл assistant session),
а потом отправил фото — session state остался `assistant_wait_photo`,
но `assistant_session` уже закрыта. Фото-хендлер делал `return` без ответа.

**Решение**:
1. Хендлер "Стили" сбрасывает state в `wait_photo` перед проверкой фото
2. Фото-хендлер при `assistant_wait_photo` без `assistant_session` —
   fallthrough в ручной режим вместо silent return

---

## 11. Stale inline callbacks в pack flow

**Проблема**: старые inline-кнопки из предыдущих сообщений могут попадать в новую
сессию и вызывать гонки по состояниям.

**Текущее решение**:
1. Критичные callback'и pack flow привязаны к `session_id` в `callback_data`.
2. Поддержан формат `action:sid:rev` для проверки актуальности кнопки.
3. Добавлены `sessions.session_rev` и `strict_session_rev_enabled` (feature flag).

**Режим rollout**:
- сначала `strict_session_rev_enabled=false` (совместимость),
- затем включить strict после smoke-тестов на `test`.

---

## 12. Subject-profile: ETIMEDOUT к Gemini

**Проблема**: детектор субъекта (single/multi/unknown по фото) вызывает Gemini с большим телом (фото в base64). При сетевых задержках или нагрузке на `generativelanguage.googleapis.com` запрос может завершиться с **ETIMEDOUT**. Пользователь при этом не видит ошибку — ставится fallback `subjectMode: 'unknown'`, генерация идёт дальше; если у пользователя 0 кредитов, он попадает на paywall (wait_first_purchase).

**Решение**:
1. Таймаут детектора увеличен до 45 сек (`DETECTOR_TIMEOUT_MS` в `src/lib/subject-profile.ts`).
2. При ETIMEDOUT выполняется один повтор (всего до 2 попыток).
3. Для мониторинга в логах: `[subject-profile] detector ETIMEDOUT, retrying` (первая попытка), `[subject-profile] detector ETIMEDOUT after retry, using unknown` (обе попытки не удались). Поиск по тегу `detector ETIMEDOUT` даёт все такие кейсы.

**Как диагностировать**: в логах API/worker искать `[subject-profile] detector ETIMEDOUT`.
