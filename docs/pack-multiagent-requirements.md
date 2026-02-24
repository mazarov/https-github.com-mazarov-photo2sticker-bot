# Требования: мультиагентная генерация паков стикеров

Документ описывает систему агентов для генерации спецификаций паков в едином формате и правила качества (STICKER PACK MASTER SYSTEM).

**Цель продукта:** по абстрактному запросу пользователя (например «офисный юмор», «бытовые ситуации») получать продуманный пак из 9 сцен **одного дня** в заданной теме, который хочется отправить друзьям (виральный, shareable).

---

## 0. Критический разбор и архитектурные улучшения

Ниже — что стоит улучшить в текущей схеме и какие роли добавить, чтобы закрыть разрыв между «абстрактный запрос» и «виральный пак одного дня».

### 0.1. Проблемы текущей схемы

| Проблема | Сейчас | Нужно для цели |
|----------|--------|-----------------|
| **Абстрактный ввод** | Вход в Boss — уже «название пака» (конкретика). Нет шага от «офисный юмор» к концепции. | Явный слой: абстрактный запрос → конкретный бриф (сеттинг, персона, тон, хуки). |
| **Один день** | Есть «микро-история» и прогрессия, но нет жёсткой привязки к **одному дню** (утро → день → вечер). | 9 сцен = 9 якорных моментов одного дня; опционально разметка по времени (утро/день/вечер). |
| **Виральность** | Recognizability и «would use» есть в чеклисте, но нет критериев **шеринга**: «захочется ли отправить паку другу как „это буквально мой день“?» | Явные критерии shareability и опциональный агент-критик по виральности. |
| **Один Boss = один сценарий** | Один ответ Boss — один пак. Нет разнообразия при одном запросе. | Вариант: Boss (или слой выше) генерирует 2–3 концепта, выбор лучшего или пользователем. |
| **Согласованность сцен** | Scenes генерируют 9 кадров по плану, но без явного требования «тот же тип персонажа/сеттинг». | Единый сеттинг и континуити в scene_descriptions (один день, одна среда, один «я»). |

### 0.2. Предлагаемые роли агентов (расширенная схема)

| Агент | Вход | Выход | Зачем |
|-------|------|--------|--------|
| **Concept / Interpreter** | Абстрактный запрос пользователя + **контекст фото** (кол-во людей, пол людей → subject_type: single/couple и т.д.) | Структурированный бриф: setting, persona, tone, timeline=one_day, 3–5 ключевых типов ситуаций, shareability_hook, **subject_type** (согласованный с фото). | Превращает запрос в бриф для Boss; **концепт подходит под персонажа(ов) на фото** (один человек — один герой, пара — сцены про пару). |
| **Boss (Pack Planner)** | Бриф от Concept (не сырой запрос) | План пака: id, name_ru/en, carousel, mood, **day_structure**, story_arc, tone, 9 моментов, **subject_mode** и pack_template_id по контексту фото. | Не придумывает тему с нуля — разворачивает бриф в «один день» и 9 моментов под того же персонажа(ов). |
| **Captions** | План от Boss (с контекстом «один день») | 9 labels RU + 9 labels EN. | Без изменений по сути; контекст «день» улучшает связность подписей. |
| **Scenes** | План + (опционально) labels | 9 scene_descriptions с {subject}, единый сеттинг и континуити. | Явное требование: один день, одна среда, один персонаж; визуальная согласованность. |
| **Critic / Virality** (опционально) | Готовая спека пака (план + labels + scenes) | pass/fail + короткие рекомендации: «Would someone send this to a friend?», «Is the one-day arc clear?», «Any caption too generic?». | Проверка виральности и связности «один день»; при fail — повтор Captions/Scenes или правка плана. |

Итого: **Concept** добавляется перед Boss; **Boss** получает бриф и выдаёт план с **day_structure**; **Captions** и **Scenes** без смены ролей, но с усиленным контекстом «один день» и консистентностью; **Critic** — опциональный финальный шаг для виральности.

### 0.3. Один день как контракт

- **Boss** в выходном JSON должен отдавать либо явное поле `day_structure`, например: `["morning", "morning", "morning", "midday", "midday", "midday", "evening", "evening", "evening"]`, либо короткие тайм-метки в описании каждого из 9 моментов (например «утро, первый кофе», «обед, звонок с совещания»).
- **Captions** и **Scenes** в промптах получают формулировку: «Эти 9 стикеров — 9 моментов одного дня в порядке времени; сохраняйте непрерывность дня и одну среду (офис/дом/удалёнка).»
- Это даёт понятный продуктовый месседж: «Мой день в стикерах» и повышает shareability («это же про меня весь день»).

### 0.4. Виральность: что зашить в критерии

- **Relatability:** «Узнаю себя» в конкретной роли (офисный, родитель, фрилансер, утро кофеманьяка).
- **Share moment:** Стикерпак как способ сказать «смотри, это же мы» или «мой день в трёх кадрах» — т.е. повод отправить паку другу/чату.
- **Hook:** Один короткий тезис пака, который можно написать в карточке (carousel_description) и по которому сразу ясно «про что» и «для кого».
- **Consistency:** Один день, один тон, одна среда — без размывания, чтобы пака воспринималась цельной историей.

Эти пункты можно добавить в чеклист (раздел IX) и в промпт Critic-агента.

### 0.5. Порядок вызовов (обновлённый)

1. **Concept:** user query (абстрактный) → structured brief.
2. **Boss:** brief → pack plan с day_structure и 9 моментами.
3. **Captions:** plan → labels, labels_en.
4. **Scenes:** plan (+ labels) → scene_descriptions.
5. **Сборка:** как раньше.
6. **Critic (опционально):** полная спека → pass/fail + рекомендации; при fail — итерация по Captions/Scenes или уточнение брифa/Boss.

Параллелить Captions и Scenes после Boss можно для скорости, но тогда Scenes не видят подписи; для виральности и связности предпочтительнее последовательный порядок (Captions → Scenes), чтобы сцены могли опираться на подписи.

### 0.6. Контекст: фото пользователя

У пайплайна есть **контекст** — фото, которое пользователь загрузил для генерации стикеров. По этому фото мы умеем определять:

- **Количество людей** на фото (один человек / двое / больше).
- **Пол людей** (мужской / женский; при нескольких людях — пол каждого или «пара мужчина+женщина» и т.д.).

**Концепт и весь пак должны подходить под персонажа(ов) на фото.** То есть:

- Если на фото **один человек** (мужчина или женщина) — бриф и план строятся под одного героя: persona, сцены, подписи от одного лица; `subject_mode` = single, `pack_template_id` — соответствующий одиночному шаблону.
- Если на фото **двое** (например пара) — концепт может быть про пару, общий день, «мы»; `subject_mode` = couple, сцены с двумя персонажами или общим контекстом пары; `pack_template_id` = couple_v1 и т.д.

Concept получает на вход не только абстрактный запрос, но и **контекст фото**: число людей и пол (или готовый `subject_type`: single_male, single_female, couple, …). Бриф (persona, setting, situation_types) должен быть согласован с этим контекстом: не предлагать «утро папы с ребёнком», если на фото один взрослый без ребёнка; не предлагать «пара в отпуске», если на фото один человек. Boss и остальные агенты тогда получают план, завязанный на того же персонажа(ов), что и на фото — так пак визуально и по смыслу соответствует пользователю.

---

## 1. Целевой формат выхода (= pack_content_sets)

Формат выхода пайплайна — **текущая схема таблицы `pack_content_sets`** (и `pack_content_sets_test` для тестовых паков). Все поля, которые генерируют агенты или сборка, должны совпадать с этой схемой.

### Колонки таблицы pack_content_sets

| Колонка | Тип | Кто заполняет | Описание |
|---------|-----|----------------|----------|
| id | text (PK) | Boss | Slug пака (snake_case), напр. `affection_solo_v31`, `everyday_home_chaos_sitcom30_v1` |
| pack_template_id | text | Boss | Шаблон по контексту фото: напр. `couple_v1` (для single и couple может быть один шаблон в зависимости от продукта) |
| name_ru | text | Boss | Название пака (RU) |
| name_en | text | Boss | Название пака (EN) |
| carousel_description_ru | text | Boss | Короткое описание для карусели (RU) |
| carousel_description_en | text | Boss | Короткое описание для карусели (EN) |
| labels | jsonb | Captions | Массив из 9 строк (RU) — подписи под стикеры |
| labels_en | jsonb | Captions | Массив из 9 строк (EN) — подписи под стикеры |
| scene_descriptions | jsonb | Scenes | Массив из 9 строк; каждая — описание кадра с плейсхолдером `{subject}` |
| sort_order | int | Boss | Порядок в карусели |
| is_active | boolean | Сборка | Обычно `true` |
| mood | text | Boss | Напр. `everyday`, `affection`, `reactions`, `sarcasm` |
| created_at | timestamptz | БД / Сборка | Обычно `now()` при INSERT |
| sticker_count | int | Сборка | Всегда `9` |
| subject_mode | text | Boss | `single` или `couple` — по контексту фото |
| cluster | boolean | Сборка | Обычно `false` |
| segment_id | text | Boss / Сборка | Сегмент карусели, напр. `affection_support`, `home` |

### Пример одной строки (пак «Нежность», affection_solo_v31)

Реальный пример из `pack_content_sets`:

| Поле | Значение |
|------|----------|
| id | `affection_solo_v31` |
| pack_template_id | `couple_v1` |
| name_ru | Нежность |
| name_en | Affection |
| carousel_description_ru | Люблю, скучаю, иди ко мне, мой/моя, спокойной ночи. Тепло, которое чувствуется. |
| carousel_description_en | Love you, miss you, come here, mine, good night. Warmth you can feel. |
| labels | `["Люблю тебя", "Скучаю", "Ты моя", "Красавица", "Иди ко мне", "Горжусь тобой", "Моя", "Обнимаю", "Спокойной ночи"]` |
| labels_en | `["Love you", "Miss you", "You're mine", "Beautiful / Handsome", "Come here", "Proud of you", "Mine", "Hug", "Good night"]` |
| scene_descriptions | `["{subject} gently leans forward and places a hand on their chest, calm warm eye contact — a sincere feeling of love", "{subject} takes a small step forward and slightly extends an open palm, subtly closing the distance — missing you", "{subject} in a soft half-profile with a confident warm half-smile, body slightly turned — you are mine", "{subject} gives a gentle nod and a small supportive hand gesture forward — proud of you", "{subject} opens their arms in motion, body leaning slightly forward — come here", "{subject} tilts their head slightly and looks from under their lashes with a light playful smile — beautiful / handsome", "{subject} slowly runs a hand along their forearm, calm deep eye contact — quiet closeness", "{subject} wraps their arms around their shoulders and gently leans forward, as if offering a hug", "{subject} softly closes their eyes and smiles, hands resting calmly near the collar or fabric — good night"]` |
| sort_order | 151 |
| is_active | true |
| mood | affection |
| sticker_count | 9 |
| subject_mode | single |
| cluster | false |
| segment_id | affection_support |

В миграциях строки вставляются в `pack_content_sets` или `pack_content_sets_test` с этими же колонками; `created_at` при INSERT не указывают или используют `now()`. **Тестовые миграции паков** (один пак или батч в `pack_content_sets_test`) лежат в **`sql/packs/`**; нумерация продолжается там (напр. `sql/packs/134_test_название_пака_v1.sql`).

---

## 2. Роли агентов

**Минимальная конфигурация** (абстрактный запрос пользователя обрабатывается «в лоб» через Boss):

| Агент | Вход | Выход | Ответственность |
|-------|------|--------|------------------|
| **pack_boss** | Название/тема пака (строка) или абстрактный запрос | Верхнеуровневый план + 9 «моментов» (+ опционально day_structure) | id, name_ru/en, carousel_description, mood, story_arc, tone, массив из 9 названий моментов (события, не эмоции); при цели «один день» — привязка к утру/дню/вечеру. |
| **pack_captions** | План от босса (JSON) | 9 labels (RU) + 9 labels_en (EN) | Короткие подписи = внутренний комментарий, чат-готовые, в заданном тоне. |
| **pack_scenes** | План + (опционально) подписи | 9 scene_descriptions с `{subject}` | Конкретный кадр: момент, тело в движении, ~70% интенсивность, баланс по сетке 3×3; единый сеттинг/день. |

**Расширенная конфигурация** (рекомендуется для абстрактного ввода и виральности): см. **раздел 0** — добавляются **Concept** (абстрактный запрос → бриф) и опционально **Critic** (проверка виральности и «один день»). Boss тогда получает бриф, а не сырой запрос.

Босс задаёт «что за момент» и тон; подписи и сцены разворачивают это в текст и визуал по правилам фреймворка ниже.

---

## 3. Детализация агентов

### 3.0. Concept / Interpreter (pack_concept) — расширенная схема

- **Вход (user):**
  - Абстрактный запрос пользователя, например: `офисный юмор`, `бытовые ситуации`, `утро родителя`, `удалёнка в пижаме`.
  - **Контекст фото (обязательно при генерации под пользователя):** по загруженному фото известны **количество людей** (1, 2, …) и **пол людей** (мужской/женский). Из этого выводится `subject_type`: например single_male, single_female, couple (M+F). Концепт должен строиться **под этого персонажа(ов)** — не предлагать сцены про пару, если на фото один человек; не предлагать «папа с ребёнком», если на фото один взрослый без ребёнка.
- **Выход (JSON):**
  - `subject_type` — согласован с контекстом фото (single / couple; при single — опционально male/female для тонкости персоны)
  - `setting` — где разворачивается день (office, home, hybrid, commute, …)
  - `persona` — краткий архетип под **того, кто на фото** («молодая женщина, утро перед работой», «пара, выходной дома», «мужчина за ноутбуком на удалёнке»)
  - `tone` — dry sarcasm / soft irony / gentle warmth / playful teasing / …
  - `timeline` — всегда `one_day`; опционально утро/день/вечер как три акта
  - `situation_types` — 3–5 типов ситуаций для покрытия (например: утренний хаос, первый кофе, созвон, обед, конец дня)
  - `shareability_hook` — одной фразой: кто будет шерить и зачем («офисные отправят коллегам как „это мы“», «родители — в чаты мам/пап»)
  - `title_hint` — предложение для названия пака (Boss может взять за основу)

Правила: не придумывать конкретные 9 сцен — только бриф для Boss. Фокус на узнаваемости и поводе для шеринга. **Persona, setting и situation_types должны подходить под того персонажа(ов), что на фото** (кол-во людей и пол заданы контекстом).

### 3.1. Boss (pack_boss)

- **Вход (user):** либо одна строка (название/тема пака), либо **бриф от Concept** (JSON) — при расширенной схеме. В брифe при наличии контекста фото уже есть subject_type; Boss должен выдать subject_mode и pack_template_id под этого персонажа(ов).
- **Выход (JSON):**
  - `id` — slug (snake_case), напр. `everyday_home_chaos_sitcom30_v1`
  - `pack_template_id` — по контексту фото: напр. одиночный шаблон при single, couple_v1 при couple
  - `subject_mode` — single или couple, согласовано с контекстом фото (из брифa)
  - `name_ru`, `name_en`
  - `carousel_description_ru`, `carousel_description_en`
  - `mood` — из фиксированного набора (everyday, reactions, affection, sarcasm, …)
  - `sort_order` — число
  - `story_arc` — одна фраза: escalation / chaos → composure / denial → acceptance и т.д.
  - `tone` — dry sarcasm / soft irony / gentle warmth / playful teasing / calm authority / vulnerable honesty
  - `day_structure` — (опционально) массив из 9 элементов: `morning` / `midday` / `evening` или короткие тайм-метки, чтобы Captions/Scenes держали линию «один день»
  - `moments` — массив из **9 строк**: название момента (событие, не эмоция), напр. «day starting, stretch», «mid-sip pause, something's off», «stain noticed, quiet seriously?»

Правила в system_prompt босса: пак = микро-история с прогрессией; при наличии брифa — строго следовать setting/persona и timeline one_day. Каждый из 9 пунктов = момент (событие), не эмоция; формулировки в духе «0.5 секунды после». Не допускать 9 раз «счастливый/грустный»; обеспечить смену ситуаций/состояний и при необходимости явную привязку к утру/дню/вечеру.

### 3.2. Captions (pack_captions)

- **Вход:** JSON плана от босса (id, name_ru/en, carousel_description, mood, tone, `moments`).
- **Выход (JSON):**
  - `labels` — массив из 9 строк (RU)
  - `labels_en` — массив из 9 строк (EN)

Правила: подписи = внутренний комментарий / мысль, не метка эмоции (не «Счастлив», а «Ладно, поехали», «Of course», «Love that for me»). Короткие, естественные в чате, в выбранном тоне. Порядок строго по `moments[0]..moments[8]`. Можно добавить 1–2 few-shot примера (план → готовые labels/labels_en).

### 3.3. Scenes (pack_scenes)

- **Вход:** JSON плана + (опционально) готовые `labels`/`labels_en` от pack_captions. При цели «один день» в плане есть day_structure или явный контекст timeline.
- **Выход (JSON):**
  - `scene_descriptions` — массив из 9 строк; каждая — одно предложение с плейсхолдером `{subject}`, chest-up, mid-motion, без статичной «фото-позы».

Правила: сцена = момент «0.5 секунды после» (осознание, ошибка, маленькая победа). Интенсивность выражения ~70%; без театральной гримасы. Движение: лёгкий поворот корпуса (20–40°), перенос веса, «середина движения». Сетка 3×3: 2–3 взгляд в камеру, 3 в сторону, 2 вниз, 1–2 в явном движении; по рядам — разнообразие. Формат строки: `"{subject} [framing], [body position], [small action] — [moment in one phrase]".` **Континуити:** один день, одна среда (офис/дом/кафе), один и тот же «персонаж» по типу — без скачков места и времени, чтобы пака читалась как цельный день.

### 3.4. Critic / Virality (pack_critic) — опционально

- **Вход:** полная спека пака (план + labels + labels_en + scene_descriptions) в виде JSON или структурированного текста.
- **Выход (JSON):**
  - `pass` — boolean
  - `reasons` — массив коротких строк: что хорошо (relatability, hook, one-day arc) и что слабо (generic caption, broken continuity, weak share moment)
  - `suggestions` — 1–3 конкретных предложения по улучшению (например: «подпись 4 заменить на более „внутренний“ комментарий», «сцена 7 — добавить привязку к вечеру»)

Правила в system_prompt: оценивать по критериям раздела 0.4 (relatability, share moment, hook, consistency одного дня). Не переписывать контент — только вердикт и рекомендации для следующей итерации.

---

## 4. Оркестратор

**Минимальный пайплайн** (запрос уже конкретный или Boss умеет интерпретировать абстрактный):

1. **Boss:** user message = название/тема пака (или абстрактный запрос) → парсинг в объект плана (id, name_ru, name_en, carousel_description_ru/en, mood, sort_order, story_arc, tone, moments[], опционально day_structure).
2. **Captions:** user message = JSON плана → парсинг в `labels`, `labels_en`.
3. **Scenes:** user message = JSON плана + (опционально) labels/labels_en → парсинг в `scene_descriptions`.
4. **Сборка:** из плана взять id, pack_template_id, name_ru, name_en, carousel_description_ru/en, mood, sort_order, subject_mode, segment_id; добавить sticker_count=9, is_active=true, cluster=false; подставить labels, labels_en от Captions и scene_descriptions от Scenes. Итог — одна строка в формате **pack_content_sets** (все колонки из раздела 1).
5. **Валидация (опционально):** чеклист раздела IX + при цели виральности — критерии раздела 0.4; при провале — перезапуск captions/scenes или уточнение плана.

**Расширенный пайплайн** (абстрактный запрос → виральный пак одного дня):

1. **Контекст фото (до агентов или отдельный шаг):** по загруженному фото пользователя определить количество людей и пол людей → получить `subject_type` (single_male, single_female, couple, …). Передать в Concept.
2. **Concept:** user message = абстрактный запрос + **контекст фото** (subject_type / people_count, genders) → structured brief, **персона и сеттинг под того, кто на фото**.
3. **Boss:** user message = JSON брифa (в т.ч. subject_type) → план с day_structure, 9 моментами и **subject_mode / pack_template_id** по контексту фото (single vs couple).
4. **Captions:** plan → labels, labels_en (с контекстом «один день»).
5. **Scenes:** plan + labels → scene_descriptions (континуити одного дня, **один персонаж или пара** — по subject_mode).
6. **Сборка:** как выше; итог — одна строка в формате **pack_content_sets** (раздел 1). subject_mode и pack_template_id из плана (уже согласованы с фото).
7. **Critic (опционально):** полная спека → pass/fail + recommendations; при fail — итерация.

Параллелить Captions и Scenes после Boss можно для скорости, но тогда Scenes не видят подписи; для связности и виральности предпочтительнее порядок Captions → Scenes.

Варианты размещения: отдельный скрипт/воркер в репо (например `runPackSpecGenerationJob`) с вызовом `getAgent` и Gemini по аналогии с `generatePrompt`; либо отдельный репо/скрипт с выводом в JSON/markdown для ручной вставки в миграции.

---

## 4.1. Режим без кода: пайплайн в Cursor

Весь пайплайн можно гонять **внутри Cursor**, без отдельного кода и без вызовов API Gemini. Есть два подхода: один чат с «симуляцией» агентов по очереди или **отдельные агенты с зафиксированной логикой**.

### Агенты с заданной логикой в Cursor

Идея: **не менять роль у одного агента** (сейчас Concept, потом Boss, потом Captions в одном чате), а завести **отдельного агента на каждую роль** с фиксированной логикой. Тогда у тебя всегда «Concept» только интерпретирует запрос, «Boss» только строит план, «Captions» только пишет подписи — без путаницы и без повторения инструкций в одном диалоге.

В Cursor это можно сделать так, без своего кода:

| Способ | Как это работает | Для паков |
|--------|-------------------|-----------|
| **Rules (.cursor/rules)** | Файлы `.mdc` с инструкциями; при упоминании в чате (`@pack-concept.mdc`) ассистент ведёт себя по этой роли. Один «агент» = один rule-файл с промптом и форматом ввода/вывода. | Создать `pack-concept.mdc`, `pack-boss.mdc`, `pack-captions.mdc`, `pack-scenes.mdc`, `pack-critic.mdc` — в каждом описать роль, вход/выход и критерии из этого документа. В чате: «@pack-concept.mdc запрос: офисный юмор» → потом «@pack-boss.mdc вот бриф: …» и т.д. |
| **Team Commands (Cursor 2.0)** | В дашборде Cursor задаются кастомные команды с промптами и правилами; они доступны всей команде. По сути это «агент» = команда с фиксированной логикой. | Команды типа «Pack: Concept», «Pack: Boss», «Pack: Captions» и т.д., каждая со своим промптом и форматом вывода из раздела 3. Запускаешь по очереди, передавая вывод предыдущего шага. |
| **Несколько вкладок агента (Cmd+T)** | В каждой вкладке — отдельная сессия. В одной вкладке подключаешь rule Concept, в другой — Boss, в третьей — Captions. Копируешь вывод из вкладки в вкладку и гоняешь пайплайн вручную. | Удобно, если хочешь держать контекст каждого агента изолированно и не смешивать всё в одном чате. |
| **MCP-сервер (например Agent²)** | Внешний MCP-сервер может объявлять несколько «инструментов» или агентов (описания в markdown в папке `agents/`). Cursor вызывает их как инструменты. | Настроить MCP с агентами Concept, Boss, Captions, Scenes; оркестратор тогда может быть один запрос в чате («сгенерируй пак: офисный юмор»), а чат по очереди вызывает MCP-агентов. Требует настройки MCP и, возможно, лёгкого кода на стороне сервера. |

Итого: **да, в Cursor можно делать агентов с определённой логикой** — через Rules (самый простой вариант в рамках репо), через Team Commands (если есть Cursor for Teams), или через MCP для более «настоящей» мультиагентности с вызовом по имени. Отдельный воркер на коде не обязателен.

### Как пользоваться (один чат, без разделения на rule-файлы)

**Вариант A — один запрос (рекомендуется):**

Открыть этот документ в контексте (например `@docs/pack-multiagent-requirements.md`) и написать в чат:

> Сгенерируй пак по запросу: **[офисный юмор / бытовые ситуации / утро родителя / …]**  
> Пройди полный пайплайн из раздела 0 и 4: Concept → Boss → Captions → Scenes → сборка. Учти STICKER PACK MASTER SYSTEM (раздел 5) и критерии виральности (раздел 0.4). Итог выдай в формате таблицы из раздела 1 (готовая спека для SQL/дока).

Ассистент симулирует всех агентов по очереди и в конце даёт таблицу с id, name_ru/en, labels, scene_descriptions и т.д. Файл миграции или markdown можно попросить отдельно: «сохрани это в `sql/packs/134_test_...sql`» или «добавь в отдельный md».

**Вариант B — по шагам:**

Если ответ получается слишком длинным или хочется править промежуточные результаты:

1. «Выступи как Concept. Запрос: офисный юмор» → получаешь бриф.
2. «По этому брифу выступи как Boss, выдай план с day_structure и 9 моментами» → план.
3. «По плану сделай подписи (Captions): 9 labels RU + 9 labels EN» → labels.
4. «По плану и подписям сделай 9 scene_descriptions (Scenes)» → сцены.
5. «Собери всё в финальную таблицу спеки» (или «проверь как Critic и если ок — собери таблицу»).

Так можно править бриф или план перед генерацией подписей и сцен.

### Повторная генерация той же темы: почему фразы совпадают

При каждом новом запуске с тем же запросом (напр. «сгенерируй пак День интроверта») подписи и описания часто получаются **почти теми же**: один и тот же вход → тот же бриф (setting, tone, situation_types) → те же типы моментов → те же клише в подписях. Модель сходится к «типичному» решению для темы (кофе, остаться дома, плед, «день удался» и т.д.).

**Как получить другой набор фраз и сцен:** добавь в запрос указание на вариацию, например: «День интроверта, **другой вариант**», «ещё один пак на эту тему», «**новый угол**», «**более ироничный**», «**другие формулировки**». Тогда Concept сменит тон или акцент (situation_types), Boss — моменты и carousel_description, Captions — подписи, и результат будет отличаться. В rule-файлах агентов зашита обработка «другой вариант» (pack-concept, pack-boss, pack-captions).

- Генерировать полную спеку пака по абстрактному запросу.
- Получать результат в виде таблицы (раздел 1) или JSON.
- Просить сохранить результат в файл (например новая миграция в `sql/` или док в `docs/`) — ассистент создаст файл.
- Итерация по Critic: «проверь этот пак по разделу 0.4 и дай suggestions» → правки в чате → пересборка.

### Ограничения режима «в чате»

- Нет автоматического retry при fail Critic — итерация вручную («переделай подписи по suggestions»).
- Нет прямого INSERT в БД — только вывод в чат/файл; миграцию потом применяешь сам.
- Длина ответа: при полном пайплайне в одном ответе ассистент может разбить вывод на несколько сообщений или выдать итог компактно; при необходимости лучше шаги B.
- Модель — та, что в Cursor (не Gemini); для «продакшена» с теми же промптами можно позже вынести пайплайн в код с вызовами Gemini.

### Правило для Cursor (опционально)

Чтобы любой запрос вида «сгенерируй пак: …» автоматически трактовался как полный пайплайн, можно добавить правило (например в `.cursor/rules/pack-generation.mdc`):

- При фразах вроде «сгенерируй пак», «pack по запросу», «стикерпак на тему» использовать документ `docs/pack-multiagent-requirements.md` и выполнять пайплайн Concept → Boss → Captions → Scenes → сборка; выдавать спеку в формате раздела 1 и учитывать STICKER PACK MASTER SYSTEM и критерии виральности.

Тогда не нужно каждый раз прикладывать документ вручную.

### Отдельные rule-файлы под каждого агента (рекомендуется для «логики в Cursor»)

В репо уже созданы rule-файлы в `.cursor/rules/` (только Cursor rules, без MCP и Cursor Teams):

- **pack-concept.mdc** — агент Concept: запрос + контекст фото → бриф (JSON).
- **pack-boss.mdc** — агент Boss: бриф → план пака с day_structure и 9 моментами (JSON).
- **pack-captions.mdc** — агент Captions: план → labels и labels_en (JSON).
- **pack-scenes.mdc** — агент Scenes: план + подписи → scene_descriptions (JSON).
- **pack-critic.mdc** — агент Critic: готовая спека → pass/fail + reasons + suggestions (JSON).
- **pack-generation.mdc** — полный пайплайн: при фразах «сгенерируй пак», «pack по запросу» и т.п. выполнять Concept → Boss → Captions → Scenes → сборка в одном чате.

Подключай в чате через `@`: например `@pack-concept.mdc запрос: офисный юмор. На фото одна женщина` → копируешь бриф → `@pack-boss.mdc бриф: …` → и так далее. Роль у агента не переключается: один rule = один агент с одной ролью, логика не смешивается.

**Контекст фото в режиме без кода:** если в Cursor нет доступа к реальному фото пользователя, контекст можно передать текстом в запросе к Concept, например: «запрос: офисный юмор. На фото одна женщина» или «subject_type: single_female». Concept тогда строит бриф под одного женского персонажа; Boss и остальные получают subject_mode single и соответствующий pack_template_id.

---

## 4.2. Распределение STICKER PACK MASTER SYSTEM по агентам

Каждому агенту даются только те правила, которые он может применять в своей роли. Ниже — кто что использует.

| Раздел фреймворка | Concept | Boss | Captions | Scenes | Critic |
|-------------------|---------|------|----------|--------|--------|
| **I. Moment, not emotion** | ✓ situation_types = события | ✓ moments[] = события | — | ✓ сцена = момент после события | ✓ проверка |
| **II. 70% rule, hyperbole in situation** | — | ✓ моменты из ситуации | — | ✓ выражение ~70%, не театр | ✓ проверка |
| **III. Body & composition (статичные позы, сетка 3×3)** | — | ✓ 9 моментов визуально различаются | — | ✓ поза, поворот, **явно: взгляд в камеру/в сторону/вниз** по сетке | ✓ проверка |
| **IV. Micro-story, 0.5 sec after** | ✓ прогрессия, timeline | ✓ story_arc, day_structure, моменты «после» | — | ✓ каждая сцена = 0.5 сек после | ✓ проверка |
| **V. Captions = inner thoughts, tone** | ✓ tone в брифe | ✓ tone в плане | ✓ подписи = мысль, не метка; тон | — | ✓ проверка |
| **VI. Recognizability, each sticker alone, avoid over-specific** | ✓ relatable, shareability_hook | ✓ пак цельный, но 9 разных | ✓ каждая подпись сама по себе | ✓ каждая сцена сама по себе | ✓ проверка |
| **VII. What kills a pack** | — | ✓ не 2 одинаковых «телефон»/«плед» подряд | ✓ не описательные подписи | ✓ не похожие позы, не монотонность | ✓ чеклист |
| **VIII. Pack types** | ✓ тон под тип пака | — | — | — | — |
| **IX. Final checklist** | — | — | — | — | ✓ прогонять перед вердиктом |
| **X. Master prompt** | — | — | — | — | ✓ при suggestions |

**Кратко по агентам:**

- **Concept:** I (моменты, не эмоции), IV (прогрессия дня), V (tone), VI (relatable, hook), VIII (тип пака).
- **Boss:** I, II, III (9 визуально разных моментов), IV (story_arc, day_structure, «0.5 после»), V (tone), VI (цельный пак, но разнообразие), VII (не повторять один и тот же визуал).
- **Captions:** V (inner thoughts, tone), VI (каждая подпись работает одна), VII (не descriptive).
- **Scenes:** I, II, III (обязательно: разный взгляд по сетке 3×3, без статики), IV (0.5 после), VI (каждая сцена одна), VII (никаких одинаковых поз/действий).
- **Critic:** все разделы как чеклист; при fail — suggestions с опорой на X.

**Важно:** правила по взгляду (2–3 сцены в камеру, не более одной с закрытыми глазами) должны соблюдаться не только в scene_descriptions, но и **на этапе генерации картинки**. Воркер (`src/worker.ts`, `runPackPreviewJob`) передаёт scene_descriptions в Gemini; без явной инструкции «соблюдать направление взгляда из каждой сцены» модель может игнорировать «gaze at camera» и рисовать отведённый взгляд (особенно для «спокойных» тем). В воркере добавлен блок **GAZE DIRECTION (MANDATORY)** в промпт пака — он требует от Gemini следовать взгляду из описания сцены.

---

Все агенты и итоговые паки должны соответствовать следующим правилам.

---

### I. CORE PRINCIPLE

#### 1. A Sticker Is a Moment, Not an Emotion

- ❌ Do not design “happy”, “sad”, “angry”.
- ✅ Design moments:
  - message already sent
  - coffee already spilled
  - compliment just received
  - argument just paused
  - small win just happened

Emotion must be the result of an event.

---

### II. EMOTIONAL CALIBRATION

#### 2. 70% Rule

- 0% = boring
- 100% = theatrical
- 70% = believable

Never exaggerate facial expressions. Control is stronger than exaggeration.

#### 3. Hyperbole in Situation, Not Face

Comedy and drama must come from:

- timing (too late)
- physical awkwardness
- unexpected detail
- social discomfort

Not from wide eyes or overacting.

---

### III. BODY & COMPOSITION RULES

#### 4. Avoid Static Posing

Never create:

- symmetrical arms
- fully frontal static stance
- “photo pose” energy

Always include:

- torso rotation (20–40°)
- weight shift
- mid-motion feeling
- imperfect alignment

#### 5. Grid Balance (3×3 Packs)

Across 9 stickers ensure:

- 2–3 forward gaze
- 3 sideways gaze
- 2 downward
- 1–2 in visible motion

Too many downward or frontal faces kills rhythm. **Too many closed eyes or no direct eye contact kills virality** — стикер должен «смотреть» на того, кому шлёшь, минимум в 2–3 кадрах. В scene_descriptions явно задавать «eyes open, gaze at camera» в 2–3 сценах и **не более одной сцены с закрытыми глазами** (напр. только момент «короткий сброс»). Each row must visually breathe:

- one static
- one rotated
- one in motion

---

### IV. DRAMATURGY OF A PACK

#### 6. Packs Should Feel Like Micro-Stories

Even reaction packs should have progression. Possible structures:

- escalation
- denial → acceptance
- tension → irony
- chaos → composure
- confidence → overconfidence → correction

A pack must not feel random.

#### 7. 0.5 Seconds After

Best sticker timing:

- after realization
- after mistake
- after compliment
- after awkward silence
- after small victory

Never before the event. Never during preparation.

---

### V. HUMOR SYSTEM

#### 8. Captions Are Inner Thoughts, Not Labels

- ❌ “Happy”
- ❌ “Angry”
- ❌ “Burned breakfast”
- ✅ “Love that for me.”
- ✅ “Bold of you.”
- ✅ “We move.”
- ✅ “Professional. Allegedly.”

Captions must:

- feel sendable
- be short
- feel natural in chats
- sound like internal commentary

#### 9. Tone Control

Choose tone consciously:

- Dry sarcasm
- Soft irony
- Gentle warmth
- Playful teasing
- Calm authority
- Vulnerable honesty

Never childish unless intentionally designing for that audience.

---

### VI. UNIVERSAL SELLABILITY RULES

#### 10. Recognizability Over Creativity

If people recognize themselves → they buy. Relatable beats outperforms clever concepts.

#### 11. Each Sticker Must Work Alone

If one sticker cannot stand alone in chat, it is weak. Every cell must be:

- usable independently
- context-flexible
- emotionally clear

#### 12. Avoid Over-Specific Context

Unless theme demands it, avoid:

- niche props
- hyper-specific references
- overly narrow jokes

Universality increases sales.

---

### VII. WHAT KILLS A PACK

- Too many similar poses
- Too many frontal faces
- **No forward gaze** (0 взглядов в камеру — теряется контакт и виральность)
- **Too many closed eyes** (больше одной сцены с закрытыми глазами — пак «отстранённый»)
- No physical action
- Overacting
- Descriptive captions
- Emotional repetition
- No progression
- Visual monotony

---

### VIII. PACK TYPES ADAPTATION

These rules apply to:

- Everyday packs
- Reaction packs
- Sarcasm packs
- Romantic tension packs
- Affection packs
- Work packs
- Conflict packs
- Achievement packs
- Flirty packs
- Friendship packs

Only tone and progression change — structure remains.

---

### IX. FINAL CREATOR CHECKLIST

Before finalizing any pack:

- ☐ Does each scene include physical movement?
- ☐ Is emotional intensity below theatrical?
- ☐ Is there visual rhythm across the grid?
- ☐ Are captions sendable in real chats?
- ☐ Does the pack feel cohesive?
- ☐ Can each sticker stand alone?
- ☐ Would a real person actually use this?

**Для виральности и «одного дня» (см. раздел 0.4):**

- ☐ Is the pack clearly relatable to a specific persona/setting (office, parent, freelancer, …)?
- ☐ Is there a clear share moment — would someone send this pack to a friend to say “this is my day” or “this is us”?
- ☐ Does the carousel description (hook) make it obvious what the pack is about and for whom?
- ☐ Is the one-day arc clear (morning → day → evening) and consistent in setting and tone?

If any answer is “no” → iterate.

---

### X. MASTER PROMPT TEMPLATE

Use this to continue improving packs:

> We are designing a sellable, adult, relatable sticker pack. Follow these rules:
> 1. Focus on situations, not emotions.
> 2. Keep expressions at 70% intensity.
> 3. Avoid static front-facing poses.
> 4. Balance gaze and body direction across the 3x3 grid.
> 5. Ensure each scene feels like 0.5 seconds after something happened.
> 6. Captions must be natural, short, and chat-ready.
> 7. Every sticker must work independently.
> 8. Maintain tonal consistency.
> 9. Include physical action and imperfect movement.
> 10. The pack must feel cohesive and intentional.
>
> Now improve the current pack accordingly.

---

## 6. Связь с кодом и БД

- Агенты: таблица `agents` (name, model, system_prompt, few_shot_examples, output_schema); загрузка через `getAgent(name)` в `src/index.ts`.
- Генерация промптов для одного стикера: `generatePrompt`, агент `prompt_generator`; для паков — отдельный пайплайн (Boss → Captions → Scenes).
- Контент паков: `pack_content_sets`, `pack_content_sets_test`; воркер использует `scene_descriptions`, `labels` при сборке превью (см. `src/worker.ts`, `runPackPreviewJob`). В промпт пака добавлено правило **GAZE DIRECTION (MANDATORY)** — Gemini обязан соблюдать направление взгляда из каждой сцены («gaze at camera» → прямой взгляд в камеру в этой ячейке).
- Примеры формата полей: тестовые миграции паков в **`sql/packs/`** (файлы `*_test_*.sql` или `*_pack_content_sets_test_*.sql`).

После реализации мультиагентного пайплайна имеет смысл обновить `docs/architecture/` (например 03-ai-assistant.md или отдельный файл про генерацию контента паков).
