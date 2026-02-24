# Тестовые миграции паков (pack_content_sets_test)

В этой папке лежат миграции, которые вставляют или обновляют контент паков в таблице **pack_content_sets_test** (тестовое окружение). На проде не запускать.

- Один файл = один пак или один батч паков.
- Нумерация: следующий свободный номер после последнего файла (напр. после `133_test_...sql` → `134_test_название_v1.sql`).
- Схема полей — как в `pack_content_sets` (см. docs/pack-multiagent-requirements.md, раздел 1).
- Генерация новых паков через агентов (Cursor rules) — см. docs/pack-multiagent-requirements.md и .cursor/rules/pack-*.mdc.

Схемные миграции (создание таблицы, ALTER и т.д.) остаются в `sql/` (например 095_pack_content_sets_test.sql).
