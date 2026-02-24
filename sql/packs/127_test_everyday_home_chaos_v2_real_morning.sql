-- 127_test_everyday_home_chaos_v2_real_morning.sql (ТЕСТ)
-- Обновление пака everyday_home_chaos_v2: Home Chaos — Real Morning. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_chaos_v2',
  'couple_v1',
  'Домашний хаос — Реальное утро',
  'Home chaos — real morning',
  'Проспал(а), кофе пролился, не тот чат, ключи потеряны. Реальное утро.',
  'Overslept, coffee spill, wrong chat, keys missing. Real morning.',
  '["Проспал(а)", "Ещё просыпаюсь", "Нет чистой одежды", "Кофе пролился", "Сковородка горит", "Не тот чат", "Где ключи?", "Опаздываю", "Ладно, поехали"]'::jsonb,
  '["Overslept", "Still waking up", "No clean clothes", "Coffee spill", "Burning pan", "Wrong chat", "Where are my keys?", "Running late", "Fine. Let''s go."]'::jsonb,
  '[
    "{subject} half-sitting in bed with blanket still wrapped around the waist, staring at the phone alarm in disbelief. One hand presses against the mattress as if trying to stand but the body is not ready yet.",
    "{subject} standing slightly hunched, rubbing the face with one hand while holding the phone loosely in the other. Shoulders heavy, posture not fully awake yet.",
    "{subject} holding one random piece of clothing and looking down at it, clearly realizing it''s not clean. The other hand rests on the hip in quiet frustration.",
    "{subject} holding a mug that is slightly tilted too far, a small spill already happening. The free hand reacts too late, fingers spread in instinctive damage control.",
    "{subject} leaning slightly back from a frying pan, lips pressed together, eyes narrowed. One hand holds the pan handle, the other hovers uncertainly as if deciding whether to save it or give up.",
    "{subject} frozen mid-scroll, staring at the phone screen. One hand slowly covers part of the mouth — the message has already been sent.",
    "{subject} patting jacket pockets with growing concern while holding the phone in the other hand. The body shifts weight from one leg to another — keys are missing.",
    "{subject} slipping one shoe on while slightly off balance, keys finally found and loosely gripped. The torso already angled forward as if about to rush out.",
    "{subject} standing upright, adjusting jacket collar with one hand while exhaling slowly. Expression neutral but steady — acceptance mode activated."
  ]'::jsonb,
  175, true, 'everyday', 9, 'single', false, 'home'
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
