# Требования: refactor `/start` (assistant -> pack entry)

**Дата:** 17.02.2026  
**Статус:** proposed  
**Связано:** [17-02-pack-main-entry-and-auto-start.md](17-02-pack-main-entry-and-auto-start.md), [architecture/01-api-bot.md](architecture/01-api-bot.md)

---

## 1. Контекст

Сейчас `/start` запускает `startAssistantDialog`, который открывает assistant flow.

Новая продуктовая цель: базовый вход пользователя в генерацию должен идти через pack flow.

---

## 2. Фаза 1 (в рамках текущего релиза)

Временно отключить запуск `startAssistantDialog` в обработчике `/start` и переключить `/start` на pack-entry.

Ограничения фазы:

- deep-link `val_*` сохраняет текущий специальный сценарий и имеет приоритет;
- логику assistant-хендлеров и `startAssistantDialog` не удаляем (только перестаем вызывать из `/start`);
- поведение кнопки `✨ Создать стикер` не меняем в этом документе (она регулируется отдельным требованием по меню).

---

## 3. Фаза 2 (отдельная доработка после стабилизации)

Спроектировать и внедрить новую роль assistant в продукте:

- assistant как post-pack инструмент (например, идеи/доработки после первого шага);
- или assistant как отдельный явный entrypoint вне `/start`.

До этой фазы assistant не должен быть default-входом для новых/returning пользователей.

---

## 4. Технические требования (фаза 1)

1. В `bot.start` заменить ветку `startAssistantDialog(...)` на вызов pack-entry функции.
2. Сохранить существующие anti-duplicate механики (`session_id`, `session_rev`, reject stale callbacks).
3. Сохранить текущие deep-link ветки (`val_*`) без изменений.
4. Добавить логирование переключения entrypoint (например, `start_entry=pack`).

---

## 5. Тест-план (smoke)

1. `/start` нового пользователя -> открывается pack flow.
2. `/start` returning пользователя -> открывается pack flow.
3. `/start val_*` -> работает текущий special-flow без регрессии.
4. Кнопки/обработчики assistant не ломаются при прямом вызове.

---

## 6. Критерии приемки

1. `/start` больше не вызывает `startAssistantDialog`.
2. Основной пользовательский вход проходит через pack-entry.
3. Deep-link `val_*` работает как раньше.

