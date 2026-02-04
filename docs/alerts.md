# Система алертов (Error Alerting)

## Цель

Получать мгновенные уведомления в Telegram-канал при возникновении ошибок.

## Решения

- ✅ Отдельный канал для алертов
- ✅ Используем того же бота
- ✅ Алерты из кода (без внешнего health check)

## Конфигурация

```env
ALERT_CHANNEL_ID=-100123456789  # ID канала для алертов
```

> Бот должен быть админом канала с правом писать сообщения

## Типы алертов

| Тип | Emoji | Когда |
|-----|-------|-------|
| `generation_failed` | 🟡 | Gemini не вернул картинку |
| `gemini_error` | 🟠 | Gemini API вернул ошибку (404, 500, etc) |
| `rembg_failed` | 🟠 | Сервис удаления фона недоступен |
| `worker_error` | 🔴 | Необработанное исключение в воркере |
| `api_error` | 🔴 | Необработанное исключение в API |

## Формат сообщений

### Ошибка генерации
```
🟡 generation_failed

⏰ 2026-02-04T13:05:23.000Z

❌ Gemini returned no image

📋 Details:
• sessionId: abc-123
• generationType: style
• userId: xyz-456
```

### Ошибка Worker/API
```
🔴 worker_error

⏰ 2026-02-04T13:05:23.000Z

❌ TypeError: Cannot read property 'id' of undefined

📜 Stack:
```
at processJob (worker.ts:125)
at main (worker.ts:45)
```
```

## Реализация

### Модуль: `src/lib/alerts.ts`

```typescript
type AlertType = "generation_failed" | "gemini_error" | "rembg_failed" | "worker_error" | "api_error";

interface AlertOptions {
  type: AlertType;
  message: string;
  details?: Record<string, any>;
  stack?: string;
}

export async function sendAlert(options: AlertOptions): Promise<void>;
```

### Точки интеграции

| Файл | Где | Тип алерта |
|------|-----|------------|
| `worker.ts` | catch в processJob | `generation_failed`, `gemini_error`, `rembg_failed` |
| `worker.ts` | uncaughtException | `worker_error` |
| `index.ts` | uncaughtException | `api_error` |

## Checklist

- [x] Создать `src/lib/alerts.ts`
- [x] Добавить `ALERT_CHANNEL_ID` в config
- [x] Интегрировать в `worker.ts`
- [x] Интегрировать в `index.ts`
- [ ] Создать канал и добавить бота админом
- [ ] Добавить `ALERT_CHANNEL_ID` в env на проде
- [ ] Тест: вызвать ошибку и проверить алерт
