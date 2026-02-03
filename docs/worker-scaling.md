# Масштабирование Worker — Требования

## Проблема

Текущая реализация не поддерживает несколько воркеров. При запуске 2+ воркеров возникает **race condition**:

```typescript
// Текущий код — НЕ безопасен для нескольких воркеров!

// 1. Worker A и Worker B могут взять один и тот же job
const { data: jobs } = await supabase
  .from("jobs")
  .select("*")
  .eq("status", "queued")
  .limit(1);

// 2. Потом отдельно UPDATE — оба воркера обновят один job
await supabase
  .from("jobs")
  .update({ status: "processing" })
  .eq("id", job.id);

// Результат: один job обрабатывается дважды!
```

---

## Решение: Атомарный захват job

Использовать **атомарный UPDATE с условием** — только один воркер успешно захватит конкретный job:

```typescript
const WORKER_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;

async function claimJob() {
  const { data: jobs } = await supabase
    .from("jobs")
    .update({ 
      status: "processing",
      worker_id: WORKER_ID,
      started_at: new Date().toISOString()
    })
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .select("*");

  return jobs?.[0] || null;
}
```

**Как это работает:**
- UPDATE атомарен — PostgreSQL гарантирует что только один запрос обновит строку
- Если job уже захвачен (status != 'queued'), UPDATE вернёт пустой массив
- Каждый воркер получает уникальный job

---

## Изменения в БД

### SQL миграция

```sql
-- 013_worker_scaling.sql

-- Добавить поля для трекинга воркера
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS worker_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Индекс для быстрого поиска queued jobs
CREATE INDEX IF NOT EXISTS idx_jobs_status_created 
ON jobs(status, created_at) 
WHERE status = 'queued';
```

---

## Изменения в коде

### worker.ts

```typescript
import os from "os";

// Уникальный ID воркера
const WORKER_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;

console.log(`Worker started: ${WORKER_ID}`);

async function poll() {
  while (true) {
    // Атомарный захват job
    const { data: jobs } = await supabase
      .from("jobs")
      .update({ 
        status: "processing",
        worker_id: WORKER_ID,
        started_at: new Date().toISOString()
      })
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .select("*");

    const job = jobs?.[0];
    if (!job) {
      await sleep(config.jobPollIntervalMs);
      continue;
    }

    console.log(`Job ${job.id} claimed by ${WORKER_ID}`);

    try {
      await runJob(job);
      await supabase
        .from("jobs")
        .update({ 
          status: "done",
          completed_at: new Date().toISOString()
        })
        .eq("id", job.id);
    } catch (err: any) {
      console.error("Job failed:", job.id, err?.message || err);
      await supabase
        .from("jobs")
        .update({ 
          status: "error", 
          error: String(err?.message || err),
          completed_at: new Date().toISOString()
        })
        .eq("id", job.id);

      // ... refund logic ...
    }
  }
}
```

---

## Обработка зависших jobs (опционально)

Если воркер упал во время обработки, job останется в статусе "processing" навсегда.

### Решение: Cleanup зависших jobs

```typescript
// Запускать периодически (например, каждые 5 минут)
async function cleanupStuckJobs() {
  const stuckThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 минут

  const { data: stuckJobs } = await supabase
    .from("jobs")
    .update({ status: "queued", worker_id: null, started_at: null })
    .eq("status", "processing")
    .lt("started_at", stuckThreshold.toISOString())
    .select("id");

  if (stuckJobs?.length) {
    console.log(`Reset ${stuckJobs.length} stuck jobs`);
  }
}
```

Или через SQL cron в Supabase:

```sql
-- Сбрасывать зависшие jobs каждые 5 минут
UPDATE jobs 
SET status = 'queued', worker_id = NULL, started_at = NULL
WHERE status = 'processing' 
AND started_at < NOW() - INTERVAL '5 minutes';
```

---

## Dockhost — масштабирование

Просто увеличить количество реплик контейнера worker:

| Реплики | Параллельная обработка |
|---------|------------------------|
| 1       | 1 job одновременно     |
| 2       | 2 jobs одновременно    |
| 3       | 3 jobs одновременно    |

**Рекомендация:** Начать с 2 реплик, увеличивать по мере роста нагрузки.

---

## Мониторинг

### Логи

```
Worker started: worker-abc123-1234-1706900000000
Job d739b3ea-... claimed by worker-abc123-...
Job d739b3ea-... completed in 45.2s
```

### Метрики (опционально)

- Queue length: `SELECT COUNT(*) FROM jobs WHERE status = 'queued'`
- Processing: `SELECT COUNT(*) FROM jobs WHERE status = 'processing'`
- Avg processing time: `AVG(completed_at - started_at)`

### Алерты

- Job в "processing" > 5 минут — возможно воркер завис
- Queue > 10 jobs — нужно больше воркеров

---

## Чеклист

- [ ] SQL миграция `013_worker_scaling.sql`
- [ ] worker.ts: генерировать `WORKER_ID`
- [ ] worker.ts: атомарный захват job через UPDATE
- [ ] worker.ts: записывать `started_at`, `completed_at`
- [ ] worker.ts: логировать `WORKER_ID` при захвате job
- [ ] (опционально) Cleanup зависших jobs
- [ ] Тест: запустить 2 воркера локально, убедиться что jobs не дублируются
- [ ] Dockhost: увеличить реплики worker контейнера до 2

---

## Ожидаемый результат

| До | После |
|----|-------|
| 1 воркер, ~50 сек/стикер | N воркеров, ~50 сек/стикер каждый |
| 10 пользователей = 500 сек очередь | 10 пользователей / 2 воркера = 250 сек очередь |
| Race condition при 2+ воркерах | Безопасная параллельная обработка |
