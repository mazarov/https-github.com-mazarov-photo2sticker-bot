-- 124_test_everyday_home_chaos_sitcom30_v1.sql (ТЕСТ)
-- Один пак: Домашний хаос — Sitcom 30+. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_chaos_sitcom30_v1',
  'couple_v1',
  'Домашний хаос — 30+',
  'Home chaos — 30+ sitcom',
  'Кофе пролился, ключи исчезли, работа ждёт. Всё под контролем. Почти.',
  'Coffee spilled, keys missing, work waiting. It''s fine. Almost.',
  '["Доброе утро", "Сейчас…", "Серьёзно?", "Не вовремя", "Минуту", "Собралась", "Ладно", "Конечно", "Поехали"]'::jsonb,
  '["Morning", "Hold on", "Seriously?", "Not now", "One sec", "Composed", "Fine", "Of course", "Let''s go"]'::jsonb,
  '[
    "{subject} stretching one arm behind head while standing slightly sideways, calm neutral face — day starting without drama",
    "{subject} taking a sip of coffee and pausing mid-sip with subtle eyebrow lift — something already off",
    "{subject} looking down at a small invisible stain on shirt, lips pressed lightly — quiet ''seriously?''",
    "{subject} holding phone between shoulder and ear while adjusting sleeve — multitasking under mild pressure",
    "{subject} stopping for one second with eyes closed and slow inhale — internal reset moment",
    "{subject} tying hair back with steady controlled movement, posture straightening — regaining control",
    "{subject} slipping into jacket while already shifting weight forward — running slightly late but composed",
    "{subject} glancing at phone with small ironic smile, one eyebrow slightly raised — of course it happened",
    "{subject} holding keys loosely and stepping forward with calm half-smile — let''s go survive the day"
  ]'::jsonb,
  190, true, 'everyday', 9, 'single', false, 'home'
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
