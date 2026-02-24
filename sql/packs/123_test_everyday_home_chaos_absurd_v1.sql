-- 123_test_everyday_home_chaos_absurd_v1.sql (ТЕСТ)
-- Один пак: Домашний хаос — Absurd Edition. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_chaos_absurd_v1',
  'couple_v1',
  'Домашний хаос — Абсурд',
  'Home chaos — Absurd',
  'Плед падает, кофе проливается, тост горит, ключи исчезают. День пошёл.',
  'Blanket falling, coffee spilling, toast burning, keys gone. What a day.',
  '["Ну всё", "Класс", "Ой", "Горит?", "Не сегодня", "Соберись", "Это уже смешно", "Конечно", "Ладно, поехали"]'::jsonb,
  '["Here we go", "Great", "Oops", "Burning?", "Not today", "Pull it together", "This is ridiculous", "Of course", "Fine, let''s go"]'::jsonb,
  '[
    "{subject} catching a slipping blanket mid-air with one hand while slightly losing balance, small exhale — chaos starts early",
    "{subject} holding a cup mid-sip as a small imaginary splash lands on shirt, eyes briefly closing in controlled disbelief",
    "{subject} suddenly turning head toward imagined kitchen direction, one hand frozen halfway — something is definitely burning",
    "{subject} lightly fanning air with one hand while leaning back slightly — reacting to invisible smoke",
    "{subject} patting pockets quickly with growing tension while holding phone in other hand — keys missing again",
    "{subject} freezing still for one second, looking upward with a slow breath in — processing absurdity",
    "{subject} tying hair back with decisive movement, jaw set but calm — switching to survival mode",
    "{subject} holding both palms open toward camera in a soft ironic ''of course'' gesture, weight shifted to one hip",
    "{subject} adjusting jacket while stepping forward with resigned half-smile — fine, we move"
  ]'::jsonb,
  180, true, 'everyday', 9, 'single', false, 'home'
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
