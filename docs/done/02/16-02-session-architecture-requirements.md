# Требования: архитектура сессий и режимов (1 стикер / создать пак)

**Дата:** 16.02.2026  
**Связано:** [architecture/01-api-bot.md](architecture/01-api-bot.md), [architecture/04-database.md](architecture/04-database.md), [architecture/09-known-issues.md](architecture/09-known-issues.md), [16-02-pack-flow-ux.md](16-02-pack-flow-ux.md)

---

## 1. Проблема

Текущая логика сессий в целом работает, но периодически даёт ошибки класса:

- пользователь нажимает inline-кнопку, но действие не выполняется;
- callback приходит в обработчик, но текущий `state` уже другой;
- у пользователя одновременно есть несколько релевантных сессий, а обработчик выбирает не ту;
- в ряде мест происходит silent-return без понятного ответа пользователю.

На практике это проявляется как:

- "кнопка назад не работает";
- "клик на посмотреть превью ничего не показывает";
- "ошибка state mismatch после переключения между assistant/pack/single".

---

## 2. Цели

1. Сделать выбор сессии для каждого события детерминированным.
2. Исключить исполнение callback на "чужой" или устаревшей сессии.
3. Формализовать переходы состояний и убрать ad-hoc проверки.
4. Убрать silent-fail: пользователь всегда получает понятный ответ.
5. Снизить повторяемость багов в pack/single/assistant flow.

---

## 3. Нецели

- Полная перепись всей логики бота за один релиз.
- Изменение бизнес-правил по кредитам/оплате.
- Изменение UX-копирайта и визуальной структуры экранов (кроме системных сообщений об ошибках состояния).

---

## 4. Архитектурные требования

## 4.1 Единый Session Router

Ввести единый механизм резолва сессии:

- `resolveSessionForEvent(userId, eventType, sessionRef?)`

Где:

- `eventType` — семантика события (например `pack.preview.pay`, `pack.back.carousel`, `style.pick`);
- `sessionRef` — идентификатор сессии из callback_data (если есть).

Правила резолва:

1. Если в callback есть `session_id`, сначала ищем строго её.
2. Если `session_id` отсутствует (legacy callback), используем flow-aware fallback.
3. Если найденная сессия не подходит для `eventType` по state — reject с reason code.

---

## 4.2 Явное разделение flow (`flow_kind`)

Добавить в `sessions` обязательное поле:

- `flow_kind`: `single | pack | assistant`

Требование:

- любой обработчик должен работать только с сессией своего flow;
- резолв "по state" без `flow_kind` считается legacy-режимом и должен логироваться.

---

## 4.3 Формальная FSM (таблица переходов)

Переходы должны быть описаны как таблица:

- `(flow_kind, current_state, event) -> next_state | reject(reason)`

Не допускается логика "если не подошло, просто return".

Для pack-flow минимум:

- `wait_pack_carousel + pack.try -> wait_pack_photo | wait_pack_preview_payment`
- `wait_pack_preview_payment + pack.back.carousel -> wait_pack_carousel`
- `wait_pack_preview_payment + pack.preview.pay -> generating_pack_preview`
- `wait_pack_carousel + pack.preview.pay -> reject(wrong_step)`
- `generating_pack_preview + pack.preview.pay -> reject(already_generating)`

---

## 4.4 Защита от stale callback

Все критичные callback-кнопки должны включать ссылку на сессию:

- `pack_preview_pay:<session_id>`
- `pack_back_to_carousel:<session_id>`
- `pack_try:<content_set_id>:<session_id>` (опционально)

Рекомендуемое усиление:

- добавление `session_rev` (optimistic concurrency), формат `action:<session_id>:<rev>`.

Если callback устарел:

- обработчик не выполняет действие;
- пользователь получает короткий hint (например, "Экран устарел, повтори шаг").

---

## 4.5 Единый reject-handler

Вместо `return`:

- использовать `rejectEvent(ctx, reasonCode, lang, options?)`.

Обязательные эффекты:

1. structured log (`event`, `flow_kind`, `session_id`, `state`, `reasonCode`);
2. user-visible ответ;
3. при необходимости "мягкое восстановление" (переотрисовать текущий валидный экран).

---

## 4.6 Привязка UI к сообщению

Для каждого flow-экрана хранить:

- `ui_message_id`
- `ui_chat_id`

Правила:

- при callback сначала редактируем message, из которого пришёл callback;
- если не удалось — fallback на `ui_message_id`;
- при переходе между шагами стараться очищать клавиатуру устаревшего сообщения.

---

## 5. Изменения в БД (требования)

Таблица `sessions`:

- `flow_kind text not null`
- `session_rev int not null default 1`
- `ui_message_id bigint null`
- `ui_chat_id bigint null`

Индексы:

- `(user_id, env, flow_kind, is_active, updated_at desc)`
- `(id, user_id, env, flow_kind)`

Обновление `session_rev`:

- инкремент при каждом успешном state transition.

---

## 6. Стандарты callback_data

Минимальный формат:

- `action:session_id`

Рекомендуемый формат:

- `action:session_id:rev`

Legacy callbacks без `session_id`:

- временно поддерживаются;
- каждое использование логируется (`legacy_callback=true`);
- планируемое отключение после миграции.

---

## 7. Наблюдаемость и диагностика

Для всех reject-paths логировать:

- `event`
- `flow_kind`
- `session_id`
- `current_state`
- `expected_states`
- `reason_code`
- `legacy_callback` (bool)

Базовый словарь `reason_code`:

- `session_not_found`
- `wrong_flow`
- `wrong_state`
- `stale_callback`
- `already_in_target_state`
- `legacy_callback_without_session`

---

## 8. План внедрения

### Этап A (быстрый, low-risk)

- Session Router + reject-handler
- session-bound callback_data для pack-flow
- удаление silent-return в критичных pack обработчиках

### Этап B (schema + concurrency)

- миграция `flow_kind`, `session_rev`, `ui_message_id/ui_chat_id`
- поддержка callback с `rev`
- проверка stale callbacks через optimistic lock

### Этап C (завершение)

- FSM-таблица переходов для pack/single/assistant
- постепенное удаление legacy fallback в `getActiveSession`
- cleanup deprecated callback форматов

---

## 9. Критерии приёмки

1. Невозможно воспроизвести кейс "кнопка нажата, но ничего не произошло".
2. Все callback reject-пути возвращают понятный user-facing ответ.
3. Callback из старого сообщения не запускает действие в другой сессии.
4. В логах каждый reject имеет `reason_code`.
5. Double-click и race-condition не приводят к неверному state и двойному списанию.

---

## 10. Минимальный набор тестов

- Pack: `carousel -> try -> style -> back -> try -> preview`.
- Pack: двойной клик `preview`.
- Pack: клик preview по устаревшей клавиатуре после back.
- Параллельно assistant + pack у одного пользователя.
- Single flow не деградирует после добавления `flow_kind`.

---

## 11. Риски и mitigation

Риски:

- частичный rollout создаст mixed behavior;
- старые сообщения с legacy callback будут ещё кликаться.

Mitigation:

- backward-compatible callback parser;
- feature-flag на strict mode (`session_rev`);
- усиленное логирование на период rollout.

---

## 12. Ожидаемый результат

После внедрения:

- архитектура сессий становится предсказуемой;
- stale UI и гонки перестают ломать flow;
- баги класса "не сработал клик" переходят в контролируемые reject-сценарии с понятным UX.
