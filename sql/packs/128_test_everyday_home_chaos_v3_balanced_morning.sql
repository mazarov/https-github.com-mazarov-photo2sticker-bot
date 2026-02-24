-- 128_test_everyday_home_chaos_v3_balanced_morning.sql (ТЕСТ)
-- Обновление пака everyday_home_chaos_v3: Home Chaos — Balanced Morning. Только pack_content_sets_test. На проде не запускать.

INSERT INTO pack_content_sets_test (
  id, pack_template_id, name_ru, name_en,
  carousel_description_ru, carousel_description_en,
  labels, labels_en, scene_descriptions,
  sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
) VALUES
(
  'everyday_home_chaos_v3',
  'couple_v1',
  'Домашний хаос — Сбалансированное утро',
  'Home chaos — balanced morning',
  'Проспал(а), реальность настигла, кофе пролился, не тот чат. Утро как есть.',
  'Overslept, reality hits, coffee spill, wrong chat. Morning as it is.',
  '["Проспал(а)", "Реальность настигла", "Нет чистой рубашки", "Кофе пролился", "Сковородка горит", "Не тот чат", "Ключи?", "Опаздываю", "Поехали"]'::jsonb,
  '["Overslept", "Reality hits", "No clean shirt", "Coffee spill", "Burning pan", "Wrong chat", "Keys?", "Running late", "Let''s go"]'::jsonb,
  '[
    "{subject} sitting on the edge of the bed, blanket still around the waist, phone lowered in one hand. The body leans slightly forward while the gaze is fixed ahead in quiet realization — already late.",
    "{subject} standing upright with one palm slowly sliding down the face, the other hand resting on the hip. Head slightly tilted sideways, exhaling through the nose — the day has started wrong.",
    "{subject} holding a wrinkled shirt at arm''s length, looking at it from the side rather than down. The torso turned 30 degrees as if deciding whether to risk wearing it anyway.",
    "{subject} holding a mug that is slightly over-tilted, a thin stream of coffee already falling. The body leans forward instinctively while the free hand reaches too late to stop it.",
    "{subject} torso turned sharply to the side, holding a frying pan while leaning slightly away from it. Eyes focused on the pan, lips pressed — something is definitely overcooked.",
    "{subject} frozen mid-step with phone lowered near the chest, staring straight ahead rather than at the screen. One hand slowly moves toward the mouth — message already sent.",
    "{subject} patting one jacket pocket while looking to the side with suspicion. The weight shifts to one leg as the search becomes more urgent.",
    "{subject} slipping one shoe on while slightly off balance, keys finally found and loosely hanging from one hand. The torso already angled forward in motion.",
    "{subject} adjusting the jacket collar with one hand while turning the body slightly toward an imaginary exit. Expression calm but resolved — stepping into the day anyway."
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
