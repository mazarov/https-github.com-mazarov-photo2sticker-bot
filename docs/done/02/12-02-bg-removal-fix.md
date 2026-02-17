# Улучшение удаления фона стикеров

**Дата:** 2026-02-12
**Статус:** Спецификация

---

## Проблема

При генерации стикеров (особенно в стилях с характерным тёмным фоном — Love Is, аниме и др.) фон удаляется плохо:

1. **Gemini игнорирует инструкцию про зелёный фон** — вместо `#00FF00` рисует каноничный фон стиля (тёмно-синий для Love Is, градиенты для аниме)
2. **rembg с моделью `u2netp` слишком слабая** — не отделяет тёмный фон от тёмных элементов (волосы, тени)
3. **Зелёные артефакты** — когда Gemini частично нарисовал зелёный фон, rembg не делает chroma key и оставляет зелёные полосы

## Решение

### 1. Усилить промпт про зелёный фон

**Проблема:** Инструкция `Background: Solid bright green (#00FF00)` стоит в середине промпта и часто игнорируется моделью, особенно когда стиль подразумевает определённый фон.

**Фикс:** Перенести требование зелёного фона в конец промпта (LLM-модели уделяют больше внимания началу и концу) и усилить формулировку:

```
CRITICAL REQUIREMENT: The background MUST be a solid uniform bright green color (#00FF00). 
Do NOT use any other background color regardless of the style. 
This is essential for automated background removal.
The entire area behind the character(s) must be filled with exactly #00FF00 green.
```

**Где менять:**
- `prompt_templates` в БД (emotion, motion, text шаблоны)
- `buildAssistantPrompt()` в `index.ts` (assistant flow)
- `prompt_generator` agent system_prompt в БД (style generation)

### 2. Переключить модель rembg: `u2netp` → `u2net`

**Проблема:** `u2netp` — лёгкая модель (4.7MB), оптимизирована для скорости, но плохо справляется со сложными случаями (тёмный фон, мелкие детали вроде сердечек).

**Фикс:** Переключить на `u2net` — полная модель (176MB):
- Точность значительно выше
- Латентность +200-300ms (было ~450ms, будет ~650-750ms)
- Размер Docker-образа увеличится на ~170MB

**Где менять:**
- `rembg_server.py` — строка 20: `new_session("u2netp")` → `new_session("u2net")`
- `Dockerfile.rembg.build` — строка 20: pre-download `u2net` вместо `u2netp`
- Health check endpoint — обновить model name

**Альтернативы:**
| Модель | Размер | Латентность | Качество |
|--------|--------|-------------|----------|
| `u2netp` (текущая) | 4.7MB | ~450ms | Средне |
| `u2net` | 176MB | ~650ms | Хорошо |
| `isnet-general-use` | 176MB | ~700ms | Отлично |

Рекомендация: `u2net` как оптимальный баланс качества и скорости.

### 3. Chroma key post-processing (дополнительно)

Когда Gemini рисует зелёный фон, а rembg оставляет артефакты (особенно за шарами, между рукой и фоном) — добавить проход: пиксели близкие к #00FF00 → прозрачность.

Спецификация: **docs/chroma-key-cleanup.md**

---

## Чеклист

- [ ] Обновить `prompt_templates` в БД: emotion, motion, text — добавить CRITICAL блок в конец
- [ ] Обновить `buildAssistantPrompt()` в `index.ts`
- [ ] Обновить `rembg_server.py`: `u2netp` → `u2net`
- [ ] Обновить `Dockerfile.rembg.build`: pre-download `u2net`
- [ ] Пересобрать и запушить Docker-образ rembg
- [ ] Тест на test-окружении
- [ ] Деплой в продакшн
