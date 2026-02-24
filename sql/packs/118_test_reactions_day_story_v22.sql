-- 118_test_reactions_day_story_v22.sql (ТЕСТ)
-- Один пак: Реакции — Один день 2.2. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_day_story_v22',
  'couple_v1',
  'Реакции — Один день 2.2',
  'Reactions — One day 2.2',
  'Утро, работа, паузы, тихие реакции и мягкое «я всё вижу». Один живой день.',
  'Morning, work, pauses, quiet reactions and a soft "I see everything". One real day.',
  '["Проснулась", "Ну началось", "Интересно", "Работаю", "Ну да", "Есть", "Перерыв", "Я всё вижу", "Домой"]'::jsonb,
  '["Morning", "Here we go", "Interesting", "Working", "Well yeah", "Yes", "Break", "I see you", "Heading home"]'::jsonb,
  '[
    "{subject} в мягкой утренней одежде тянется вверх и делает небольшой шаг вперёд, руки начинают опускаться, корпус в лёгкой диагонали — пробуждение в движении",
    "{subject} делает глоток кофе, телефон в другой руке слегка опущен, взгляд на секунду отрывается от экрана — реакция в процессе",
    "{subject} ставит чашку вне кадра и на мгновение замирает с лёгким прищуром, будто переосмысливает прочитанное",
    "{subject} наклоняется вперёд над ноутбуком и активно печатает, плечи вовлечены, рабочая динамика ощущается через тело",
    "{subject} слегка наклоняет голову и проводит рукой по волосам с мягким выдохом — сдержанное внутреннее «ну да»",
    "{subject} едва заметно сжимает пальцы у груди и позволяет уголку губ слегка подняться — тихая личная победа",
    "{subject} опирается руками о край стола и медленно выпрямляется, смена ритма середины дня",
    "{subject} слегка разворачивает корпус в полупрофиль, подбородок чуть опущен, взгляд спокойный и прямой, едва заметная понимающая полуулыбка — мягкое «я всё вижу»",
    "{subject} натягивает худи или поправляет куртку в полушаге, корпус уже разворачивается, будто уходит из кадра"
  ]'::jsonb,
  120, true, 'reactions', 9, 'single', false, 'reactions'
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
