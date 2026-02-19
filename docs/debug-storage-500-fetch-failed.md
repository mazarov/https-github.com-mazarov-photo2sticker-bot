# Отладка Storage 500 "fetch failed"

Ошибка в логах Storage:
```json
{ "code": 500, "message": "An error has occurred: fetch failed", "requestId": "..." }
```

**Частая причина (self-hosted Supabase на Dockhost):** контейнер **supabase-minio** выключен. Storage (supabase-storage) хранит файлы в MinIO; если MinIO не запущен, загрузка/скачивание падают с 500 "fetch failed". **Решение:** включить контейнер supabase-minio в проекте с Supabase.

---

Разбираем по шагам.

---

## Шаг 1. Где именно падает

- **В логах воркера (бот)** — наш код вызывает `supabase.storage.from(bucket).upload(...)`, в ответ приходит 500. В логах воркера после деплоя будет строка `[PackAssemble] Storage upload starting: bucket=... prefix=... url=...` и при ошибке — `[PackAssemble] Storage upload failed ...` с полным payload (должен совпадать requestId с логами Storage).
- **В логах самого Storage (Dockhost / Supabase)** — сервис Storage (или Kong) логирует 500 у себя. Значит запрос до него доходит, но что-то падает внутри (Kong → Storage, или Storage → MinIO, или сетевая ошибка на стороне сервера).

Сопоставь **requestId** из логов Storage с временем запроса в логах воркера и с bucket/prefix из новой строки `Storage upload starting`.

---

## Шаг 2. Бакет существует

500 "fetch failed" иногда возвращают, если бакет не создан или недоступен.

- В проекте с Supabase (Dockhost): зайди в админку **MinIO** (порт 9001; если снаружи — через домен и маршрут на 9001).
- Проверь, что есть бакет с именем **stickers** (или значение `SUPABASE_STORAGE_BUCKET` в env бота). Создай бакет, если его нет.
- Для make_example и лендинга нужен ещё бакет **stickers-examples** (публичный).

---

## Шаг 3. Куда ходит бот (URL и сеть)

- В логах воркера теперь пишется **url=...** — это `SUPABASE_SUPABASE_PUBLIC_URL`. Должен быть адрес Kong (например `http://10.177.250.48:80` или `https://bk07-67ud-ea1y.gw-1a.dockhost.net`).
- Если бот в другом проекте — трафик между проектами должен быть разрешён (Настройки → DNS и сеть). Иначе запрос до Kong не дойдёт или оборвётся (может дать таймаут или "fetch failed" на клиенте).

Проверь с хоста, где крутится воркер: `curl -v -X POST "http://<Kong-URL>/storage/v1/object/<bucket>/test" ...` (или GET к health) — доступен ли Kong по сети.

---

## Шаг 4. Kong → Storage (конфиг supabase-kong)

В конфиге Kong маршрут Storage такой:

```yaml
  - name: storage-v1
    _comment: 'Storage: /storage/v1/* -> http://supabase-storage:5000/*'
    url: http://supabase-storage:5000/
    routes:
      - name: storage-v1-all
        strip_path: true
        paths:
          - /storage/v1/
    plugins:
      - name: cors
```

То есть запросы на `/storage/v1/*` Kong проксирует на **http://supabase-storage:5000/** (без key-auth на Kong — авторизацию делает сам Storage).

Цепочка: **бот → Kong → supabase-storage:5000 → (MinIO / БД метаданных)**.

500 "fetch failed" может быть:
- **Kong не достучался до supabase-storage** — тогда "fetch" в логах со стороны Kong (Kong не смог получить ответ от :5000). Проверить: контейнер supabase-storage запущен в том же проекте, сеть между контейнерами есть.
- **supabase-storage не достучался до MinIO или БД** — тогда "fetch failed" логирует уже сам контейнер Storage (внутренний запрос к MinIO/БД упал). Смотреть логи контейнера **supabase-storage** (и при необходимости MinIO).

---

## Шаг 5. Размер и таймаут

Большие тела запроса или долгий ответ MinIO могут приводить к обрыву (таймаут, "fetch failed").

- В логах воркера видно количество и размер: каждый файл — один webp стикера (обычно десятки–сотни KB). Если размер огромный — попробовать уменьшить или проверить лимиты в Kong/Nginx и MinIO.

---

## Шаг 6. Что сделано в коде

- В начале цикла загрузки в Storage пишется: `[PackAssemble] Storage upload starting: bucket=<name> prefix=<path> url=<SUPABASE_URL>`.
- При ошибке загрузки пишется полный payload ответа (в т.ч. code, message, requestId), чтобы сопоставить с логами Storage.

После деплоя воспроизведи паку, возьми из логов воркера bucket, prefix, url и строку с ошибкой (и requestId, если есть в payload), и сравни с логами Storage по requestId и времени.
