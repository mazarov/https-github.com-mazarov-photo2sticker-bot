-- 137_test_everyday_feb23_z_style_female_v1.sql (ТЕСТ)
-- Пак: 23 февраля в стиле Z военблогеров, на фото одна девушка. Форма РФ, военное окружение, подписи в женском роде. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_feb23_z_style_female_v1',
  'couple_v1',
  '23 февраля',
  'Feb 23',
  'С праздником! Форма, победа, наши. Для своих — в стиле Z. Для аудитории РФ.',
  'Happy Defender''s Day! Uniform, victory, ours. For the boys — Z style. For RF audience.',
  '["С праздником!", "Уже в деле", "Спасибо, взаимно", "От наших", "За победу", "Никуда не пошла", "Кореша позвали", "Всё, вырубаюсь", "Норм день"]'::jsonb,
  '["Happy Defender''s Day!", "Already on it", "Thanks, same", "From the boys", "For the victory", "Staying in", "The boys called", "That''s it, logging off", "Decent day"]'::jsonb,
  '[
    "{subject} young woman wearing Russian military uniform (camouflage), in barracks propped on one elbow on military bunk, phone in other hand at chest level, eyes open, gaze at camera — just woke up, first congrats, Feb 23",
    "{subject} young woman in Russian military uniform (camouflage), in mess hall standing at long table with mug in one hand, phone in other, eyes open, looking down at screen — morning scroll, slight smirk",
    "{subject} young woman in Russian army uniform, in common room seated on simple military stool, phone in lap, thumb hovering, eyes open, gaze at camera — picking reply sticker",
    "{subject} young woman in Russian military uniform, at mess hall table with tray to the side, phone face-up, eyes open, glance down at notification — message from the boys",
    "{subject} young woman wearing Russian camouflage uniform, in barracks common area seated on crate or low stool, phone held up, eyes open, gaze at screen — paused on post, quiet «ну да»",
    "{subject} young woman in Russian army uniform, in common room leaning back on simple bench, phone in lap, eyes open, gaze at camera — decided staying in",
    "{subject} young woman in Russian military uniform, in barracks or tent corner, phone to ear or holding for voice message, body slightly turned, eyes open, half grin — friend on the line",
    "{subject} young woman wearing Russian military uniform (camouflage), in common room on military stool, legs up on another crate, phone put down beside, eyes open, gaze sideways — winding down",
    "{subject} young woman in Russian army uniform, at barracks table or crate, hand reaching to put phone face-down, eyes open, last glance at camera — норм день, turning off"
  ]'::jsonb,
  201, true, 'everyday', 9, 'single', false, 'home'
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
