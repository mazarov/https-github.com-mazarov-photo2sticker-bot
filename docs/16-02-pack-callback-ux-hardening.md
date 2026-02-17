# Требования: UX hardening callback-кнопок в pack flow

**Дата:** 16.02.2026  
**Статус:** proposed  
**Связано:** [16-02-pack-flow-ux.md](16-02-pack-flow-ux.md), [known-bugs.md](known-bugs.md)

---

## 1. Проблема

В текущем pack flow пользователи часто видят, что кнопка "не срабатывает", хотя callback фактически отрабатывает и отклоняется:

- `reasonCode = wrong_state` (кнопка не подходит текущему шагу)
- `reasonCode = stale_callback` (кнопка из устаревшего сообщения, `session_rev` уже изменился)

Симптомы:

- пользователь кликает, но не понимает, что произошло;
- в логах есть `pack.reject`, но в чате явного объяснения нет;
- во время `generating_pack_preview` и `processing_pack` пользователь продолжает нажимать старые кнопки;
- увеличивается число повторных кликов и ошибочных действий.

---

## 2. Цель

Сделать UX предсказуемым: каждый клик должен давать ясный и быстрый ответ:

1. что сейчас происходит;
2. почему действие недоступно;
3. что сделать дальше.

---

## 3. UX-принципы

1. **Мгновенный отклик:** любой callback подтверждается сразу (`answerCbQuery`).
2. **Явное сообщение об ошибке состояния:** для `wrong_state` и `stale_callback` использовать заметный формат (`show_alert: true`).
3. **Один активный экран:** на processing-шаге активные кнопки заменяются на "ожидание" (и опционально "отмена").
4. **Действие вместо тупика:** при stale/reject пользователь получает подсказку, куда вернуться.
5. **Идемпотентность UX:** повторные клики не запускают новую работу и не создают ощущение "бот завис".

---

## 4. Матрица состояний и допустимых действий (pack)

| Состояние | Допустимые кнопки | Недопустимые кнопки | UX-реакция на недопустимые |
|---|---|---|---|
| `wait_pack_carousel` | `pack_carousel_prev`, `pack_carousel_next`, `pack_try`, `pack_cancel` | `pack_preview_pay`, `pack_approve`, `pack_regenerate` | alert: "Сначала выбери набор поз и нажми Попробовать" |
| `wait_pack_preview_payment` | `pack_preview_pay`, `pack_back_to_carousel`, `pack_cancel`, `pack_new_photo`, `pack_keep_photo` | `pack_approve`, `pack_regenerate` | alert: "Сначала запусти превью" |
| `generating_pack_preview` | `noop` (и опционально `pack_cancel`) | все action-кнопки preview/approve/regenerate/back | alert: "Идет генерация превью, подожди 10-20 сек" |
| `wait_pack_approval` | `pack_approve`, `pack_regenerate`, `pack_back`, `pack_cancel`, `pack_new_photo`, `pack_keep_photo` | `pack_preview_pay`, carousel кнопки | alert: "Сейчас доступно: одобрить или перегенерировать" |
| `processing_pack` | `noop` (и опционально `pack_cancel`) | approve/regenerate/back/preview | alert: "Собираю стикерпак, это может занять до минуты" |
| `canceled` | вход в flow заново | любые callback из старого экрана | alert: "Сессия завершена, начни заново через Создать пак" |

---

## 5. Требования к callback-feedback

### 5.1 Базовый паттерн

- в начале callback: `safeAnswerCbQuery(ctx, "…")` с коротким статусом;
- при reject:
  - `wrong_state` -> `show_alert: true`, понятный next-step текст;
  - `stale_callback` -> `show_alert: true`, просьба использовать последнее сообщение;
  - `session_not_found` -> `show_alert: true`, подсказка "нажми Создать пак".

### 5.2 Стандартизированные тексты

RU:
- stale: "Эта кнопка устарела. Используй последнее сообщение."
- wrong state (preview): "Сейчас этот шаг недоступен. Дождись завершения текущего процесса."
- processing: "Идет генерация, подожди немного."

EN:
- stale: "This button is stale. Please use the latest message."
- wrong state: "This action is unavailable at the current step."
- processing: "Generation is in progress. Please wait."

---

## 6. Lock клавиатуры во время processing

Когда session переходит в:

- `generating_pack_preview`
- `processing_pack`

нужно редактировать текущее UI-сообщение и оставлять только:

- `⏳ Generating...` (noop)
- опционально `Cancel` (если отмена безопасна и не ломает биллинг)

Это убирает "ложные" клики по устаревшим кнопкам и резко снижает `wrong_state/stale_callback`.

---

## 7. Stale-card recovery UX

Для `stale_callback` добавить мягкий recovery:

1. Показать alert "кнопка устарела";
2. При необходимости отправить короткое сообщение:
   - "Открой актуальную карточку";
3. Дать кнопку "Обновить экран", которая ререндерит текущий шаг по актуальной session.

---

## 8. Работа с `session_rev`

`session_rev` остается источником защиты от двойных кликов и гонок.

UX-правило:

- stale reject — это нормальный сценарий, не "ошибка сервера";
- stale всегда сопровождается понятным пользовательским сообщением (не тихий toast).

---

## 9. Логирование и наблюдаемость

Добавить агрегацию/метрики:

- `pack.reject` count by `reasonCode` (`wrong_state`, `stale_callback`, `session_not_found`);
- количество кликов на кнопку в processing-state;
- доля успешных переходов:
  - `wait_pack_preview_payment -> generating_pack_preview`
  - `wait_pack_approval -> processing_pack`

Целевые KPI после hardening:

- `wrong_state` и `stale_callback` в 2-3 раза ниже;
- меньше повторных кликов в первые 5 секунд после запуска preview;
- меньше пользовательских жалоб "кнопки не работают".

---

## 10. План внедрения

### Этап A (быстрый UX-фикс)

- в reject-handler для pack включить `show_alert: true`;
- унифицировать тексты для stale/wrong-state;
- в начале критичных callback отдавать "Запускаю..." / "В процессе...".

### Этап B (UI lock)

- при переходе в `generating_pack_preview` и `processing_pack` редактировать клавиатуру в lock-вид.

### Этап C (recovery)

- добавить кнопку "Обновить экран" для stale-сценариев.

### Этап D (доработка роутера)

- минимизировать fallback на `is_active=false` для callback-flow;
- использовать flow-specific session resolve как основной путь.

---

## 11. Тест-план (smoke)

1. На `wait_pack_preview_payment` нажать `pack_preview_pay` 2-3 раза подряд:
   - только один реальный запуск;
   - остальные клики получают понятный feedback.
2. Во время `generating_pack_preview` нажать `back/preview/approve`:
   - понятный alert "идет генерация".
3. Нажать старую кнопку из предыдущего сообщения:
   - alert "кнопка устарела", без "тишины".
4. После завершения preview нажать `approve`:
   - переход в `processing_pack`, клавиатура lock-режима.
5. Проверить логи:
   - reject есть, но пользовательский UX понятный и консистентный.

---

## 12. Критерии приемки

1. Пользователь всегда получает видимый ответ на клик (нет "тихих" зависаний).
2. Во время processing активные конфликтующие кнопки не доступны.
3. Stale-кнопки ведут к понятному recovery-пути.
4. Количество `pack.reject` по `wrong_state/stale_callback` снижается после релиза.

