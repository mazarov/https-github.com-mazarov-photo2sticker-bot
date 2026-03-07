# Gemini API Proxy — обход гео-ограничений

## Проблема

Ошибка: `Gemini API failed: User location is not supported for the API use.`

Google Gemini API блокирует запросы из РФ по IP-геолокации. Worker и API хостятся на Dockhost (Россия) — часть запросов к `generativelanguage.googleapis.com` получают гео-блокировку.

## Решение

Проксировать все запросы к Gemini API через VPS в Европе (nginx reverse proxy).

## Архитектура

```
Dockhost (РФ)                          VPS (EU)                    Google
┌─────────────┐                  ┌──────────────────┐     ┌──────────────────────┐
│ API (index) │──── HTTPS ──────▶│ nginx proxy      │────▶│ generativelanguage   │
│ Worker      │                  │ gemini-proxy.xxx │     │ .googleapis.com      │
│ ai-chat     │                  └──────────────────┘     └──────────────────────┘
│ gemini-chat │
│ subject-pr. │
└─────────────┘
```

## Требования

### 1. Новая env-переменная

| Переменная | Обязательная | Default | Описание |
|---|---|---|---|
| `GEMINI_PROXY_BASE_URL` | Нет | `https://generativelanguage.googleapis.com` | Base URL для всех вызовов Gemini API. Если задана — все запросы идут через прокси. |

- Если **не задана** — работает напрямую (для локальной разработки без прокси).
- Формат: `https://gemini-proxy.yourdomain.com` (без `/v1beta/...`, без trailing slash).

### 2. Единая функция для Gemini URL

Создать хелпер `getGeminiUrl(model: string)` в `src/config.ts` или отдельном файле:

```typescript
export function getGeminiUrl(model: string): string {
  const base = config.geminiProxyBaseUrl;
  return `${base}/v1beta/models/${model}:generateContent`;
}
```

### 3. Замена hardcoded URL во всех файлах

Заменить **все 12 вхождений** `https://generativelanguage.googleapis.com/v1beta/models/...` на вызов `getGeminiUrl(model)`:

| Файл | Вхождений | Что вызывается |
|---|---|---|
| `src/index.ts` | 5 | subject detection, multi-agent, pack ideas, emotion analysis |
| `src/worker.ts` | 3 | sticker generation (primary + retry), pack preview |
| `src/lib/ai-chat.ts` | 1 | AI chat (assistant) |
| `src/lib/gemini-chat.ts` | 2 | Gemini chat sessions |
| `src/lib/subject-profile.ts` | 1 | subject profile detection |

### 4. Обновить документацию

- `docs/architecture/08-deployment.md` — добавить `GEMINI_PROXY_BASE_URL` в таблицу опциональных env.
- `docs/architecture/09-known-issues.md` — добавить раздел про гео-ограничение Gemini и прокси-решение.

### 5. Настройка прокси-сервера (вне кода бота)

**VPS:** любой дешёвый VPS в EU (Hetzner €3.29/мес, DigitalOcean $4/мес, и т.д.).

**nginx конфиг:**

```nginx
server {
    listen 443 ssl http2;
    server_name gemini-proxy.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/gemini-proxy.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gemini-proxy.yourdomain.com/privkey.pem;

    # Лимит размера тела — base64-фото могут быть до 10 MB
    client_max_body_size 20m;

    location / {
        proxy_pass https://generativelanguage.googleapis.com;
        proxy_set_header Host generativelanguage.googleapis.com;
        proxy_ssl_server_name on;

        # Таймауты — генерация может занять до 60 сек
        proxy_connect_timeout 10s;
        proxy_read_timeout    120s;
        proxy_send_timeout    120s;
    }
}
```

**Безопасность (опционально):**
- Добавить IP whitelist (только IP Dockhost-серверов).
- Или добавить header-based auth: бот отправляет `X-Proxy-Key: <secret>`, nginx проверяет.

## Не входит в scope

- Миграция Worker/API на другой хостинг.
- Переход на Vertex AI.
- Изменение моделей Gemini.

## Оценка изменений в коде

- `src/config.ts` — 2 строки (новая env + хелпер)
- `src/index.ts` — 5 замен URL
- `src/worker.ts` — 3 замены URL
- `src/lib/ai-chat.ts` — 1 замена URL
- `src/lib/gemini-chat.ts` — 2 замены URL
- `src/lib/subject-profile.ts` — 1 замена URL
- `docs/architecture/08-deployment.md` — 1 строка в таблицу
- `docs/architecture/09-known-issues.md` — новый раздел

**Итого: ~20 строк изменений в коде.**
