-- 120_test_affection_solo_v3.sql (ТЕСТ)
-- Один пак: Нежность 3.0 — Тепло каждый день. Только pack_content_sets_test. На проде не запускать.
-- labels = мужской вариант; для женского (labels_f) в схеме отдельной колонки нет.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'affection_solo_v3',
  'couple_v1',
  'Нежность',
  'Affection',
  'Люблю, скучаю, мой/моя, иди ко мне, спокойной ночи. Нежность, которую реально отправляют.',
  'Love you, miss you, mine, come here, good night. Affection people actually use.',
  '["Люблю тебя", "Скучаю", "Ты моя", "Красавица", "Иди ко мне", "Горжусь тобой", "Моя", "Обнимаю", "Спокойной ночи"]'::jsonb,
  '["Love you", "Miss you", "You''re mine", "Handsome/Beautiful", "Come here", "Proud of you", "Mine", "Hug", "Good night"]'::jsonb,
  '[
    "{subject} мягко наклоняется вперёд и касается груди ладонью, спокойный тёплый взгляд — искреннее «люблю»",
    "{subject} слегка прижимает ладони к груди и делает маленький шаг вперёд, будто сокращает дистанцию — «скучаю»",
    "{subject} в полупрофиле, корпус слегка развернут, едва заметная уверенная полуулыбка — мягкое «ты моя/мой»",
    "{subject} смотрит с тёплым одобрением и едва кивает, лёгкий жест рукой вперёд — «горжусь»",
    "{subject} раскрывает руки в движении, приглашая в объятия — «иди ко мне»",
    "{subject} делает лёгкий флиртующий наклон головы и короткий взгляд из-под ресниц — мягкое «красавица/красавчик»",
    "{subject} слегка прижимает ладонь к щеке и улыбается тепло — интимное «моя/мой»",
    "{subject} обнимает себя руками за плечи и слегка раскачивается вперёд — «обнимаю»",
    "{subject} мягко поправляет плед или ворот одежды и делает спокойный медленный взгляд с тёплой улыбкой — «спокойной ночи»"
  ]'::jsonb,
  150, true, 'affection', 9, 'single', false, 'affection_support'
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
