-- 139_test_man_said_he_would_v1.sql (ТЕСТ)
-- Пак «Он сказал, что сделает» — мужские обещания и отмазки. Исправлены сцена 7 и подписи.
-- Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES (
  'pack.man.said.he.would.home.weekend.v1',
  'couple_v1',
  'Он сказал, что сделает',
  'He Said He Would',
  'День обещаний: уверенный мужчина откладывает починку, оставаясь в достоинстве.',
  'A day of promises: a confident man postpones fixes, with dignity.',
  '["сначала кофе", "часа на два", "смотрю", "принесу", "на неделе", "руками", "не буду", "меряю", "с болтом", "план в голове", "всё в голове", "напомнил", "заметки", "всё отметил", "завтра точно", "так и задумано"]'::jsonb,
  '["coffee first", "give me two hours", "looking closely", "getting tools", "this week", "hands-on", "not doing", "measuring", "with the bolt", "plan in head", "all in my head", "reminded", "made notes", "all checked", "tomorrow for sure", "just as planned"]'::jsonb,
  '[
    "{subject} half-body shrugging out of a blazer, determined brow, holding empty coffee cup absent-mindedly.",
    "{subject} chest-up, leaning forward confidently, brand-new neon stopwatch held like battle flag, smirk.",
    "{subject} chest-up, side-glancing through a vintage magnifying glass, puzzled furrowed brow, lips pressed.",
    "{subject} half-body, briskly fastening a rugged utility vest, jaw set, eyes narrowing toward invisible task.",
    "{subject} chest-up, amused smirk, holding a foldable brass ruler like an impromptu surveyor baton.",
    "{subject} chest-up, concentrated half-smile, neon measuring tape stretched across chest, eyebrow raised in amusement.",
    "{subject} half-body, hands raised to sides of head, cardigan half-draped, mouth open in frustrated sigh — overwhelmed by scope.",
    "{subject} chest-up, leaning back deliberately, eyes narrowed into careful observation, jaw relaxed but intent.",
    "{subject} chest-up, holding an oversized chrome screw between fingers, contemplative squint, lips pursed.",
    "{subject} chest-up side-profile, pen tapping temple, skeptical squint, mapping invisible plans with practiced patience.",
    "{subject} half-body, slowly buttoning a crisp shirt, awkwardly frozen smile, eyes darting to imaginary calendar.",
    "{subject} chest-up, palms pressed briefly to chest, weary grin, eyes sliding toward an invisible schedule.",
    "{subject} chest-up, thumb swiping decisively on a gleaming phone, satisfied crooked smile, priorities shuffled.",
    "{subject} half-body, calmly shrugging the cardigan off, serene closed-eye smile, hands folded near torso.",
    "{subject} chest-up, leaning back triumphantly, arms behind head, chest proud, victorious lazy grin.",
    "{subject} chest-up, smugly relaxed, one shoulder slightly raised, gaze drifting, pretend-work accomplished without evidence."
  ]'::jsonb,
  10, true, 'wry', 16, 'single', false, 'home'
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
