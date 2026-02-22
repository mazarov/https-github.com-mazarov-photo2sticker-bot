-- 104_test_after_dark_danger_close_night_v1.sql (ТЕСТ)
-- Один пак: Опасно близко — Nightwear edition. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'after_dark_danger_close_night_v1',
  'couple_v1',
  'Опасно близко — Ночная версия',
  'Dangerously close — Nightwear',
  'Вечером, когда снимаешь дневную роль. Мягко, близко, без спешки.',
  'Late night, when the day persona fades. Soft, close, unhurried.',
  '["Подойди", "Ближе", "Сними это", "Не спеши", "Ты чувствуешь?", "Тише", "Останься", "Почти", "Ночь"]'::jsonb,
  '["Come closer", "Closer", "Take it off", "Slow down", "Feel it?", "Quiet", "Stay", "Almost", "Night"]'::jsonb,
  '[
    "{subject} wearing a soft thin night top or loose partner-style shirt, framed chest-up, relaxed shoulders, calm attentive eye contact",
    "{subject} framed chest-up, slowly adjusting the neckline of a soft fabric top, fingers lingering briefly, gaze steady",
    "{subject} in loose home shirt or thin knit, gently sliding fabric off one shoulder to reveal collarbone, eyes lowering for a moment",
    "{subject} waist-up framing, lightly touching the opposite shoulder through soft fabric, head tilted slightly, restrained smile",
    "{subject} framed chest-up, slowly pulling one sleeve or strap down the arm, exposing more skin line, breathing visible",
    "{subject} closer framing, soft nightwear visible, chin slightly lowered while eyes look up, quiet intimate focus",
    "{subject} chest-up framing, lightly holding fabric at the waist or side as if deciding whether to remove it, subtle tension",
    "{subject} framed chest-up, nightwear or open shirt falling more loosely, shoulder line clearly visible, eyes half-lidded",
    "{subject} chest-up framing, wrapped only in very soft night fabric or loose shirt, shoulders bare or nearly bare, head turned slightly away with a slow knowing smile"
  ]'::jsonb,
  50, true, 'romantic', 9, 'single', false, 'after_dark'
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
