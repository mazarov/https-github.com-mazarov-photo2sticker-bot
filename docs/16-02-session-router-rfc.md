# RFC: Session Router и FSM для Telegram callback flow

**Дата:** 16.02.2026  
**Статус:** Draft  
**Связано:** [16-02-session-architecture-requirements.md](16-02-session-architecture-requirements.md)

---

## 1. Контекст

Сейчас резолв сессии размазан по коду:

- `getActiveSession()`
- `getPackFlowSession()`
- `getSessionForStyleSelection()`

Это приводит к неявным конфликтам между flow и stale callback.

RFC определяет единый runtime-контур:

1. `resolveSessionForEvent`
2. таблица переходов FSM
3. стандартизованный reject
4. session-bound callback_data (`session_id`, опционально `rev`)

---

## 2. DB-изменения (предложение)

```sql
-- 1) Flow kind
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS flow_kind text;

UPDATE sessions
SET flow_kind = CASE
  WHEN state LIKE 'wait_pack_%' OR state IN ('generating_pack_preview', 'wait_pack_approval', 'processing_pack')
    THEN 'pack'
  WHEN state LIKE 'assistant_%'
    THEN 'assistant'
  ELSE 'single'
END
WHERE flow_kind IS NULL;

ALTER TABLE sessions
ALTER COLUMN flow_kind SET NOT NULL;

-- 2) Session revision
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS session_rev int NOT NULL DEFAULT 1;

-- 3) Active UI message for current step
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS ui_message_id bigint;

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS ui_chat_id bigint;

-- 4) Индексы
CREATE INDEX IF NOT EXISTS idx_sessions_flow_active
  ON sessions(user_id, env, flow_kind, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_lookup
  ON sessions(id, user_id, env, flow_kind);
```

---

## 3. Callback format

## 3.1 New format

- `action:session_id:rev` (recommended)
- `action:session_id` (minimum)

## 3.2 Legacy support

Legacy callbacks без `session_id` поддерживаются временно:

- `action`

В этом случае `resolveSessionForEvent` работает в degraded режиме и пишет warning.

---

## 4. Runtime интерфейсы

## 4.1 `resolveSessionForEvent`

```ts
type FlowKind = "single" | "pack" | "assistant";

type ResolveInput = {
  userId: string;
  env: string;
  eventType: string;         // e.g. "pack.preview.pay"
  expectedFlow: FlowKind;    // e.g. "pack"
  expectedStates?: string[]; // e.g. ["wait_pack_preview_payment"]
  sessionId?: string | null;
  sessionRev?: number | null;
};

type ResolveResult =
  | { ok: true; session: any; legacy: boolean }
  | { ok: false; reasonCode: string; session?: any; legacy: boolean };
```

Алгоритм:

1. Если `sessionId` есть, ищем строго `id+user+env`.
2. Проверяем `flow_kind`.
3. Если передан `sessionRev`, проверяем совпадение.
4. Проверяем `expectedStates`.
5. Если `sessionId` нет, fallback на active session по `flow_kind` (legacy=true).

---

## 4.2 `transitionSessionState`

```ts
type TransitionInput = {
  sessionId: string;
  fromStates: string[];
  toState: string;
  patch?: Record<string, any>;
  incrementRev?: boolean; // default true
};

type TransitionResult =
  | { ok: true; session: any }
  | { ok: false; reasonCode: "stale_state" | "not_found" | "db_error" };
```

Атомарность:

- `UPDATE ... WHERE id = ? AND state IN (?)`
- при успехе: `session_rev = session_rev + 1`

---

## 4.3 `rejectEvent`

```ts
type RejectInput = {
  ctx: any;
  lang: "ru" | "en";
  eventType: string;
  reasonCode: string;
  session?: any;
  hintKey?: string; // i18n key
  showAlert?: boolean;
};
```

Обязательное поведение:

1. structured log;
2. `answerCbQuery` (если callback);
3. опционально fallback-экран (`sendPackStyleSelectionStep`, карусель и т.д.).

---

## 5. FSM таблица (pack, MVP)

| Current state | Event | Next state | Notes |
|---|---|---|---|
| `wait_pack_carousel` | `pack.try` | `wait_pack_photo` / `wait_pack_preview_payment` | зависит от наличия фото |
| `wait_pack_preview_payment` | `pack.back.carousel` | `wait_pack_carousel` | idempotent |
| `wait_pack_carousel` | `pack.back.carousel` | `wait_pack_carousel` | idempotent, redraw |
| `wait_pack_preview_payment` | `pack.preview.pay` | `generating_pack_preview` | атомарный переход |
| `wait_pack_carousel` | `pack.preview.pay` | reject(`wrong_step`) | stale preview button |
| `generating_pack_preview` | `pack.preview.pay` | reject(`already_generating`) | двойной клик |
| `wait_pack_approval` | `pack.approve` | `processing_pack` | атомарно |
| `wait_pack_approval` | `pack.regenerate` | `generating_pack_preview` | атомарно |
| `wait_pack_approval` | `pack.cancel` | `canceled` | завершение |

---

## 6. Пример внедрения на одном callback

`pack_preview_pay`:

1. parse `sessionId/rev` из callback;
2. `resolveSessionForEvent(... expectedFlow="pack", expectedStates=["wait_pack_preview_payment"])`;
3. если reject — `rejectEvent(...)`, return;
4. `transitionSessionState(from=wait_pack_preview_payment, to=generating_pack_preview)`;
5. дальше бизнес-логика списания/очереди.

---

## 7. Rollout стратегия

## Phase 1 (safe)

- Добавить DB-поля;
- добавить новые helper-функции;
- перевести только pack critical callbacks (`preview`, `back`, `approve`, `regenerate`, `cancel`).

## Phase 2

- перевести single-flow callbacks;
- перевести assistant critical callbacks.

## Phase 3

- отключить legacy callbacks без `session_id`;
- удалить fallback логику в `getActiveSession` для критичных путей.

---

## 8. Telemetry / метрики

Рекомендуемые счетчики:

- `session_resolve_total{event, result, reason}`
- `session_transition_total{from, to, result}`
- `callback_legacy_total{event}`
- `reject_event_total{event, reason}`

Алерт:

- резкий рост `wrong_state` / `stale_callback`.

---

## 9. Backward compatibility

До отключения legacy:

- принимать `action`, `action:sessionId`, `action:sessionId:rev`;
- в логах помечать формат;
- добавить админ-дашборд по доле legacy-кликов.

---

## 10. Definition of Done

1. Pack-flow callbacks полностью работают через `resolveSessionForEvent`.
2. Нет silent-return в pack critical handlers.
3. Есть reason-coded reject logs.
4. Stale callback не приводит к неверному transition.
5. QA сценарии pack/single/assistant проходят без регрессий.
