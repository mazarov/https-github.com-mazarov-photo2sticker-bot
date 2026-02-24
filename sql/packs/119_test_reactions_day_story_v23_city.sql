-- 119_test_reactions_day_story_v23_city.sql (ТЕСТ)
-- Один пак: Реакции — Один день 2.3 / Городской день. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_day_story_v23_city',
  'couple_v1',
  'Реакции — Городской день',
  'Reactions — City day',
  'Утро в движении, рабочие паузы, лифт, улица и спокойное «я всё вижу».',
  'Morning in motion, work pauses, elevator moments and a quiet "I see you".',
  '["Вышла", "Кофе на ходу", "Ну давай", "В работе", "Лифт", "Есть", "Пауза", "Я всё вижу", "Ушла"]'::jsonb,
  '["Out", "Coffee to go", "Alright then", "Working", "Elevator", "Yes", "Pause", "I see you", "Gone"]'::jsonb,
  '[
    "{subject} надевает куртку в движении и одновременно делает шаг вперёд, корпус уже развернут к выходу — утро начинается вне дома",
    "{subject} держит стакан кофе на уровне груди и идёт в лёгком шаге, взгляд на секунду уходит в сторону — городская динамика",
    "{subject} поправляет ремень сумки или лямку рюкзака, корпус слегка наклонён вперёд — настрой перед днём",
    "{subject} наклоняется над ноутбуком и быстро печатает, плечи вовлечены, ощущение ритма офиса",
    "{subject} стоит прямо, руки свободно опущены, короткий глубокий вдох и лёгкий выдох — пауза в лифте или коридоре",
    "{subject} едва заметно сжимает пальцы у груди и переносит вес на одну ногу — тихая победа посреди дня",
    "{subject} опирается боком на край стола или стойки, слегка разворачивая корпус, короткая пауза между задачами",
    "{subject} в полупрофиле, подбородок слегка опущен, спокойный прямой взгляд и едва заметная понимающая полуулыбка — мягкое «я всё вижу»",
    "{subject} уже разворачивается корпусом и делает шаг вперёд, поправляя куртку или сумку — движение дальше по своим делам"
  ]'::jsonb,
  121, true, 'reactions', 9, 'single', false, 'reactions'
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
