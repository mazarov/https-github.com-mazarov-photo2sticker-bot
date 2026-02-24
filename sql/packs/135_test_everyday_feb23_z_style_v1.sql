-- 135_test_everyday_feb23_z_style_v1.sql (ТЕСТ)
-- Пак: 23 февраля в стиле Z военблогеров — один день, поздравления, чат, свои. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_feb23_z_style_v1',
  'couple_v1',
  '23 февраля',
  'Feb 23',
  'С праздником без пафоса. Один день 23-го: поздравления, чат, свои. В стиле Z — иронично и по-своему.',
  'Happy Defender''s Day, no fuss. One Feb 23: greetings, chats, the boys. Z-style — ironic and real.',
  '["С праздником, да", "Уже в деле", "Спасибо, взаимно", "От наших", "Ну да", "Никуда не пошёл", "Кореша позвали", "Всё, вырубаюсь", "Норм день"]'::jsonb,
  '["Happy day, sure", "Already on it", "Thanks, same", "From the boys", "Yeah right", "Staying in", "The boys called", "That''s it, logging off", "Decent day"]'::jsonb,
  '[
    "{subject} propped on one elbow in bed, phone in other hand at chest level, eyes open, gaze at screen then briefly at camera — just woke up, first congrats",
    "{subject} standing by kitchen counter, mug in one hand, phone in other, eyes open, looking down at screen — morning scroll, slight smirk",
    "{subject} seated on edge of sofa, phone in lap, thumb hovering, eyes open, gaze at camera — picking reply sticker",
    "{subject} at table with plate to the side, phone face-up, eyes open, glance down at notification — message from the boys",
    "{subject} in armchair, phone held up, eyes open, gaze at screen — paused on post, quiet «ну да»",
    "{subject} leaning back on couch, phone in lap, eyes open, gaze at camera — decided staying in",
    "{subject} phone to ear or holding it for voice message, body slightly turned, eyes open, half grin — friend on the line",
    "{subject} on couch, legs up on stool, phone put down beside, eyes open, gaze sideways — winding down",
    "{subject} hand reaching to put phone face-down, eyes open, last glance at camera — «норм день», turning off"
  ]'::jsonb,
  199, true, 'everyday', 9, 'single', false, 'home'
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
