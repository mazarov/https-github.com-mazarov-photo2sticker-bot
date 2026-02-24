-- 126_test_everyday_home_chaos_final_v1.sql (ТЕСТ)
-- Один пак: Домашний хаос — Final. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_chaos_final_v1',
  'couple_v1',
  'Домашний хаос',
  'Home chaos',
  'Проспал(а), где одежда, кофе пролился, еда сгорела, но выживаем.',
  'Overslept, can''t find clothes, coffee spilled, food burned — surviving anyway.',
  '["Проспал(а)", "Где одежда?", "Носок пропал", "Кофе!", "Горит?!", "Не тот чат", "Опаздываю", "Да ну всё", "Ладно, живём"]'::jsonb,
  '["Overslept", "Where are my clothes?", "Missing sock", "Coffee!", "Burning?!", "Wrong chat", "Running late", "I give up", "We survive"]'::jsonb,
  '[
    "{subject} half-sitting up with blanket tangled around one arm, reaching blindly for a phone with the other hand, eyes barely open — clearly overslept",
    "{subject} holding one shirt in one hand and another piece of clothing in the other, looking down at the mess as if time is running out",
    "{subject} holding a single sock at eye level while the other hand searches the air beside them — the pair is nowhere to be found",
    "{subject} holding a tilted coffee mug while the other hand reacts too late, body leaning forward as if trying to stop an inevitable spill",
    "{subject} turning sharply toward an imaginary stove while holding a spatula or pan handle, body slightly pulled back from the heat — something is definitely burning",
    "{subject} staring at a phone screen with sudden stillness, one hand slowly covering part of the face — message sent to the wrong chat",
    "{subject} slipping one arm into a jacket while hopping slightly on one foot, keys loosely held in the other hand — clearly running late",
    "{subject} dropping both arms to the sides with shoulders slumping forward, small breath out — temporary surrender",
    "{subject} straightening posture, adjusting clothing with one hand and holding keys firmly in the other, subtle determined half-smile — surviving the day"
  ]'::jsonb,
  200, true, 'everyday', 9, 'single', false, 'home'
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
