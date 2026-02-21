# 1. Внедрение новых групп паков и ru-описаний

**Дата:** 2026-02-19  
**Связано:** pack_content_sets, [19-02-pack-0-gender-from-photo.md](19-02-pack-0-gender-from-photo.md), [19-02-pack-2-segments-ui.md](19-02-pack-2-segments-ui.md), [docs/architecture/11-subject-profile-and-gender.md](architecture/11-subject-profile-and-gender.md).

---

## Цель

- Ввести **русские описания** для паков: `carousel_description_ru`, `scene_descriptions_ru` (и при необходимости подписи под пол: `labels` / `labels_f`).
- Внедрить **новые группы паков** (финальный набор по сегментам) с полными данными для миграции/вставки в БД.

Логика определения пола по фото и подстановка `{subject}` — в документе **0**. Навигация по сегментам в UI — в документе **2**.

---

## Текущая реализация (актуально на 2026-02)

**Воркер и API используют только:**

- **scene_descriptions** (EN) — единственный источник сцен для промпта Gemini. В каждой строке плейсхолдер **`{subject}`** заменяется на «man» или «woman» по `getSubjectWordForPrompt(packSubjectProfile)` (источник пола: `session.subject_gender` / `session.object_gender` или явный `pack_subject_gender`). См. док 0 и `docs/architecture/11-subject-profile-and-gender.md`.
- **labels** / **labels_en** — подписи при сборке пака выбираются **по языку** (ru → labels, en → labels_en). Выбор подписей по полу (`labels_f` при female) **в коде не реализован**.
- **carousel_description_ru** / **carousel_description_en** — показ в карточке карусели (index).
- **subject_mode** — проверка совместимости набора с сессией (single/multi/any); фильтр карусели при включённом `subject_mode_pack_filter_enabled`.

**В БД и коде отсутствуют (запланировано):** колонки `scene_descriptions_ru`, `labels_f`, `segment`. Данные ниже — целевая структура для миграций и будущего доработки воркера/каталога.

---

## Структура набора (pack_content_sets)

Для каждого набора обязательно:

| Поле | Правило | Статус |
|------|--------|--------|
| `id` | Уникальный, например `sass_v2`, `reactions_daily_v2`, `thanks_solo_v2` | ✅ в БД |
| `pack_template_id` | Общий шаблон (deprecated, для совместимости) | ✅ в БД |
| `name_ru` / `name_en` | Название на русском и английском | ✅ в БД |
| `carousel_description_ru` / `carousel_description_en` | Краткое описание для карточки карусели | ✅ в БД |
| `labels` / `labels_en` | Массивы подписей; длина = sticker_count (обычно 9) | ✅ в БД, воркер по lang |
| `labels_f` | Подписи для female; при сборке выбирать по subject_gender | ⏳ запланировано |
| `scene_descriptions` | Массив сцен на **английском**; длина = sticker_count. **В воркер передаётся только он** (с заменой `{subject}`). | ✅ в БД |
| `scene_descriptions_ru` | Массив сцен на **русском**; для контента/каталога; в воркер не передаётся. | ⏳ запланировано |
| `subject_mode` | Совместимость: `single` / `multi` / `any` | ✅ в БД |
| `sticker_count` | 9 (или по шаблону) | ✅ в БД |
| `sort_order` | Порядок в карусели | ✅ в БД |
| `segment` | Идентификатор сегмента для UI (см. док 2) | ⏳ запланировано |
| `mood` | Тематика (sarcasm, reactions, holiday, …) | ✅ в БД |
| `cluster` | Показ в Hero на кластерных страницах лендинга | ✅ в БД |

Связка подпись–сцена: **по индексу**. Для каждого `i`: подпись — `labels[i]` (или `labels_f[i]` когда будет реализовано); сцена в промпт — `scene_descriptions[i]` (EN); для каталога — `scene_descriptions_ru[i]` (когда колонка будет добавлена).

---

## Один набор на тему + плейсхолдер {subject}

В сценах используется единый токен **`{subject}`**. Воркер при сборке промпта заменяет его на «man» или «woman» по детекции пола или выбору пользователя (`pack_subject_gender`). Подробности — в документе **0**. В БД храним один набор на тему; подписи при необходимости различаются по полу через `labels` (male) и `labels_f` (female).

---

## Правила для scene_descriptions и scene_descriptions_ru

- **scene_descriptions** (EN) — единственный источник сцен для воркера; длина = sticker_count.
- **scene_descriptions_ru** (RU) — те же сцены по смыслу на русском; в воркер не передаётся.

При использовании плейсхолдера: в строках **`{subject}`**; воркер подставляет только в EN перед отправкой в Gemini.

По содержанию:
- Соло-наборы: в каждой сцене только один человек (без «both», «couple», «man and woman»).
- Наборы «для него»/«для неё»: в EN явно «man»/«woman» после подстановки; в RU при отображении — «мужчина»/«женщина» при необходимости.
- Плейсхолдер: в каждой сцене одна подстановка `{subject}`.

---

## Правила для labels

- Длина `labels`, `labels_en` (и при наличии `labels_f`) равна `sticker_count`.
- **Сейчас:** воркер выбирает подписи только по языку сессии: ru → `labels`, en → `labels_en` (или fallback на `labels`).
- **Планируется:** подписи под пол («Ты лучший»/«Ты лучшая») — хранить `labels` (male) и `labels_f` (female); при сборке пака выбирать массив по `subject_gender` (требует доработки воркера и колонки в БД).

---

## Чек-лист перед добавлением в БД

- [ ] Длины массивов: `labels`, `labels_en`, `scene_descriptions` равны `sticker_count`. (Если добавлены колонки: `scene_descriptions_ru`, `labels_f` — их длина тоже.)
- [ ] Для каждого индекса i: сцена EN по смыслу соответствует подписи; при наличии RU — то же для scene_descriptions_ru.
- [ ] При subject_mode = single: в сценах нет второго человека (нет «both», «couple», «man and woman» в одной сцене).
- [ ] В scene_descriptions используется плейсхолдер `{subject}`; после подстановки в male-контексте — «man», в female — «woman».
- [ ] Имена и carousel_description_ru/en заполнены.

---

## Воркер

- **Сцены:** в промпт Gemini подставляется только массив **scene_descriptions** (EN). Перед подстановкой выполняется замена `{subject}` → «man»/«woman» по `getSubjectWordForPrompt(packSubjectProfile)` (см. док 0 и architecture/11-subject-profile-and-gender.md). `scene_descriptions_ru` в воркер не передаётся (колонки пока нет).
- **Подписи:** при сборке пака берутся по индексу из набора по **языку** (`labels` для ru, `labels_en` для en). Выбор по полу (`labels_f` при female) не реализован.

---

## Ранние наборы (для миграции)

Ниже — данные ранних переработанных паков. Все с `subject_mode = single`, `sticker_count = 9`, `pack_template_id = couple_v1`. В сценах плейсхолдер **`{subject}`**; воркер подставляет «man»/«woman» по документу 0.

### Сарказм (sass)

| Поле | Значение |
|------|----------|
| id | `sass` |
| pack_template_id | `couple_v1` |
| name_ru | Сарказм |
| name_en | Sass |
| carousel_description_ru | Ага конечно, ну да, всё ясно, очень верю. |
| carousel_description_en | Yeah right, sure sure, totally clear, I believe you. |
| labels | ["Ага конечно", "Ну да", "Всё ясно", "Очень верю", "Да-да", "Конечно", "Как же", "Непременно", "Ага"] |
| labels_en | ["Yeah right", "Sure", "Totally", "I believe you", "Uh huh", "Of course", "Right", "Sure thing", "Okay"] |
| scene_descriptions | ["{subject} with arms crossed, one eyebrow raised, skeptical", "{subject} with sarcastic smirk, nodding slowly", "{subject} with hand on hip, unimpressed look", "{subject} with exaggerated doubtful expression", "{subject} with eye-roll pose, arms crossed", "{subject} with ironic smile, side glance", "{subject} with raised eyebrow, knowing look", "{subject} with finger to chin, fake thinking pose", "{subject} with deadpan expression, arms crossed"] |
| scene_descriptions_ru | ["{subject} скрестил(а) руки, одна бровь приподнята, скептически", "{subject} с саркастической усмешкой, медленно кивает", "{subject} рука в боку, недовольный вид", "{subject} с преувеличенно сомневающимся выражением лица", "{subject} закатывает глаза, руки скрещены", "{subject} с ироничной улыбкой, взгляд в сторону", "{subject} приподнятая бровь, многозначительный взгляд", "{subject} палец у подбородка, притворяется что думает", "{subject} каменное лицо, руки скрещены"] |
| sticker_count | 9 |
| subject_mode | single |
| sort_order | 9 |
| mood | sarcasm |

### Праздник (holiday_solo)

| Поле | Значение |
|------|----------|
| id | `holiday_solo` |
| pack_template_id | `couple_v1` |
| name_ru | Праздник |
| name_en | Holiday |
| carousel_description_ru | С днём рождения, с 14 февраля, с годовщиной, поздравляю, за нас. |
| carousel_description_en | Happy birthday, Valentine's, anniversary, congrats, cheers. |
| labels | ["С днём рождения", "С 14 февраля", "С годовщиной", "Поздравляю", "За нас", "Любимой", "Любимому", "Праздник", "Ура"] |
| labels_en | ["Happy birthday", "Happy Valentine's", "Anniversary", "Congrats", "Cheers to us", "To my love", "To you", "Celebration", "Yay"] |
| scene_descriptions | ["{subject} holding birthday cake with both hands in front of chest, smiling at camera", "{subject} holding single red heart card or prop in front of chest, smiling", "{subject} holding glass raised in toast, anniversary pose, smiling", "{subject} both arms raised in celebration, big smile, no props", "{subject} holding one glass in cheers pose, smiling at camera", "{subject} holding bouquet of flowers with both hands, presenting toward camera", "{subject} holding gift box with both hands, surprised happy expression", "{subject} wearing party hat, hands in celebratory gesture near chest", "{subject} holding one party balloon, smiling at camera"] |
| scene_descriptions_ru | ["{subject} держит праздничный торт двумя руками перед грудью, улыбается в камеру", "{subject} держит красное сердце или открытку перед грудью, улыбается", "{subject} поднимает бокал в тосте, поза за годовщину, улыбка", "{subject} поднял(а) обе руки в приветствии, широкая улыбка, без реквизита", "{subject} держит бокал в тосте, улыбается в камеру", "{subject} держит букет цветов двумя руками, протягивает к камере", "{subject} держит подарочную коробку двумя руками, удивлённо-счастливое выражение", "{subject} в праздничной шляпе, руки в праздничном жесте у груди", "{subject} держит один воздушный шарик, улыбается в камеру"] |
| sticker_count | 9 |
| subject_mode | single |
| sort_order | 10 |
| mood | holiday |

### Быт и уют (everyday_solo)

| Поле | Значение |
|------|----------|
| id | `everyday_solo` |
| pack_template_id | `couple_v1` |
| name_ru | Быт и уют |
| name_en | Everyday |
| carousel_description_ru | Домашние ситуации: спим?, где еда?, вырубайся, устал, диван, мимими. |
| carousel_description_en | Home vibes: sleep?, where is food?, pass out, tired, couch, aww. |
| labels | ["Спим?", "Где еда?", "Вырубайся", "Устал", "Диван", "Мимими", "Обнимашки", "Кофе?", "Тихий час"] |
| labels_en | ["Sleep?", "Where food?", "Pass out", "Tired", "Couch", "Aww", "Cuddles", "Coffee?", "Quiet time"] |
| scene_descriptions | ["{subject} yawning, eyes closed, head tilted back, relaxed sleeping expression", "{subject} standing, looking slightly to the side with curious expression, as if peeking at fridge", "{subject} dozing off, eyes half-closed, relaxed smile", "{subject} slumping, exhausted tired expression, shoulders down", "{subject} wrapped in blanket, cozy content expression", "close-up of {subject} making cute kissy face at camera", "{subject} hugging pillow, cozy content smile", "{subject} holding coffee mug, taking a sip, relaxed morning expression", "{subject} lying down, resting, peaceful expression, eyes soft or closed"] |
| scene_descriptions_ru | ["{subject} зевает, глаза закрыты, голова запрокинута, расслабленное сонное выражение", "{subject} стоит, с любопытством смотрит в сторону, как будто заглядывает в холодильник", "{subject} дремлет, глаза полуприкрыты, расслабленная улыбка", "{subject} обмяк(ла), усталое измождённое выражение, плечи опущены", "{subject} в пледе, уютное довольное выражение", "крупный план {subject} с милой поцелуйной гримасой в камеру", "{subject} обнимает подушку, уютная улыбка", "{subject} держит кружку кофе, пьёт, расслабленное утреннее выражение", "{subject} лежит, отдыхает, спокойное выражение, глаза мягкие или закрыты"] |
| sticker_count | 9 |
| subject_mode | single |
| sort_order | 11 |
| mood | everyday |

### На каждый день (reactions_solo)

| Поле | Значение |
|------|----------|
| id | `reactions_solo` |
| pack_template_id | `couple_v1` |
| name_ru | На каждый день |
| name_en | Daily reactions |
| carousel_description_ru | Доброе утро, скучаю, устал, голоден, на работе, спокойной ночи. |
| carousel_description_en | Good morning, miss you, tired, hungry, at work, good night. |
| labels | ["Доброе утро", "Скучаю", "Устал", "Голоден", "На работе", "Спокойной ночи", "Поехали", "Ок", "Привет"] |
| labels_en | ["Good morning", "Miss you", "Tired", "Hungry", "At work", "Good night", "Lets go", "Ok", "Hey"] |
| scene_descriptions | ["{subject} stretching arms up, morning smile", "{subject} with hand on heart, longing expression", "{subject} with tired droopy eyes, head tilted", "{subject} rubbing stomach, hungry expression", "{subject} with laptop or phone, busy at work pose", "{subject} in pajamas, waving goodnight, cozy", "{subject} with thumbs up, ready to go", "{subject} nodding with neutral okay expression", "{subject} waving at camera, friendly hello"] |
| scene_descriptions_ru | ["{subject} тянется вверх, утренняя улыбка", "{subject} рука на сердце, тоскующее выражение", "{subject} усталые опущенные глаза, голова наклонена", "{subject} трёт живот, голодное выражение", "{subject} с ноутбуком или телефоном, поза занятости на работе", "{subject} в пижаме, машет спокойной ночи, уютно", "{subject} большой палец вверх, готов ехать", "{subject} кивает с нейтральным выражением ок", "{subject} машет в камеру, дружелюбное привет"] |
| sticker_count | 9 |
| subject_mode | single |
| sort_order | 12 |
| mood | reactions |

### Благодарность (thanks_solo) — подписи под пол

| Поле | Значение |
|------|----------|
| id | `thanks_solo` |
| pack_template_id | `couple_v1` |
| name_ru | Благодарность |
| name_en | Thanks |
| carousel_description_ru | Спасибо, спасибки, выручил(а), ценю, ты лучший/лучшая. |
| carousel_description_en | Thank you, thanks, you saved me, I appreciate, you're the best. |
| labels (male) | ["Спасибо", "Спасибки", "Огромное спасибо", "Выручил", "Класс, спасибо", "Ценю", "Ты лучшая", "Обожаю", "Сердечко"] |
| labels_f (female) | ["Спасибо", "Спасибки", "Огромное спасибо", "Выручила", "Класс, спасибо", "Ценю", "Ты лучший", "Обожаю", "Сердечко"] |
| labels_en | ["Thank you", "Thanks", "Thanks a lot", "You saved me", "Cool thanks", "I appreciate", "You're the best", "Adore you", "Heart"] |
| scene_descriptions | ["{subject} smiling at camera, hands slightly at chest, grateful expression", "{subject} nodding with warm smile, relaxed pose", "{subject} with hands together in thank you gesture, sincere smile", "{subject} with relieved smile, one hand on chest", "{subject} giving thumbs up, bright smile", "{subject} with hand on heart, serious grateful look at camera", "{subject} pointing off-camera with appreciative smile", "{subject} with arms crossed, warm smile at camera", "{subject} making small heart with hands at chest, smiling"] |
| scene_descriptions_ru | ["{subject} улыбается в камеру, руки у груди, благодарное выражение", "{subject} кивает с тёплой улыбкой, расслабленная поза", "{subject} руки сложены в жесте благодарности, искренняя улыбка", "{subject} с облегчённой улыбкой, рука на груди", "{subject} показывает большой палец вверх, яркая улыбка", "{subject} рука на сердце, серьёзный благодарный взгляд в камеру", "{subject} указывает в сторону с признательной улыбкой", "{subject} скрестил(а) руки, тёплая улыбка в камеру", "{subject} складывает руки сердечком у груди, улыбается"] |
| sticker_count | 9 |
| subject_mode | single |
| sort_order | 13 |
| mood | thanks |

### Реакции — эмоции (reactions_emotions)

| Поле | Значение |
|------|----------|
| id | `reactions_emotions` |
| pack_template_id | `couple_v1` |
| name_ru | Реакции |
| name_en | Reactions |
| carousel_description_ru | Ого, вот это да, реально?, точно, поддерживаю, огонь, класс, ахах, идея. |
| carousel_description_en | Wow, no way, really?, sure, support, fire, cool, haha, idea. |
| labels | ["Ого", "Вот это да", "Реально?", "Точно", "Поддерживаю", "Огонь", "Класс", "Ахах", "Идея"] |
| labels_en | ["Wow", "No way", "Really?", "Sure", "I support", "Fire", "Cool", "Haha", "Idea"] |
| scene_descriptions | ["{subject} with exaggerated surprised face, eyes wide, mouth open", "{subject} whistling impressed, raised eyebrows, looking at camera", "{subject} with skeptical raised eyebrow, arms crossed", "{subject} nodding firmly, confident expression", "{subject} giving thumbs up, serious nod", "{subject} with excited grin, fire hand gesture", "{subject} with wide smile and thumbs up", "{subject} laughing, wiping tear, casual pose", "{subject} with lightbulb gesture near head, inspired look"] |
| scene_descriptions_ru | ["{subject} с преувеличенно удивлённым лицом, глаза широко, рот открыт", "{subject} насвистывает под впечатлением, приподнятые брови, смотрит в камеру", "{subject} скептически приподнятая бровь, руки скрещены", "{subject} уверенно кивает, уверенное выражение", "{subject} показывает большой палец вверх, серьёзный кивок", "{subject} с возбуждённой улыбкой, жест «огонь»", "{subject} широкая улыбка и большой палец вверх", "{subject} смеётся, вытирает слезу, расслабленная поза", "{subject} жест лампочки у головы, вдохновлённый взгляд"] |
| sticker_count | 9 |
| subject_mode | single |
| sort_order | 14 |
| mood | reactions |

### Нежность (affection_solo) — подписи под пол

| Поле | Значение |
|------|----------|
| id | `affection_solo` |
| pack_template_id | `couple_v1` |
| name_ru | Нежность |
| name_en | Affection |
| carousel_description_ru | Люблю, скучаю, ты моя/мой, красавица/красавчик, обнимаю, целую. |
| carousel_description_en | Love you, miss you, you're mine, beautiful, hugs, kiss. |
| labels (male) | ["Люблю", "Скучаю", "Ты моя", "Красавица", "Хорошего дня", "Спокойной ночи", "Обнимаю", "Целую", "Моя"] |
| labels_f (female) | ["Люблю", "Скучаю", "Ты мой", "Красавчик", "Хорошего дня", "Спокойной ночи", "Обнимаю", "Целую", "Мой"] |
| labels_en | ["Love you", "Miss you", "You're mine", "Beautiful", "Have a good day", "Good night", "Hugging you", "Kiss", "Mine"] |
| scene_descriptions | ["{subject} with hand on heart, warm smile at camera", "{subject} with soft slightly sad smile, looking at camera", "{subject} with arms slightly open, inviting warm expression", "{subject} with admiring smile, one hand near heart", "{subject} waving at camera, bright morning smile", "{subject} in relaxed pose, soft sleepy smile", "{subject} with arms open in hug gesture, warm smile", "{subject} blowing a kiss to camera, smiling", "{subject} with proud happy look, hand on chest"] |
| scene_descriptions_ru | ["{subject} рука на сердце, тёплая улыбка в камеру", "{subject} с мягкой чуть грустной улыбкой, смотрит в камеру", "{subject} руки слегка раскрыты, тёплое приглашающее выражение", "{subject} с восхищённой улыбкой, рука у сердца", "{subject} машет в камеру, яркая утренняя улыбка", "{subject} в расслабленной позе, мягкая сонная улыбка", "{subject} с раскрытыми руками в жесте объятий, тёплая улыбка", "{subject} посылает воздушный поцелуй в камеру, улыбается", "{subject} с гордым счастливым взглядом, рука на груди"] |
| sticker_count | 9 |
| subject_mode | single |
| sort_order | 15 |
| mood | affection |

---

## Финальные паки по сегментам (полные данные)

Полные данные для внедрения новых групп. Привязка к сегментам и навигация в UI — в документе **2**. Все сцены с плейсхолдером `{subject}`; где указаны labels (male) / labels_f (female) — при сборке выбирать массив по `subject_gender`.

### Сегмент «Реакции» (5 паков)

| id | name_ru | sort_order |
|----|---------|------------|
| reactions_daily_v2 | На каждый день | 12 |
| reactions_emotions_v22 | Реакции | 14 |
| reactions_introvert_day_v1 | День интроверта | 21 |
| reactions_work_day_v1 | Рабочий день | 22 |
| reactions_relationship_day_v1 | День в отношениях | 23 |

Полные таблицы полей (scene_descriptions, scene_descriptions_ru, carousel_description_ru, labels и т.д.) для перечисленных ниже паков задаются по той же структуре, что и в разделе «Ранние наборы» выше. При необходимости восстановить полные блоки финальных паков — см. историю git файла **19-02-pack-solo-male-female-logic.md** (до разбиения на три документа там были разделы 11.1–11.7).

### Сегмент «Сарказм» (5 паков)

sass_v2, sass_bold_v1, sass_royal_v1, sass_lazy_v1, sass_work_v1.

### Сегмент «Дом» (3 пака)

everyday_home_mode_v2, everyday_home_chaos_v1, everyday_home_chaos_v2.

### Сегмент «События» (4 пака)

holiday_solo_v3, holiday_tender_evening_v1, holiday_tender_evening_playful_v2, holiday_after_argument_v1.

### Сегмент «Нежность / поддержка» (4 пака)

thanks_solo_v2, affection_solo_v2, support_presence_v1, friendship_core_v1.

### Сегмент «After Dark» (4 пака)

romantic_tension_v1, romantic_night_sensual_v1, romantic_night_confident_flirt_v1, after_dark_danger_close_v1.

### Сегмент «Границы»

Зарезервировано под будущий пак (отказ, стоп, личные границы). Паков пока нет.
