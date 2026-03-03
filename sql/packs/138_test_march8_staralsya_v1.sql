-- 138_test_march8_staralsya_v1.sql
-- Пак «Старался.» — мужчина поздравляет женщину с 8 марта. Короткие мужские подписи, без смены одежды.
-- Замена: если pack_staralsya_001 уже есть — удаляем и вставляем заново.

DELETE FROM pack_content_sets_test WHERE id = 'pack_staralsya_001';

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES (
  'pack_staralsya_001',
  'march_8',
  'Старался.',
  'I tried.',
  'Он старался — готовил, покупал, дарил. Неловко, но от души.',
  'He tried — cooked, shopped, gifted. Awkward, but from the heart.',
  '["старался.", "это тебе.", "сам.", "ну как?", "не смейся.", "сюрприз.", "серьёзно.", "для тебя.", "с 8 марта.", "готовил сам.", "ну вот.", "да, я.", "оценишь?", "справился.", "немного.", "от души."]'::jsonb,
  '["i tried.", "this is for you.", "by myself.", "well?", "don''t laugh.", "surprise.", "i''m serious.", "for you.", "happy march 8.", "cooked it myself.", "so... here.", "yes, me.", "like it?", "nailed it.", "just a bit.", "from the heart."]'::jsonb,
  '[
    "{subject} chest-up, stirring a large pot with a wooden spoon, flour smudge on cheek, focused frown.",
    "{subject} waist-up, holding a slightly crushed bouquet in both hands, lips pressed tight in concentration.",
    "{subject} chest-up, pointing at himself with both thumbs, wide proud grin, chest slightly puffed.",
    "{subject} waist-up, peeking from behind an enormous teddy bear, only eyes and forehead visible, hopeful.",
    "{subject} chest-up, one hand behind back hiding something, other hand waving casually at camera, embarrassed smile.",
    "{subject} waist-up, proudly presenting a lopsided breakfast tray with both hands, chin lifted high.",
    "{subject} waist-up, down on one knee, holding a tiny gift box forward with both hands, face stone-serious.",
    "{subject} chest-up, extending a single red rose toward camera, slight head tilt, earnest gaze.",
    "{subject} chest-up, blowing a kiss toward camera, eyes slightly squinted, hint of embarrassment.",
    "{subject} waist-up, carrying five shopping bags in both arms, determined forward stride, jaw set.",
    "{subject} chest-up, palm extended showing something small and imperfect, sheepish apologetic half-smile.",
    "{subject} chest-up, arms crossed over chest, satisfied slow nod, one eyebrow raised in quiet self-congratulation.",
    "{subject} waist-up, balancing a cake on one palm like a waiter, other hand steadying it, nervous concentration.",
    "{subject} chest-up, holding a handwritten card close to camera, proud squint, tight-lipped grin.",
    "{subject} chest-up, rubbing back of neck with one hand, looking sideways at camera, bashful grin.",
    "{subject} waist-up, offering a badly wrapped gift with both hands, trembling fingers, hopeful wide eyes."
  ]'::jsonb,
  10, true, 'earnest effort', 16, 'single', false, 'events'
);
