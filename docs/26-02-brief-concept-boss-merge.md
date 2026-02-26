# Бриф: объединение Concept + Boss в одного агента «Brief & Plan»

**Дата:** 26.02.2026  
**Статус:** Бриф для реализации  
**Связано:** `docs/26-02-pack-agents-simplify-merge-options.md`, `src/lib/pack-multiagent.ts`

---

## 1. Цель

Заменить два последовательных вызова (Concept → Boss) одним вызовом агента **Brief & Plan**: на входе запрос пользователя и subject_type, на выходе — один JSON с полями брифa и плана. Без изменения контракта для Captions, Scenes, Critic и без изменения логики rework.

**Результат:** 4 агента вместо 5, 3 round-trip’а вместо 4 в первом проходе пайплайна.

---

## 2. Контракт

### 2.1. Вход

- `request: string` — текст запроса пользователя (тема пака).
- `subjectType: SubjectType` — `single_male` | `single_female` | `couple` | `unknown` (контекст фото).

### 2.2. Выход (один JSON)

Модель возвращает один объект, содержащий **и** поля брифa (как у Concept), **и** поля плана (как у Boss). Варианты структуры:

**Вариант A (плоский объект):** все ключи в одном уровне. Поля брифa: `subject_type`, `setting`, `persona`, `tone`, `timeline`, `situation_types`, `shareability_hook`, `title_hint`, `visual_anchors`. Поля плана: `id`, `pack_template_id`, `subject_mode`, `name_ru`, `name_en`, `carousel_description_ru`, `carousel_description_en`, `mood`, `sort_order`, `segment_id`, `story_arc`, `tone` (может дублировать brief), `day_structure` (optional), `moments`.

**Вариант B (вложенный):** `{ brief: ConceptBrief, plan: BossPlan }` — два блока, парсим и передаём `plan` дальше по пайплайну; при необходимости из `brief` можно брать поля для совместимости.

**Рекомендация:** Вариант A (плоский) — проще описать в промпте («output one JSON with keys: …») и один раз распарсить. При парсинге из плоского объекта собираем `ConceptBrief` и `BossPlan` для существующих типов (если где-то ещё нужен brief) или сразу передаём в Assembly только plan; brief внутри пайплайна после merge по сути не используется, нужен только plan для Captions/Scenes.

Уточнение: downstream используют только **plan** (BossPlan). Brief нужен был только как вход для Boss. Поэтому минимально достаточно, чтобы модель возвращала объект, из которого мы извлекаем **BossPlan** (id, name_ru/en, moments[9], carousel_*, mood, segment_id, story_arc, tone, day_structure, subject_mode, pack_template_id, sort_order). Поля брифa (setting, persona, situation_types, shareability_hook, title_hint, visual_anchors) могут быть в том же JSON для согласованности и отладки, но пайплайн после merge использует только план. То есть контракт вывода: **один JSON с полями плана (обязательно) и полями брифa (обязательно для одного шага генерации, чтобы модель «держала» контекст темы и моментов)**.

### 2.3. Типы в коде

- Ввести тип `ConceptAndPlan` = пересечение/объединение полей `ConceptBrief` и `BossPlan` (или явно `{ brief: ConceptBrief; plan: BossPlan }` при выборе варианта B).
- Функция `runConceptAndPlan(request, subjectType): Promise<ConceptAndPlan>` возвращает один объект. Пайплайн из него берёт `plan` и передаёт в Captions и Scenes; при необходимости передаёт `brief` в логи или метрики (или не использует).

---

## 3. Промпт (системный)

Один системный промпт, объединяющий текущие CONCEPT_SYSTEM и BOSS_SYSTEM.

**Структура:**

1. **Role** — одна фраза: интерпретировать запрос в концепт пака и сразу развернуть его в план из 9 моментов одного дня.
2. **Part 1 — Concept (Brief):**  
   - Core Rules (один день, одна тема; моменты, а не активности; конкретные ситуации; не описывать позы/сцены/внешность).  
   - Costume Lock (CRITICAL): если роль по одежде узнаваема — один фиксированный outfit на весь пак; иначе Outfit: none.  
   - Human Imperfection (MANDATORY): одно человеческое напряжение, не сглаживать.
3. **Part 2 — Plan (Boss):**  
   - Planning Rules: 9 разных моментов, один день и среда; без идеальной дуги; баланс calm/awkward/tense/overreactive.  
   - Anti-Postcard Rule (CRITICAL): минимум 2 момента явно неудобные/саморазоблачающие/неловкие; не приукрашивать.
4. **OUTPUT (STRICT):** один JSON со всеми ключами. Список ключей: сначала поля брифa (subject_type, setting, persona, tone, timeline, situation_types, shareability_hook, title_hint, visual_anchors), затем поля плана (id, pack_template_id, subject_mode, name_ru, name_en, carousel_description_ru, carousel_description_en, mood, sort_order, segment_id, story_arc, tone, day_structure (optional), moments).  
   - moments: ровно 9 строк, каждая 8–10 слов.  
   - Без пояснений, без прозы.

Имена констант в коде: например `BRIEF_AND_PLAN_SYSTEM`. User message: `User request: ${request}\n\nPhoto context (subject_type): ${subjectType}\n\nOutput the combined brief and plan as a single JSON.`

---

## 4. Изменения в коде

| Место | Действие |
|-------|----------|
| Типы | Добавить `ConceptAndPlan` (плоский объект с полями brief + plan или один объект с общими полями). При плоском варианте — тип = пересечение полей ConceptBrief и BossPlan. |
| Промпт | Добавить константу `BRIEF_AND_PLAN_SYSTEM` (объединённый текст Concept + Boss + один OUTPUT). |
| Модель | Один вызов OpenAI для Brief & Plan. Модель брать из app_config: новый ключ `pack_openai_model_brief_and_plan` **или** переиспользовать `pack_openai_model_concept` (и удалить использование `pack_openai_model_boss`). Рекомендация: ввести один ключ `pack_openai_model_brief_and_plan`, в миграции/доках добавить его в app_config; старые ключи concept/boss можно оставить в таблице, но не использовать для этого пайплайна, либо удалить из кода. |
| Функции | Добавить `runConceptAndPlan(request, subjectType): Promise<ConceptAndPlan>`. Внутри: getModelForAgent("brief_and_plan"), один вызов openAiChatJson с BRIEF_AND_PLAN_SYSTEM и user message, max_tokens суммарно (например 1536 или 2048). Из ответа собрать plan (и при необходимости brief) и вернуть. |
| Пайплайн | В `runPackGenerationPipeline`: заменить вызовы `runConcept` и `runBoss` на один `runConceptAndPlan`. Получить из результата `plan`; передать в `runCaptions(plan)` и `runScenes(plan)`. Убрать `onProgress?.("concept")` и `onProgress?.("boss")`, оставить один шаг, например `onProgress?.("brief_and_plan")`. |
| app_config / ключи | Добавить в `PACK_AGENT_APP_CONFIG_KEYS` ключ `brief_and_plan: "pack_openai_model_brief_and_plan"`. Удалить из пайплайна использование concept и boss; при желании оставить ключи в константе для обратной совместимости или удалить concept и boss из ключей. |
| Лимит токенов | Для одного вызова Brief & Plan задать `maxTokens` (например 2048), т.к. вывод = brief (~300–400 токенов) + plan (~400–800). Константа типа `PACK_AGENT_MAX_TOKENS_BRIEF_AND_PLAN = 2048`. |

---

## 5. Критерии приёмки

- [ ] Один вызов OpenAI вместо двух (Concept + Boss) в первом проходе пайплайна.
- [ ] Пайплайн возвращает такой же по структуре `plan` для Captions/Scenes/Assembly/Critic; rework не меняется.
- [ ] Системный промпт объединяет правила Concept и Boss без противоречий; OUTPUT — один JSON со всеми нужными полями.
- [ ] В app_config используется один ключ модели для Brief & Plan; в коде нет вызовов runConcept/runBoss из пайплайна (функции можно оставить для тестов или удалить).
- [ ] Документация: обновить описание пайплайна (4 агента), при необходимости `pack-multiagent-requirements.md` и `pack-agent-prompts-final.md`.

---

## 6. Риски и откат

- **Риск:** модель «размазывает» качество между брифом и планом (например, моменты станут слабее). **Митигация:** чёткий OUTPUT с явным списком полей и лимитом на моменты (9 штук, 8–10 слов); после внедрения прогнать несколько паков и сравнить с текущим поведением.
- **Откат:** вернуть в пайплайне вызовы `runConcept` и `runBoss`, отключить или удалить `runConceptAndPlan` и ключ `brief_and_plan`.
