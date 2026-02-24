-- 129_test_everyday_home_chaos_v4_honest_morning.sql (ТЕСТ)
-- Один пак: Home Chaos — Honest Morning. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_chaos_v4',
  'couple_v1',
  'Домашний хаос — Честное утро',
  'Home chaos — honest morning',
  'Будильник, усталость, нет чистой одежды, кофе пролился, завтрак сгорел. Всё равно выходим.',
  'Alarm, still tired, nothing clean, coffee mess, burned breakfast. Going anyway.',
  '["Будильник", "Всё ещё устал(а)", "Ничего чистого", "Кофе пролился", "Завтрак сгорел", "Отправил(а)", "Нет ключей", "Опаздываю", "Всё равно иду"]'::jsonb,
  '["Alarm", "Still tired", "Nothing clean", "Coffee mess", "Burned breakfast", "Sent it", "No keys", "Late", "Going anyway"]'::jsonb,
  '[
    "{subject} sitting on the edge of the bed with shoulders slightly rounded, phone resting loosely in one hand after turning off the alarm. The gaze is unfocused and forward — not shocked, just already tired.",
    "{subject} standing with one hand pressed briefly against the forehead, the other arm hanging naturally. The body leans slightly to one side, as if the day feels heavier than expected.",
    "{subject} holding a shirt close to the chest while noticing a visible stain. The head tilts slightly to the side — not dramatic, just quiet disappointment.",
    "{subject} looking down at a small coffee spill on clothing or bedding, mug still in hand. The free hand hesitates mid-air, unsure whether to clean it or accept it.",
    "{subject} standing turned slightly sideways while holding a pan at waist level. The face is calm but resigned — breakfast didn''t survive.",
    "{subject} holding a phone lower than eye level, staring into space after sending a message. One hand lightly touches the lips — realization settling in.",
    "{subject} checking jacket pockets with measured movements, not frantic. The weight shifts from one foot to the other — something is missing.",
    "{subject} putting on a jacket while slightly off balance, already mid-motion toward leaving. The head turns briefly as if double-checking something forgotten.",
    "{subject} adjusting the collar or smoothing the jacket front with steady hands. The posture straightens — not confident, just ready enough."
  ]'::jsonb,
  205, true, 'everyday', 9, 'single', false, 'home'
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
