-- 100_test_pack_content_sets_new.sql (ТЕСТ)
-- Те же наборы, что в 099, но только pack_content_sets_test. Запускать на тестовой БД. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
-- after_dark
(
  'after_dark_danger_close_v1',
  'couple_v1',
  'Опасно близко',
  'Dangerously close',
  'Подойди, ближе, смотри, не отворачивайся, ты чувствуешь?, иди сюда, не спеши, останься, только мы.',
  'Come closer, closer, look, don''t look away, feel it?, come here, no rush, stay, just us.',
  '["Подойди", "Ближе", "Смотри", "Не отворачивайся", "Ты чувствуешь?", "Иди сюда", "Не спеши", "Останься", "Только мы"]'::jsonb,
  '["Come closer", "Closer", "Look at me", "Don''t look away", "Feel it?", "Come here", "No rush", "Stay", "Just us"]'::jsonb,
  '["{subject} slight lean forward with intense steady eye contact", "{subject} relaxed posture with subtle inviting hand motion near torso", "{subject} chin slightly lowered with slow confident half-smile", "{subject} direct unwavering gaze with calm controlled expression", "{subject} head slightly tilted with questioning playful look", "{subject} curling index finger gently in inviting gesture close to body", "{subject} still composed stance with controlled confident smile", "{subject} small slow nod with warm lingering eye contact", "{subject} calm assured posture with quiet intimate smile"]'::jsonb,
  29, true, 'romantic', 9, 'single', false, 'after_dark'
),
(
  'romantic_tension_v1',
  'couple_v1',
  'Намёк',
  'Subtle tension',
  'Подойди, ближе, смотри на меня, ты чувствуешь?, не отворачивайся, я знаю, иди сюда, только ты, задержись.',
  'Come closer, closer, look at me, you feel it?, don''t look away, I know, come here, only you, stay.',
  '["Подойди", "Ближе", "Смотри на меня", "Ты чувствуешь?", "Не отворачивайся", "Я знаю", "Иди сюда", "Только ты", "Задержись"]'::jsonb,
  '["Come closer", "Closer", "Look at me", "You feel it?", "Don''t look away", "I know", "Come here", "Only you", "Stay"]'::jsonb,
  '["{subject} slightly leaning forward with slow confident eye contact", "{subject} relaxed posture, subtle inviting gesture close to torso", "{subject} steady direct gaze with soft half-smile", "{subject} head slightly tilted with playful questioning look", "{subject} gentle hand slightly raised near chest as if stopping someone softly", "{subject} subtle knowing smile with lowered chin and intense eyes", "{subject} curling index finger slightly in inviting motion near body", "{subject} open chest posture with calm confident smile", "{subject} faint slow smile with softened eyes and relaxed shoulders"]'::jsonb,
  26, true, 'romantic', 9, 'single', false, 'after_dark'
),
(
  'romantic_night_sensual_v1',
  'couple_v1',
  'Ночью, когда все спят',
  'When everyone sleeps',
  'Ты не спишь?, тихо, ближе, смотри на меня, я здесь, не спеши, только мы, останься, ночь длинная.',
  'You awake?, quiet, closer, look at me, I''m here, no rush, just us, stay, long night.',
  '["Ты не спишь?", "Тихо…", "Ближе", "Смотри на меня", "Я здесь", "Не спеши", "Только мы", "Останься", "Ночь длинная"]'::jsonb,
  '["You awake?", "Quiet…", "Closer", "Look at me", "I''m here", "No rush", "Just us", "Stay", "Long night"]'::jsonb,
  '["{subject} soft sleepy gaze slightly upward, calm intimate eye contact", "{subject} finger gently near lips in subtle quiet gesture, relaxed posture", "{subject} slight lean forward with slow confident look, shoulders relaxed", "{subject} steady direct gaze with softened eyes and faint half-smile", "{subject} relaxed posture, one hand lightly touching chest, reassuring presence", "{subject} calm still pose with gentle confident smile, no movement", "{subject} open relaxed torso, quiet intimate smile with deep eye contact", "{subject} small inviting gesture close to body, subtle and restrained", "{subject} slow soft smile with lingering gaze, peaceful night expression"]'::jsonb,
  27, true, 'romantic', 9, 'single', false, 'after_dark'
),
(
  'romantic_night_confident_flirt_v1',
  'couple_v1',
  'Уверенный ночной флирт',
  'Confident night flirt',
  'Подойди, ближе, смотри, я здесь, не спеши, твой ход, останься, мне нравится, ночь наша.',
  'Come closer, closer, look, I''m here, no rush, your move, stay, I like it, night is ours.',
  '["Подойди", "Ближе", "Смотри", "Я здесь", "Не спеши", "Твой ход", "Останься", "Мне нравится", "Ночь наша"]'::jsonb,
  '["Come closer", "Closer", "Look", "I''m here", "No rush", "Your move", "Stay", "I like it", "Night is ours"]'::jsonb,
  '["{subject} slight lean forward with steady confident eye contact, relaxed shoulders", "{subject} relaxed posture with subtle inviting hand motion close to torso", "{subject} direct gaze with calm half-smile, chin slightly lowered", "{subject} open chest posture with reassuring presence, hands near torso", "{subject} still composed pose with controlled confident smile, no movement", "{subject} gentle palm-up gesture near chest suggesting invitation, composed look", "{subject} small nod with warm confident smile and lingering eye contact", "{subject} knowing smile with softened eyes, head slightly tilted", "{subject} calm assured stance with quiet smile and steady gaze"]'::jsonb,
  28, true, 'romantic', 9, 'single', false, 'after_dark'
),
-- affection_support
(
  'friendship_core_v1',
  'couple_v1',
  'Лучший друг',
  'Best friend',
  'Ты лучший(ая), мы команда, пошли вместе, я за тебя, только мы поймём, это было легендарно, с тебя кофе, наш уровень, как всегда.',
  'You''re the best, we''re a team, let''s go, I''ve got you, only we get it, legendary, coffee''s on you, our level, as always.',
  '["Ты лучший(ая)", "Мы команда", "Пошли вместе", "Я за тебя", "Только мы поймём", "Это было легендарно", "С тебя кофе", "Наш уровень", "Как всегда"]'::jsonb,
  '["You''re the best", "We''re a team", "Let''s go together", "I''ve got you", "Only we get it", "Legendary", "Coffee''s on you", "Our level", "As always"]'::jsonb,
  '["{subject} wide confident grin with playful energy", "{subject} pointing at camera with friendly determined smile", "{subject} leaning slightly forward with excited gesture forward", "{subject} small fist raised near chest in supportive team gesture", "{subject} subtle wink with inside joke smile", "{subject} slow clap once near chest with impressed grin", "{subject} playful pointing sideways with teasing smile", "{subject} confident upright posture with proud friendly expression", "{subject} relaxed shrug with knowing amused look"]'::jsonb,
  14, true, 'friendship', 9, 'single', false, 'affection_support'
),
(
  'support_presence_v1',
  'couple_v1',
  'Я рядом',
  'I''m here',
  'Я рядом, ты справишься, дыши, не сдавайся, я верю, это временно, ты не один(одна), выговорись, обниму?',
  'I''m here, you''ve got this, breathe, don''t give up, I believe in you, this will pass, you''re not alone, talk to me, hug?',
  '["Я рядом", "Ты справишься", "Дыши", "Не сдавайся", "Я верю в тебя", "Это временно", "Ты не один(одна)", "Можно выговориться", "Обниму?"]'::jsonb,
  '["I''m here", "You''ve got this", "Breathe", "Don''t give up", "I believe in you", "This will pass", "You''re not alone", "Talk to me", "Hug?"]'::jsonb,
  '["{subject} steady calm eye contact with soft reassuring smile", "{subject} slight nod with confident supportive expression", "{subject} slow deep breath gesture with relaxed shoulders", "{subject} firm upright posture with determined encouraging look", "{subject} hand lightly touching chest with sincere belief expression", "{subject} open palm gently extended forward at chest level", "{subject} relaxed posture with warm understanding eyes", "{subject} slight lean forward with attentive listening expression", "{subject} arms slightly open near torso inviting safe hug"]'::jsonb,
  14, true, 'support', 9, 'single', false, 'affection_support'
),
(
  'affection_solo_v2',
  'couple_v1',
  'Нежность',
  'Affection',
  'Люблю, скучаю, ты моя/мой, красавица/красавчик, горжусь тобой, я рядом, обнимаю, спокойной ночи, мой человек.',
  'Love you, miss you, you''re mine, beautiful, proud of you, I''m here, hug, good night, my person.',
  '["Люблю тебя", "Скучаю", "Ты моя", "Красавица", "Горжусь тобой", "Я рядом", "Обнимаю", "Спокойной ночи", "Мой человек"]'::jsonb,
  '["Love you", "Miss you", "You''re mine", "Beautiful", "Proud of you", "I''m here", "Hug", "Good night", "My person"]'::jsonb,
  '["{subject} calm steady eye contact with soft confident smile, relaxed shoulders", "{subject} gentle hand touching chest with tender longing expression", "{subject} relaxed posture with subtle possessive confident smile", "{subject} admiring look with warm proud expression", "{subject} upright posture with sincere proud gaze, hands near torso", "{subject} steady reassuring look with small nod", "{subject} arms slightly open close to body in warm hug gesture", "{subject} soft sleepy smile with relaxed posture", "{subject} both hands lightly over heart with deep affectionate eye contact"]'::jsonb,
  15, true, 'affection', 9, 'single', false, 'affection_support'
),
(
  'thanks_solo_v2',
  'couple_v1',
  'Благодарность',
  'Thanks',
  'Спасибо, спасибки ❤️, ты меня выручил(а), очень ценю, вот это помощь, ты просто топ, мой герой/моя героиня, обожаю тебя, от души.',
  'Thank you, thanks ❤️, you saved me, really appreciate it, huge help, you''re awesome, my hero, adore you, from the heart.',
  '["Спасибо!", "Спасибки ❤️", "Ты меня выручил", "Очень ценю", "Вот это помощь!", "Ты просто топ", "Мой герой", "Обожаю тебя", "От души"]'::jsonb,
  '["Thank you!", "Thanks ❤️", "You saved me", "I really appreciate it", "Huge help!", "You''re awesome", "My hero", "Adore you", "From the heart"]'::jsonb,
  '["{subject} smiling warmly with soft eye contact and slight forward lean", "{subject} making playful wink with small friendly hand wave", "{subject} with relieved expression, hands slightly lifted as if just saved", "{subject} placing hand on heart with sincere calm expression", "{subject} clapping hands once with impressed bright smile", "{subject} pointing at camera with confident playful grin", "{subject} raising one fist slightly in admiration gesture with proud smile", "{subject} gently hugging self with affectionate warm smile", "{subject} extending open palm toward camera with deep sincere smile"]'::jsonb,
  13, true, 'thanks', 9, 'single', false, 'affection_support'
)
ON CONFLICT (id) DO UPDATE SET
  pack_template_id = EXCLUDED.pack_template_id,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood,
  sticker_count = EXCLUDED.sticker_count,
  subject_mode = EXCLUDED.subject_mode,
  cluster = EXCLUDED.cluster,
  segment_id = EXCLUDED.segment_id;

-- sarcasm (5)
INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'sass_v2',
  'couple_v1',
  'Сарказм',
  'Sass',
  'Интересно, правда?, удивительно, конечно-конечно, логично, вот это новость, я впечатлён(а), как неожиданно, продолжай.',
  'Interesting, really?, fascinating, sure sure, logical, what a surprise, I''m impressed, shocking, go on.',
  '["Интересно", "Правда?", "Удивительно", "Конечно-конечно", "Логично", "Вот это новость", "Я впечатлён(а)", "Как неожиданно", "Продолжай"]'::jsonb,
  '["Interesting", "Really?", "Fascinating", "Sure sure", "Logical", "What a surprise", "Impressive", "How unexpected", "Go on"]'::jsonb,
  '["{subject} slight head tilt with thin polite smile and raised eyebrow", "{subject} leaning slightly forward with skeptical calm gaze", "{subject} subtle slow clap gesture near chest with controlled smile", "{subject} slow nod with ironic half-smile", "{subject} hand lightly touching chin with analytical look", "{subject} relaxed posture with knowing side glance", "{subject} straight posture with faint unimpressed smile", "{subject} one eyebrow raised with calm steady gaze", "{subject} small inviting palm gesture with amused expression"]'::jsonb,
  9, true, 'sarcasm', 9, 'single', false, 'sarcasm'
),
(
  'sass_bold_v1',
  'couple_v1',
  'Сарказм — дерзкий',
  'Bold sass',
  'Серьёзно?, смело, продолжай, это всё?, неожиданно, впечатляет, рискованно, дерзко, окей.',
  'Seriously?, bold, go on, that''s it?, unexpected, impressive, risky, sassy, okay.',
  '["Серьёзно?", "Смело", "Продолжай", "Это всё?", "Неожиданно", "Впечатляет", "Рискованно", "Дерзко", "Окей"]'::jsonb,
  '["Seriously?", "Bold", "Go on", "That''s it?", "Unexpected", "Impressive", "Risky", "Sassy", "Okay"]'::jsonb,
  '["{subject} raised eyebrow with confident smirk", "{subject} slight forward lean with challenging gaze", "{subject} small inviting hand gesture near torso", "{subject} arms loosely crossed with amused smile", "{subject} subtle slow nod with ironic look", "{subject} light clap once near chest with playful expression", "{subject} head slightly tilted with daring smile", "{subject} steady confident eye contact with calm grin", "{subject} relaxed shrug with knowing expression"]'::jsonb,
  10, true, 'sarcasm', 9, 'single', false, 'sarcasm'
),
(
  'sass_royal_v1',
  'couple_v1',
  'Королевский сарказм',
  'Royal sass',
  'Понятно, безусловно, любопытно, достойно, впечатляюще, ожидаемо, как мило, занимательно, разумеется.',
  'I see, certainly, curious, worthy, impressive, expected, how sweet, entertaining, of course.',
  '["Понятно", "Безусловно", "Любопытно", "Достойно", "Впечатляюще", "Ожидаемо", "Как мило", "Занимательно", "Разумеется"]'::jsonb,
  '["I see", "Certainly", "Curious", "Worthy", "Impressive", "Expected", "How sweet", "Entertaining", "Of course"]'::jsonb,
  '["{subject} upright posture with calm superior gaze", "{subject} small slow nod with faint smile", "{subject} slight head tilt with measured look", "{subject} hands gently clasped near torso with composed expression", "{subject} minimal eyebrow raise with controlled smile", "{subject} relaxed still posture with distant look", "{subject} faint polite smile with steady eye contact", "{subject} subtle glance to the side with reserved expression", "{subject} composed neutral stance with quiet authority"]'::jsonb,
  11, true, 'sarcasm', 9, 'single', false, 'sarcasm'
),
(
  'sass_lazy_v1',
  'couple_v1',
  'Ленивый сарказм',
  'Lazy sass',
  'Ага, ясно, ну ладно, конечно, допустим, окей, бывает, да-да, как скажешь.',
  'Yeah, clear, okay then, sure, suppose, okay, happens, yeah yeah, whatever you say.',
  '["Ага", "Ясно", "Ну ладно", "Конечно", "Допустим", "Окей", "Бывает", "Да-да", "Как скажешь"]'::jsonb,
  '["Yeah", "Clear", "Okay then", "Sure", "Suppose", "Okay", "Happens", "Yeah yeah", "Whatever you say"]'::jsonb,
  '["{subject} half-lidded eyes with slight shrug", "{subject} slow nod with bored expression", "{subject} slouched posture with minimal reaction", "{subject} tiny eye-roll without head movement", "{subject} relaxed side glance with neutral face", "{subject} faint smirk with tired eyes", "{subject} small dismissive hand wave near torso", "{subject} blank stare with minimal emotion", "{subject} casual shoulder shrug with soft sigh expression"]'::jsonb,
  12, true, 'sarcasm', 9, 'single', false, 'sarcasm'
),
(
  'sass_work_v1',
  'couple_v1',
  'Рабочий сарказм',
  'Work sass',
  'Понял(а), принято, интересно, обсудим, логично, звучит смело, рассмотрим, впечатляет, благодарю.',
  'Got it, noted, interesting, we''ll discuss, logical, sounds bold, we''ll see, impressive, thank you.',
  '["Понял(а)", "Принято", "Интересно", "Обсудим", "Логично", "Звучит смело", "Рассмотрим", "Впечатляет", "Благодарю"]'::jsonb,
  '["Got it", "Noted", "Interesting", "We''ll discuss", "Logical", "Sounds bold", "We''ll see", "Impressive", "Thank you"]'::jsonb,
  '["{subject} straight posture with professional calm gaze", "{subject} slight nod with controlled polite smile", "{subject} hand lightly touching chin in analytical pose", "{subject} small open palm gesture near chest", "{subject} raised eyebrow with restrained smile", "{subject} subtle lean forward with evaluating look", "{subject} composed neutral expression with steady eye contact", "{subject} slow measured nod with faint irony", "{subject} polite closed-mouth smile with relaxed shoulders"]'::jsonb,
  13, true, 'sarcasm', 9, 'single', false, 'sarcasm'
)
ON CONFLICT (id) DO UPDATE SET
  pack_template_id = EXCLUDED.pack_template_id,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood,
  sticker_count = EXCLUDED.sticker_count,
  subject_mode = EXCLUDED.subject_mode,
  cluster = EXCLUDED.cluster,
  segment_id = EXCLUDED.segment_id;

-- home (3)
INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_mode_v2',
  'couple_v1',
  'Быт и уют',
  'Home mode',
  'Спим?, где еда?, плед режим, кофе?, диван занят, тихо-тихо, обнимашки, лень двигаться, мимими.',
  'Sleep?, where''s food?, blanket mode, coffee?, couch taken, shhh, cuddles, too lazy, aww.',
  '["Спим?", "Где еда?", "Плед режим", "Кофе?", "Диван занят", "Тихо-тихо", "Обнимашки", "Лень двигаться", "Мимими"]'::jsonb,
  '["Sleep?", "Where''s food?", "Blanket mode", "Coffee?", "Couch taken", "Shhh", "Cuddles", "Too lazy", "Aww"]'::jsonb,
  '["{subject} rubbing eyes sleepily while wrapped loosely in blanket", "{subject} slightly opening imaginary fridge with curious hungry look", "{subject} fully wrapped in blanket burrito style, cozy satisfied smile", "{subject} holding mug close to face with hopeful morning look", "{subject} lying sideways comfortably with playful possessive smile", "{subject} finger to lips with soft whispering expression", "{subject} arms open inviting warm hug with affectionate smile", "{subject} slouched comfortably on couch with lazy relaxed grin", "{subject} making small cute kissy face toward camera with playful warmth"]'::jsonb,
  11, true, 'everyday', 9, 'single', false, 'home'
),
(
  'everyday_home_chaos_v1',
  'couple_v1',
  'Домашний хаос',
  'Home chaos',
  'Я только проснулся(ась), где всё?, кто это сделал?, срочно еда, не трогай, бардак, я не виноват(а), сейчас уберу, ладно живём.',
  'Just woke up, where is everything, who did this, need food, don''t touch, mess, not my fault, I''ll clean it, we survive.',
  '["Я только проснулся(ась)", "Где всё?", "Кто это сделал?", "Срочно еда", "Не трогай", "Бардак", "Я не виноват(а)", "Сейчас уберу", "Ладно, живём"]'::jsonb,
  '["Just woke up", "Where is everything?", "Who did this?", "Need food now", "Don''t touch", "Mess", "Not my fault", "I''ll clean it", "We survive"]'::jsonb,
  '["{subject} with messy hair, confused sleepy expression looking around", "{subject} hands slightly spread, frustrated searching look", "{subject} pointing to the side with dramatic accusing look", "{subject} urgently looking toward fridge area with intense hungry eyes", "{subject} holding object close protectively with serious face", "{subject} looking around at imaginary mess with overwhelmed expression", "{subject} hands raised slightly in defensive innocent gesture", "{subject} holding cleaning cloth reluctantly with tired but responsible look", "{subject} shrugging with chaotic but amused smile"]'::jsonb,
  15, true, 'everyday', 9, 'single', false, 'home'
),
(
  'everyday_home_chaos_v2',
  'couple_v1',
  'Домашний хаос',
  'Home chaos',
  'Плед упал, где телефон?, ой…, что-то горит, я это не трогал(а), всё под контролем, минута паники, сейчас разберёмся, ну и ладно.',
  'Blanket down, where''s my phone, oops, something''s burning, I didn''t touch it, totally under control, tiny panic, we''ll fix it, whatever.',
  '["Плед упал", "Где мой телефон?", "Ой…", "Кажется, горит", "Я это не трогал(а)", "Всё под контролем", "Минута паники", "Сейчас разберёмся", "Ну и ладно"]'::jsonb,
  '["Blanket fell", "Where''s my phone?", "Oops…", "Something''s burning", "I didn''t touch it", "All under control", "Tiny panic", "We''ll fix it", "Whatever"]'::jsonb,
  '["{subject} looking down in surprise as if something just fell from shoulders", "{subject} patting pockets and looking around with confused urgency", "{subject} frozen mid-motion with wide eyes and small awkward smile", "{subject} suddenly turning head to side with alarmed expression", "{subject} pointing at self with exaggerated innocent face", "{subject} standing stiff with forced confident smile and tense posture", "{subject} hands slightly raised near face with quick anxious expression", "{subject} rolling up imaginary sleeves with determined chaotic grin", "{subject} shrugging dramatically with amused surrender smile"]'::jsonb,
  16, true, 'everyday', 9, 'single', false, 'home'
)
ON CONFLICT (id) DO UPDATE SET
  pack_template_id = EXCLUDED.pack_template_id,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood,
  sticker_count = EXCLUDED.sticker_count,
  subject_mode = EXCLUDED.subject_mode,
  cluster = EXCLUDED.cluster,
  segment_id = EXCLUDED.segment_id;

-- events (7)
INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'holiday_solo_v3',
  'couple_v1',
  'Праздник',
  'Holiday',
  'Это тебе, с днём рождения, с любовью, горжусь тобой, за тебя, сюрприз, для тебя, праздник, ура.',
  'This is for you, happy birthday, with love, proud of you, cheers to you, surprise, for you, celebration, yay.',
  '["Это тебе 🎁", "С днём рождения 🎂", "С любовью ❤️", "Горжусь тобой", "За тебя 🥂", "Сюрприз!", "Для тебя", "Праздник!", "Ура!"]'::jsonb,
  '["For you 🎁", "Happy birthday 🎂", "With love ❤️", "Proud of you", "Cheers to you 🥂", "Surprise!", "For you", "Celebration!", "Yay!"]'::jsonb,
  '["{subject} holding medium gift box with both hands slightly extended forward toward camera", "{subject} holding round birthday cake centered at chest level, soft proud smile", "{subject} holding one large solid heart prop close to chest with warm affectionate expression", "{subject} upright posture, hand placed firmly on chest with sincere proud expression, no props", "{subject} holding one glass raised slightly forward at chest height in clear toast gesture", "{subject} hiding gift box slightly behind back with playful secret smile", "{subject} holding bouquet centered close to body, gently offering it forward", "{subject} wearing simple solid party hat, hands relaxed near torso, bright festive smile", "{subject} small celebratory fist near chest with joyful confident smile, no props"]'::jsonb,
  10, true, 'holiday', 9, 'single', false, 'events'
),
(
  'holiday_romantic_v1',
  'couple_v1',
  'Романтический праздник',
  'Romantic holiday',
  'Для тебя, любимому, любимой, с любовью, скучаю, обнимаю, горжусь тобой, ты мой человек, люблю.',
  'For you, my love, with love, miss you, hugs, proud of you, you''re mine, love you.',
  '["Для тебя ❤️", "Любимому", "Любимой", "С любовью", "Скучаю по тебе", "Обнимаю", "Горжусь тобой", "Ты мой человек", "Люблю тебя"]'::jsonb,
  '["For you ❤️", "To my love", "To my love", "With love", "Miss you", "Hugs", "Proud of you", "You''re my person", "Love you"]'::jsonb,
  '["{subject} holding medium gift box close to chest with soft intimate smile", "{subject} holding bouquet centered at torso with warm affectionate look", "{subject} holding bouquet close with gentle proud expression", "{subject} holding one large solid heart prop at chest level, deep eye contact", "{subject} lightly touching own chest with longing soft expression, no props", "{subject} arms slightly open inviting hug, warm smile", "{subject} upright posture, hand on chest with sincere proud expression, no props", "{subject} pointing gently toward camera with tender confident smile", "{subject} both hands placed over heart with calm loving expression"]'::jsonb,
  17, true, 'holiday', 9, 'single', false, 'events'
),
(
  'holiday_tender_evening_v1',
  'couple_v1',
  'Нежный вечер',
  'Tender evening',
  'Я рядом, обниму, скучаю, думаю о тебе, тихий вечер, для тебя, тепло, спокойной ночи, люблю.',
  'I''m here, hug you, miss you, thinking of you, quiet evening, for you, warm, good night, love you.',
  '["Я рядом", "Обниму", "Скучаю", "Думаю о тебе", "Тихий вечер", "Для тебя", "Тепло", "Спокойной ночи", "Люблю тебя"]'::jsonb,
  '["I''m here", "Hug you", "Miss you", "Thinking of you", "Quiet evening", "For you", "Warm", "Good night", "Love you"]'::jsonb,
  '["{subject} soft relaxed posture, gentle eye contact with calm reassuring smile", "{subject} arms slightly open close to body inviting a hug, warm expression", "{subject} hand lightly touching chest with tender longing look", "{subject} lightly touching temple as if thinking, soft affectionate smile", "{subject} wrapped loosely in blanket around shoulders, peaceful evening expression", "{subject} holding small solid heart prop near chest, intimate smile", "{subject} holding warm mug close to face with cozy content expression", "{subject} gentle wave near shoulder with calm sleepy smile", "{subject} both hands over heart with deep loving eye contact"]'::jsonb,
  18, true, 'holiday', 9, 'single', false, 'events'
),
(
  'holiday_tender_evening_playful_v2',
  'couple_v1',
  'Нежный вечер',
  'Tender evening',
  'Я рядом, обниму?, скучаю, думаю о тебе, иди ко мне, тепло, только ты, спокойной ночи, люблю.',
  'I''m here, hug?, miss you, thinking of you, come here, warm, only you, good night, love you.',
  '["Я рядом", "Обниму?", "Скучаю", "Думаю о тебе", "Иди ко мне", "Тепло", "Только ты", "Спокойной ночи", "Люблю тебя"]'::jsonb,
  '["I''m here", "Hug?", "Miss you", "Thinking of you", "Come here", "Warm", "Only you", "Good night", "Love you"]'::jsonb,
  '["{subject} relaxed posture with gentle reassuring smile and soft eye contact", "{subject} slightly opening arms close to body with playful questioning smile", "{subject} hand lightly touching chest with tender longing look", "{subject} lightly touching temple with affectionate thoughtful smile", "{subject} curling index finger slightly in inviting gesture near torso with warm playful expression", "{subject} holding warm mug near face with cozy satisfied smile", "{subject} gently pointing toward camera with soft confident flirty smile", "{subject} small slow wave near shoulder with sleepy calm expression", "{subject} both hands over heart with deep loving yet slightly playful eye contact"]'::jsonb,
  19, true, 'holiday', 9, 'single', false, 'events'
),
(
  'holiday_night_talk_v1',
  'couple_v1',
  'Ночной разговор',
  'Night talk',
  'Ты не спишь?, можно честно?, я думаю о тебе, скучаю, поговорим?, я рядом, мне важно, спокойной ночи, люблю.',
  'You awake?, can I be honest?, thinking of you, miss you, can we talk?, I''m here, it matters to me, good night, love you.',
  '["Ты не спишь?", "Можно честно?", "Я думаю о тебе", "Скучаю", "Поговорим?", "Я рядом", "Мне важно", "Спокойной ночи", "Люблю тебя"]'::jsonb,
  '["You awake?", "Can I be honest?", "Thinking of you", "Miss you", "Can we talk?", "I''m here", "It matters to me", "Good night", "Love you"]'::jsonb,
  '["{subject} soft sleepy expression with gentle eye contact, relaxed shoulders", "{subject} slightly leaning forward with calm serious look, hands close to torso", "{subject} lightly touching temple with thoughtful tender expression", "{subject} hand on chest with quiet longing look", "{subject} one hand slightly raised in small inviting gesture near chest", "{subject} relaxed steady posture with reassuring soft smile", "{subject} hand pressed gently to chest with sincere focused expression", "{subject} gentle small wave near shoulder with calm sleepy smile", "{subject} both hands over heart with deep emotional eye contact"]'::jsonb,
  20, true, 'holiday', 9, 'single', false, 'events'
),
(
  'holiday_after_argument_v1',
  'couple_v1',
  'После ссоры',
  'After argument',
  'Можно поговорить?, прости, я погорячился(ась), мне важно, давай спокойно, я не хотел(а), я рядом, обниму?, мир?',
  'Can we talk?, sorry, I overreacted, it matters to me, let''s calm down, I didn''t mean it, I''m here, hug?, peace?',
  '["Можно поговорить?", "Прости", "Я погорячился(ась)", "Мне важно", "Давай спокойно", "Я не хотел(а)", "Я рядом", "Обниму?", "Мир?"]'::jsonb,
  '["Can we talk?", "Sorry", "I overreacted", "It matters to me", "Let''s calm down", "I didn''t mean it", "I''m here", "Hug?", "Peace?"]'::jsonb,
  '["{subject} slightly leaning forward with calm serious expression, hands close to torso", "{subject} head slightly lowered with sincere soft eye contact", "{subject} one hand lightly touching chest with regretful expression", "{subject} upright posture, steady emotional eye contact, calm face", "{subject} open palm held gently forward at chest level in peaceful gesture", "{subject} subtle head shake with soft apologetic look", "{subject} relaxed posture with reassuring gentle smile", "{subject} arms slightly open near torso inviting soft hug", "{subject} small tentative smile with questioning look"]'::jsonb,
  24, true, 'holiday', 9, 'single', false, 'events'
),
(
  'holiday_after_argument_sensual_v1',
  'couple_v1',
  'После ссоры',
  'After argument',
  'Давай ближе, я всё ещё злюсь, но тянет, подойди, не отпускай, смотри так, иди сюда, я твой(я), мир?',
  'Come closer, still mad but drawn, come here, don''t let go, that look, step closer, yours, peace?',
  '["Давай ближе", "Я всё ещё злюсь", "Но меня тянет", "Подойди", "Не отпускай", "Смотри так", "Иди сюда", "Я твой(я)", "Мир?"]'::jsonb,
  '["Come closer", "Still mad", "But drawn to you", "Step closer", "Don''t let go", "That look", "Come here", "I''m yours", "Peace?"]'::jsonb,
  '["{subject} slightly leaning forward with slow intense eye contact, relaxed shoulders", "{subject} arms crossed loosely with subtle smirk and challenging gaze", "{subject} soft half-smile with lingering eye contact, head slightly tilted", "{subject} small beckoning gesture near torso with calm confident expression", "{subject} hand resting lightly near own arm or shoulder, possessive calm look", "{subject} steady direct gaze with lowered chin and quiet intensity", "{subject} curling index finger gently in inviting gesture close to body", "{subject} relaxed posture with subtle confident smile and open chest", "{subject} faint questioning smile with softened eyes"]'::jsonb,
  25, true, 'holiday', 9, 'single', false, 'events'
)
ON CONFLICT (id) DO UPDATE SET
  pack_template_id = EXCLUDED.pack_template_id,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood,
  sticker_count = EXCLUDED.sticker_count,
  subject_mode = EXCLUDED.subject_mode,
  cluster = EXCLUDED.cluster,
  segment_id = EXCLUDED.segment_id;

-- reactions (4)
INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_daily_v2',
  'couple_v1',
  'На каждый день',
  'Daily reactions',
  'Доброе утро, ещё сплю, скучаю, я на работе, устал, хочу есть, погнали, ну ок, спокойной ночи.',
  'Good morning, still sleepy, miss you, at work, tired, starving, let''s go, alright, good night.',
  '["Доброе утро ☀️", "Я ещё сплю", "Скучаю по тебе", "Я на работе", "Я устал(а)", "Я голоден(на)", "Погнали", "Ну ок", "Спокойной ночи 🌙"]'::jsonb,
  '["Good morning ☀️", "Still sleepy", "Miss you", "At work", "I''m tired", "I''m hungry", "Let''s go", "Alright", "Good night 🌙"]'::jsonb,
  '["{subject} stretching arms upward with sleepy morning smile", "{subject} rubbing one eye with messy sleepy expression", "{subject} soft smile with hand slightly extended forward as if reaching out", "{subject} focused expression looking at laptop or phone, slightly serious posture", "{subject} slouching slightly with tired eyes and relaxed shoulders", "{subject} lightly touching stomach with playful hungry look", "{subject} leaning slightly forward with energetic grin and confident gesture forward", "{subject} small shrug with calm accepting smile", "{subject} wrapped slightly as if cozy, gentle wave with calm night smile"]'::jsonb,
  12, true, 'reactions', 9, 'single', false, 'reactions'
),
(
  'reactions_introvert_day_v1',
  'couple_v1',
  'День интроверта',
  'Introvert day',
  'Доброе утро миру, не трогайте меня, я в своём мире, слишком много людей, перерыв от всех, отвечу позже, мне норм одному, уже устал(а), спокойной тишины.',
  'Morning world, don''t disturb, in my bubble, too many people, social break, reply later, fine alone, drained, quiet night.',
  '["Доброе утро, мир", "Не трогайте меня", "Я в своём мире", "Слишком много людей", "Мне нужен перерыв", "Отвечу позже", "Мне норм одному(одной)", "Я уже устал(а)", "Спокойной тишины"]'::jsonb,
  '["Morning world", "Do not disturb", "In my bubble", "Too many people", "Need a break", "Reply later", "Fine alone", "Drained", "Quiet night"]'::jsonb,
  '["{subject} holding warm mug close, soft calm morning look", "{subject} slightly turning away with small defensive hand gesture", "{subject} looking down at phone with focused isolated expression", "{subject} covering one ear lightly with overwhelmed look", "{subject} closing eyes with slow deep breath gesture", "{subject} raising one finger slightly as if saying later", "{subject} relaxed posture hugging knees or self comfortably", "{subject} shoulders slightly dropped with emotionally drained look", "{subject} wrapped in cozy posture, soft calm night expression"]'::jsonb,
  21, true, 'reactions', 9, 'single', false, 'reactions'
),
(
  'reactions_work_day_v1',
  'couple_v1',
  'Рабочий день',
  'Work day',
  'Начинаем, в процессе, дедлайн горит, совещание, я занят(а), кофе нужен, почти закончил(а), отправил(а), я выключаюсь.',
  'Let''s start, in progress, deadline, meeting, busy, need coffee, almost done, sent, logging off.',
  '["Начинаем", "Я в процессе", "Дедлайн горит", "На созвоне", "Я занят(а)", "Нужен кофе", "Почти готово", "Отправил(а)", "Я выключаюсь"]'::jsonb,
  '["Starting", "In progress", "Deadline", "On a call", "Busy", "Need coffee", "Almost done", "Sent", "Logging off"]'::jsonb,
  '["{subject} straight posture, determined focused look forward", "{subject} typing intensely on laptop with concentrated expression", "{subject} wide eyes looking at screen with urgency", "{subject} holding phone near ear with serious meeting face", "{subject} palm slightly forward signaling busy", "{subject} holding cup near face with tired hopeful look", "{subject} leaning forward finishing task with focused energy", "{subject} relaxed relieved smile after sending message", "{subject} stretching shoulders backward with exhausted but satisfied expression"]'::jsonb,
  22, true, 'reactions', 9, 'single', false, 'reactions'
),
(
  'reactions_relationship_day_v1',
  'couple_v1',
  'День в отношениях',
  'Relationship day',
  'Доброе утро, скучаю, думаю о тебе, ты где?, ревную чуть-чуть, обниму?, горжусь тобой, жду встречи, люблю.',
  'Morning love, miss you, thinking of you, where are you, little jealous, hug?, proud of you, can''t wait, love you.',
  '["Доброе утро ❤️", "Скучаю по тебе", "Думаю о тебе", "Ты где?", "Чуть-чуть ревную", "Можно обниму?", "Горжусь тобой", "Жду встречи", "Люблю тебя"]'::jsonb,
  '["Good morning ❤️", "Miss you", "Thinking of you", "Where are you?", "Little jealous", "Hug?", "Proud of you", "Can''t wait", "Love you"]'::jsonb,
  '["{subject} soft morning smile sending air kiss gesture", "{subject} gentle longing look with hand slightly extended forward", "{subject} touching temple lightly as if thinking warmly", "{subject} slightly raised eyebrow with playful questioning look", "{subject} playful narrowed eyes with subtle crossed arms pose", "{subject} open arms inviting hug with warm smile", "{subject} proud upright posture with affectionate smile", "{subject} excited anticipatory look leaning slightly forward", "{subject} hand on heart with deep loving eye contact"]'::jsonb,
  23, true, 'reactions', 9, 'single', false, 'reactions'
)
ON CONFLICT (id) DO UPDATE SET
  pack_template_id = EXCLUDED.pack_template_id,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  carousel_description_ru = EXCLUDED.carousel_description_ru,
  carousel_description_en = EXCLUDED.carousel_description_en,
  labels = EXCLUDED.labels,
  labels_en = EXCLUDED.labels_en,
  scene_descriptions = EXCLUDED.scene_descriptions,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  mood = EXCLUDED.mood,
  sticker_count = EXCLUDED.sticker_count,
  subject_mode = EXCLUDED.subject_mode,
  cluster = EXCLUDED.cluster,
  segment_id = EXCLUDED.segment_id;
