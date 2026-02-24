-- 125_test_everyday_home_chaos_sitcom30_v2.sql (ТЕСТ)
-- Один пак: Домашний хаос — Sitcom 30+ 2.0. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_chaos_sitcom30_v2',
  'couple_v1',
  'Домашний хаос — 30+',
  'Home chaos — 30+ sitcom',
  'Кофе, работа, неловкость, маленькие победы и ирония. Один обычный взрослый день.',
  'Coffee, work, awkward moments, small wins and irony. Just an adult day.',
  '["Доброе утро", "Сейчас…", "Серьёзно?", "Работаю", "Ну вот", "Есть", "Перерыв", "Я всё вижу", "Поехали"]'::jsonb,
  '["Morning", "Hold on", "Seriously?", "Working", "Here we go", "Got it", "Break", "I see you", "Let''s go"]'::jsonb,
  '[
    "{subject} standing slightly angled, one arm raised behind the head while the other hand loosely holds the hem of a soft T-shirt. The stretch looks real and slightly uneven, like the body is waking up slower than the brain. Eyes half-closed, shoulders exhaling gently.",
    "{subject} holding a ceramic mug with both hands close to the face, taking a cautious sip. The mug stays near the lips for a second longer as if evaluating both the temperature and the mood of the morning. The gaze is calm and steady, quietly assessing the day.",
    "{subject} slowly lowering the mug while glancing down at the shirt, noticing a small imaginary stain. One hand still holds the cup; the other lightly touches the fabric as if checking the damage. Lips press together briefly in a restrained ''seriously?'' reaction.",
    "{subject} leaning slightly forward with one hand actively typing on a laptop just out of frame while the other rests near the keyboard. Shoulders engaged, posture subtly tense in concentration. Face neutral and focused — actually working, not posing.",
    "{subject} holding a smartphone between shoulder and ear while adjusting a sleeve or pushing hair back with one hand. The body is slightly twisted from multitasking. A quiet exhale through the nose shows contained overload rather than panic.",
    "{subject} standing still with both hands resting lightly on the hips or at the sides, eyes closed for a brief second. The shoulders drop slightly during a slow inhale. A visible micro-reset before continuing.",
    "{subject} gathering hair into a bun with both hands lifted, elbows slightly out to the sides. The movement is practical and decisive, posture straightening as the hair tightens into place. Expression calm — control restored.",
    "{subject} holding a phone loosely at chest level in one hand while the other arm crosses lightly over the body. Head tilts slightly, one eyebrow reacting with amused disbelief. The expression reads ironic, not dramatic.",
    "{subject} slipping one arm into a jacket while the other hand holds a small set of keys. The body is already turning slightly sideways as if mid-step toward the door. A subtle knowing half-smile suggests acceptance of whatever the day brings."
  ]'::jsonb,
  195, true, 'everyday', 9, 'single', false, 'home'
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
