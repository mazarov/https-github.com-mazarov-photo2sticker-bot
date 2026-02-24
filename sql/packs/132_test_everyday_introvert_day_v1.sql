-- 132_test_everyday_introvert_day_v1.sql (ТЕСТ)
-- Пак: День интроверта. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_introvert_day_v1',
  'couple_v1',
  'День интроверта',
  'Introvert''s day',
  'Тишина, свой угол, никуда не надо. День без лишних людей. Идеально.',
  'Quiet, your own corner, nowhere to be. A day without extra people. Perfect.',
  '["Никуда не надо", "Тишина", "Остаюсь дома", "Минуту перерыв", "Своё дело", "Отменила. Не стыдно", "Так лучше", "Мой вечер", "День удался"]'::jsonb,
  '["Nowhere to be", "Quiet", "Staying in", "One sec", "My thing", "Cancelled. No guilt", "This is better", "My evening", "Good day"]'::jsonb,
  '[
    "{subject} stretching slowly under the covers, eyes half-open, slight smile — no rush to get up",
    "{subject} holding a mug with both hands, gaze out the window, body slightly turned — morning quiet",
    "{subject} phone in hand, thumb hovering over a message, small relieved exhale — deciding to stay home",
    "{subject} sitting with eyes closed, head resting lightly back, one hand on chest — short reset",
    "{subject} curled in a chair with a book or tablet, one leg tucked, relaxed shoulders — absorbed",
    "{subject} putting phone down face-down with a soft sigh, shoulders dropping — plans cancelled, fine",
    "{subject} in soft evening light, arms loosely crossed, calm neutral face — day winding down",
    "{subject} wrapped in a blanket, knees up, small content smile — own evening",
    "{subject} brushing hair or adjusting collar, eyes soft, slow movement — ready for sleep, day done"
  ]'::jsonb,
  195, true, 'everyday', 9, 'single', false, 'home'
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
