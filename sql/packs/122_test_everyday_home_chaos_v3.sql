-- 122_test_everyday_home_chaos_v3.sql (ТЕСТ)
-- Один пак: Домашний хаос 3.0. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_chaos_v3',
  'couple_v1',
  'Домашний хаос',
  'Home chaos',
  'Плед упал, где телефон?, ой…, что-то горит, ну ладно. Один день дома.',
  'Blanket down, where''s my phone, oops, something''s burning… just one of those days.',
  '["Плед упал", "Где мой телефон?", "Ой…", "Что-то горит", "Это не я", "Соберусь", "Переживу", "Ну конечно", "Ладно"]'::jsonb,
  '["Blanket fell", "Where''s my phone?", "Oops…", "Something''s burning", "Not me", "Pulling it together", "I''ll survive", "Of course", "Fine"]'::jsonb,
  '[
    "{subject} quickly bends slightly forward catching a slipping blanket with one hand, small amused exhale — real morning chaos",
    "{subject} patting one pocket while holding a cup in the other hand, scanning the room with focused urgency — searching for phone",
    "{subject} freezing mid-step while looking down at a small spill on clothes, subtle ''oops'' expression — caught in the moment",
    "{subject} turning head sharply toward an imagined kitchen direction, eyebrows slightly raised, hand half-lifted — sensing something burning",
    "{subject} holding both hands open at chest level in a natural defensive gesture, small knowing smile — ''not me'' energy",
    "{subject} tying hair back or adjusting sleeves with a focused calm expression — pulling it together",
    "{subject} leaning lightly on one hip, exhaling through nose with resilient half-smile — I''ll survive this",
    "{subject} lifting one eyebrow while glancing at a phone just received, controlled ironic smile — of course",
    "{subject} picking up keys or adjusting a jacket while stepping slightly forward — fine, let''s move on"
  ]'::jsonb,
  170, true, 'everyday', 9, 'single', false, 'home'
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
