-- 116_test_reactions_day_story_v3.sql (ТЕСТ)
-- Один пак: Реакции — Один день 3.0. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'reactions_day_story_v3',
  'couple_v1',
  'Реакции — Один день',
  'Reactions — One day',
  'Утро, работа, паузы, микрореакции и вечер. День в движении.',
  'Morning, work, pauses, micro-reactions and evening. A day in motion.',
  '["Проснулась", "Кофе и новости", "Хм", "В работе", "Ну конечно", "Есть", "Пауза", "Ладно", "Домой"]'::jsonb,
  '["Morning", "Coffee & news", "Hmm", "Working", "Of course", "Yes", "Pause", "Alright", "Heading home"]'::jsonb,
  '[
    "{subject} мягко тянется вверх и одновременно делает шаг вперёд, руки начинают опускаться, тело в диагонали — движение пробуждения",
    "{subject} держит чашку на уровне груди и делает глоток, в другой руке телефон, но взгляд уже отрывается от экрана — реакция в процессе",
    "{subject} слегка разворачивает корпус в сторону и опускает руку с телефоном вниз, короткая пауза перед ответом",
    "{subject} наклоняется вперёд над ноутбуком, активно печатает, плечи вовлечены, концентрация читается через движение",
    "{subject} на секунду прикрывает глаза и делает лёгкий выдох через нос, пальцы одной руки касаются виска — сдержанное «ну конечно»",
    "{subject} делает маленький сдержанный жест победы кулаком у груди и переносит вес на одну ногу, лёгкая улыбка",
    "{subject} отодвигает стул назад и медленно встаёт, расправляя плечи — физическая пауза середины дня",
    "{subject} убирает телефон в карман или кладёт его вниз вне кадра, взгляд направлен вперёд — решение принято",
    "{subject} натягивает худи или накидывает куртку на плечи, корпус уже разворачивается в полушаге, будто уходит из кадра"
  ]'::jsonb,
  130, true, 'reactions', 9, 'single', false, 'reactions'
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
