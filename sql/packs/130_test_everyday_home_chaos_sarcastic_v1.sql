-- 130_test_everyday_home_chaos_sarcastic_v1.sql (ТЕСТ)
-- Один пак: Home Chaos — Sarcastic Morning. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_chaos_sarcastic_v1',
  'couple_v1',
  'Домашний хаос — Сарказм',
  'Home chaos — sarcastic morning',
  'Проспал(а), кофе пролился, завтрак сгорел. Но мы держимся. С иронией.',
  'Overslept. Spilled coffee. Burned breakfast. We proceed anyway.',
  '["Ага. Новая катастрофа.", "Смело с твоей стороны, день.", "Винтаж. С этого утра.", "Обожаю.", "Эра шефа длилась 3 минуты.", "Отправил. Отлично.", "Корпоративный косплей.", "Профи. Якобы.", "Процветаю. Очевидно."]'::jsonb,
  '["Ah yes. A new disaster.", "Bold of today to start.", "Vintage. From this morning.", "Love that for me.", "Chef era lasted 3 minutes.", "Sent. Fantastic.", "Corporate cosplay.", "Professional. Allegedly.", "Thriving. Obviously."]'::jsonb,
  '[
    "{subject} sitting on the edge of the bed with blanket still around the waist, holding the phone after turning off the alarm. The gaze is forward and flat — no shock, just quiet acceptance of being late.",
    "{subject} standing with one palm pressed to the forehead and the other hand resting on the hip. The body leans slightly to one side as if reconsidering participation in the day.",
    "{subject} holding a stained shirt close to the chest, inspecting it without dramatic reaction. The torso slightly turned, weighing whether this is still socially acceptable.",
    "{subject} looking down at a coffee spill already forming on clothing or bedding. One hand still holds the mug, the other hangs mid-air — too late to fix it.",
    "{subject} turned slightly sideways while holding a frying pan at waist height. The expression is restrained; the meal clearly did not survive.",
    "{subject} holding a phone lower than eye level, staring forward after sending a message. One hand lightly touches the lips — realization settling in.",
    "{subject} slipping into a jacket while slightly off balance, keys loosely hanging from one hand. The body already angled toward leaving.",
    "{subject} adjusting the jacket collar with measured movements, posture straightening but not fully confident. Expression calm, almost skeptical.",
    "{subject} standing upright, jacket on, shoulders set. A subtle, ironic half-smile — surviving counts as thriving."
  ]'::jsonb,
  210, true, 'everyday_sarcastic', 9, 'single', false, 'home'
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
