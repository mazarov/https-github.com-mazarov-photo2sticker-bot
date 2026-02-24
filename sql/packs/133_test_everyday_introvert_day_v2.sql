-- 133_test_everyday_introvert_day_v2.sql (ТЕСТ)
-- Пак: День интроверта v2 — визуально разнообразные сцены (сетка 3×3, явные направления взгляда). Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_introvert_day_v2',
  'couple_v1',
  'День интроверта',
  'Introvert''s day',
  'Тишина, свой угол, никуда не надо. День без лишних людей. Идеально.',
  'Quiet, your own corner, nowhere to be. A day without extra people. Perfect.',
  '["Никуда не надо", "Тишина", "Остаюсь дома", "Минуту перерыв", "Своё дело", "Отменила. Не стыдно", "Так лучше", "Мой вечер", "День удался"]'::jsonb,
  '["Nowhere to be", "Quiet", "Staying in", "One sec", "My thing", "Cancelled. No guilt", "This is better", "My evening", "Good day"]'::jsonb,
  '[
    "{subject} stretching arms above head in bed, gaze at camera, slight sleepy smile — just woke up, no rush",
    "{subject} holding mug with both hands by window, looking down at steam/sip — morning quiet, alone",
    "{subject} phone in one hand at waist, gaze to the left at screen, thumb hovering — deciding to stay home",
    "{subject} seated, eyes closed, head resting back, one hand on chest — short reset, midday pause",
    "{subject} curled in armchair with tablet, gaze down at screen, one leg tucked — absorbed in own thing",
    "{subject} putting phone down face-down on surface, gaze at camera, soft exhale — plans cancelled, fine",
    "{subject} standing beside sofa in soft evening light, arms loosely at sides, gaze sideways to the right — day winding down",
    "{subject} wrapped in blanket on couch, knees up, gaze at camera, small content smile — own evening",
    "{subject} hand brushing hair or adjusting collar, gaze down at own hands, slow movement — ready for sleep, day done"
  ]'::jsonb,
  196, true, 'everyday', 9, 'single', false, 'home'
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
