# FINAL REQUIREMENTS — Interactive Sticker Pack Generation (v2)

**Дата:** 26.02.2026  
**Статус:** Обязательные требования (post-log optimizations)  
**Связано:** `docs/pack-batch-flow-9-scenes-rules.md` (правила текущего флоу 9 сцен), `docs/20-02-interactive-pack-scene-by-scene.md`, `docs/26-02-pack-agents-slim-context-tz.md`, `src/lib/pack-multiagent.ts`

Все требования ниже **обязательны**, не рекомендации.

---

## 1. Architectural Decision

### Agents
Оставляем **те же** агенты:
- Brief & Plan
- Captions
- Scenes
- Critic

❌ Новых креативных агентов нет  
❌ Нет SceneProposer / TasteAgent  
❌ Нет LLM-разбора фидбека пользователя  

### Modes
Агенты работают в разных **режимах**:

```
MODE = batch | interactive_init | interactive_update | single_scene
```

Агенты не меняются; меняются только mode и контракты.

---

## 2. Pack DNA (Core Concept)

### Definition
**Pack DNA** — неизменяемый стиль и визуальная идентичность пака. Генерируется один раз, переиспользуется везде.

### Pack DNA включает
- tone
- awkward_level (low | medium | high)
- energy_range
- outfit (или "none")
- environment
- framing (всегда chest_up)
- background (всегда simple)
- **moment_pool** (НЕ сцены — короткие описания моментов)

### Свойства Pack DNA
- **НЕ** показывается пользователю
- **НЕ** регенерируется под каждую сцену
- Обновляется **только** через контролируемые taste deltas

---

## 3. Interactive Flow (Scene-by-Scene)

### Step 0 — interactive_init
- Вызвать **Brief & Plan** один раз.
- Выход:
  - **Pack DNA**
  - **moment_pool** (9 коротких описаний моментов, без сцен)
- Сохранить Pack DNA в состоянии.

### Step 1 — single_scene
- Вызвать **Scenes** с:
  - Pack DNA
  - **ОДИН** неиспользованный момент
  - used_body_patterns
  - used_moments
- Выход:
  - **РОВНО ОДНА** scene description (EN ONLY)
  - **РОВНО ОДНА** caption
- Показать пользователю сразу.
- ⏱ Цель: **< 10 секунд** до первой сцены.

### Step 2 — User Feedback (NO LLM)
Действия пользователя:
- Approve
- Regenerate
- Adjust taste (кнопки, не свободный текст)

Фидбек маппится в коде в **Taste Delta**:
```json
{
  "awkward_level": "+1 | -1",
  "energy": "+1 | -1"
}
```

### Step 3 — interactive_update
- Вызывать **Brief & Plan** ТОЛЬКО если скорректирован taste.
- Правила:
  - Обновлять **только** mutable taste-поля
  - **НИКОГДА** не менять: outfit, environment, framing, уже одобренные сцены

### Step 4 — Commit Scene
При одобрении:
- Зафиксировать сцену
- Пометить момент как used
- Пометить body pattern как used
- Повторять до 9 сцен.

---

## 4. Правила агентов и общие требования (batch: 9 сцен)

Правила для агентов **Scenes**, **Captions**, **Critic**, требования по токен-эффективности, риск-менеджменту, non-goals и критериям успеха для **текущего batch-флоу (9 сцен)** вынесены в отдельный документ:

→ **`docs/pack-batch-flow-9-scenes-rules.md`**

В интерактиве:
- **Scenes** и **Captions** в режиме single выдают одну сцену и одну подпись; правила по языку (EN only), длине (12–18 words / 15–20 chars) и запретам те же.
- **Critic** в интерактиве не вызывается; валидация в коде (длина, `{subject}`, количество).

---

# Анализ: что делать на нашей стороне (интерактив)

Ниже — привязка к коду и список работ для **интерактивного** режима.

---

## A. Архитектура и режимы (раздел 1)

| Требование | Как сейчас | Что делать |
|------------|------------|------------|
| Те же агенты (Brief & Plan, Captions, Scenes, Critic) | ✅ Реализовано в `pack-multiagent.ts` | Ничего |
| MODE = batch \| interactive_init \| interactive_update \| single_scene | Режимов нет; один пайплайн `runPackGenerationPipeline` (batch) | 1) Ввести тип/enum `PackAgentMode` и передавать mode в вызовы агентов. 2) В `runPackGenerationPipeline` передавать `batch`. 3) Для интерактива — отдельная точка входа (функция/хендлер), которая передаёт `interactive_init` / `interactive_update` / `single_scene`. |

**Действия:** добавить `PackAgentMode` в типы; расширить сигнатуры агентов (или обёрток) параметром `mode`; оставить batch как default.

---

## B. Pack DNA и moment_pool (раздел 2)

| Требование | Как сейчас | Что делать |
|------------|------------|------------|
| Pack DNA (tone, awkward_level, energy_range, outfit, environment, framing, background, moment_pool) | Есть только результат Brief & Plan: brief + plan (moments, tone, name_ru, …). Нет отдельной сущности «Pack DNA» и нет полей awkward_level, energy_range, moment_pool как отдельного списка с risk. | 1) Ввести тип `PackDNA` и маппинг из выхода Brief & Plan (interactive_init) в Pack DNA. 2) Добавить в brief/plan или в отдельную структуру: awkward_level, energy_range; moment_pool = 9 моментов с опциональным risk (safe/medium/awkward). 3) Хранить Pack DNA в состоянии сессии (БД или in-memory для интерактива). |
| Pack DNA не показывать пользователю, не регенерировать под сцену | — | Реализовать в UX и в потоке: Pack DNA не уходит во фронт/бот; при single_scene передаём только нужный минимум в Scenes. |
| Обновление Pack DNA только через taste deltas | — | При interactive_update вызывать Brief & Plan с контрактом «только taste-поля»; в коде мержить delta в Pack DNA без перезаписи outfit, environment, уже одобренных сцен. |

**Действия:** типы Pack DNA и moment_pool; маппинг Brief & Plan → Pack DNA; хранение в сессии; контракт interactive_update (только mutable taste).

---

## C. Interactive flow (раздел 3)

| Шаг | Как сейчас | Что делать |
|-----|------------|------------|
| Step 0 — interactive_init | Нет | 1) Хендлер/кейс «старт интерактивного пака»: один вызов Brief & Plan с mode=interactive_init. 2) Парсить ответ в Pack DNA + moment_pool. 3) Сохранить в session (таблица sessions или отдельная таблица pack_sessions / pack_dna). |
| Step 1 — single_scene | Scenes вызывается на полный plan (9 моментов), возвращает 9 сцен. Captions — 9 подписей. | 1) Режим Scenes `single_scene`: вход — Pack DNA + один момент + used_body_patterns + used_moments; выход — одна строка scene_descriptions[0] (EN). 2) Режим Captions «одна подпись»: вход — один момент + tone; выход — одна caption (labels[0], labels_en[0]). 3) Валидация в коде (длина, {subject}); при ошибке — повторный вызов с «Make it clearly different» или аналог. 4) Цель <10 с — минимизировать вход (flat contract), не дергать Critic. |
| Step 2 — User feedback, NO LLM | Нет интерактивного UI | 1) Кнопки: Approve / Regenerate / Adjust taste. 2) Маппинг в Taste Delta в коде (например +1/-1 по awkward_level, energy). Без вызова LLM. |
| Step 3 — interactive_update | Нет | Вызывать Brief & Plan с mode=interactive_update только при Adjust taste; вход — текущий Pack DNA + taste_delta; обновлять только mutable поля; не трогать outfit, environment, одобренные сцены. |
| Step 4 — Commit scene | Нет | При Approve: сохранить сцену и подпись; пометить момент и body_pattern как used; перейти к следующему моменту или завершить пак (9/9). |

**Действия:** реализовать пошаговый сценарий в боте (состояния, кнопки, вызовы агентов по шагам); БД или session-поля для used_moments, used_body_patterns, одобренных сцен.

---

## D. Scenes / Captions в single_scene

В режиме single: одна сцена (EN only), одна подпись; правила как в `pack-batch-flow-9-scenes-rules.md`. Отдельный промпт/блок для single_scene (EN only, 12–18 words, Forbidden); валидация длины и `{subject}` в коде.

---

## E. Critic и валидация в интерактиве

Critic в интерактивном потоке не вызывать. Валидация в коде: длина подписи 15–20, в сцене ровно один `{subject}`. При провале — regenerate только этой сцены/подписи.

---

## F. Token efficiency и risk в интерактиве

Использовать те же принципы slim/flat, что и в batch; при Regenerate — только Scenes+Captions для одной сцены. Risk (safe/medium/awkward): расширить контракт interactive_init, выбирать первые 1–2 сцены только из safe/medium.

---

## G. Порядок внедрения (интерактив)

1. Типы и режимы — PackAgentMode, PackDNA, moment_pool с risk.
2. Хранение — сессия интерактивного пака (Pack DNA, used_moments, used_body_patterns).
3. Step 0 — хендлер interactive_init; Step 1 — single_scene (Scenes + Captions на 1 момент); валидация в коде.
4. UI — кнопки Approve / Regenerate / Adjust taste; Taste Delta без LLM.
5. Step 3–4 — interactive_update при Adjust taste; commit сцены при Approve; выбор следующего момента по risk.
6. Промпты single_scene; Critic не вызывать в интерактиве.

Правила агентов для текущего флоу (9 сцен) и привязка к коду batch — в **`docs/pack-batch-flow-9-scenes-rules.md`**.
