# Pixian API Retry Logic

## Проблема

Pixian API периодически падает с ошибкой `ECONNRESET` (socket hang up).

**Пример ошибки:**
```
🟠 rembg_failed
❌ Pixian API failed: ECONNRESET socket hang up
• imageSizeKb: 883
• durationMs: 30172
• errorCode: ECONNRESET
```

**Причина:** Сервер Pixian сбрасывает соединение (перегрузка, временный сбой).

## Решение

Добавить retry логику с exponential backoff: 3 попытки с увеличивающейся задержкой.

## Реализация

### Изменения в `worker.ts`

```typescript
// Retry helper
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 2000
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRetryable = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(err.code) 
        || err.response?.status >= 500;
      
      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }
      
      const delay = baseDelayMs * attempt; // 2s, 4s, 6s
      console.log(`Pixian attempt ${attempt} failed (${err.code}), retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw new Error("Unreachable");
}

// Использование
const pixianRes = await retryWithBackoff(async () => {
  return axios.post("https://api.pixian.ai/api/v2/remove-background", pixianForm, {
    auth: {
      username: config.pixianUsername,
      password: config.pixianPassword,
    },
    headers: pixianForm.getHeaders(),
    responseType: "arraybuffer",
    timeout: 60000,
  });
});
```

## Логика retry

| Попытка | Задержка | Общее время |
|---------|----------|-------------|
| 1 | - | 0s |
| 2 | 2s | 2s |
| 3 | 4s | 6s |

**Retryable ошибки:**
- `ECONNRESET` — соединение сброшено
- `ETIMEDOUT` — таймаут соединения
- `ECONNREFUSED` — отказ соединения
- HTTP 5xx — серверные ошибки Pixian

**Не retryable:**
- HTTP 4xx — клиентские ошибки (неверный API ключ, лимиты)
- Другие ошибки

## Логирование

При retry логировать:
```
Pixian attempt 1 failed (ECONNRESET), retrying in 2000ms...
Pixian attempt 2 failed (ECONNRESET), retrying in 4000ms...
Pixian background removal successful (took 45123ms, attempts: 3)
```

## Алерты

- Алерт отправлять только если все попытки исчерпаны
- Добавить в details: `attempts: 3`

## Checklist

- [x] Создать функцию `retryWithBackoff`
- [x] Обернуть вызов Pixian API
- [x] Обновить логирование (добавить attempts)
- [x] Обновить алерт (добавить attempts в details)
- [ ] Деплой
- [ ] Мониторинг ошибок
