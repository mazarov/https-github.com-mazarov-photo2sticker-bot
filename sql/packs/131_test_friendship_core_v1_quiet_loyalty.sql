  -- 131_test_friendship_core_v1_quiet_loyalty.sql (ТЕСТ)
  -- Обновление пака friendship_core_v1: Quiet Loyalty — Adult Friendship. Только pack_content_sets_test. На проде не запускать.
  -- pack_template_id = friendship_v1 (если в БД нет шаблона friendship_v1, заменить на couple_v1).

  INSERT INTO pack_content_sets_test (
    id, pack_template_id, name_ru, name_en,
    carousel_description_ru, carousel_description_en,
    labels, labels_en, scene_descriptions,
    sort_order, is_active, mood, sticker_count, subject_mode, cluster, segment_id
  ) VALUES
  (
    'friendship_core_v1',
    'friendship_v1',
    'Тихая лояльность',
    'Quiet loyalty',
    'Сомневались. Рисковали. Сделали. Теперь просто стоим рядом — спокойно.',
    'We doubted. Took the risk. It worked. Now we just stand there — calm.',
    '["Я же говорил(а).", "Мы справились.", "Вот это ход.", "Легендарно.", "Наш уровень.", "Только мы поймём.", "С тебя кофе.", "Как всегда.", "Серьёзно."]'::jsonb,
    '["I told you.", "We handled it.", "That''s a move.", "Legendary.", "Our level.", "Only we get it.", "Your turn for coffee.", "As always.", "For real."]'::jsonb,
    '[
      "{subject} standing at a slight 30-degree angle, weight shifted to one leg. One hand in pocket, the other making a small understated nod gesture. Expression soft but confident — the moment right after the friend finally decided to do it.",
      "{subject} torso turned sideways, shoulders lowered after tension passed. Arms loosely crossed without defensiveness. A subtle exhale visible in posture — the difficult conversation has just ended.",
      "{subject} taking a small half-step back, one palm slightly open at waist level as if acknowledging a bold move just made. A restrained smirk forms — approval without exaggeration.",
      "{subject} standing with torso rotated, arms calmly crossed. Chin slightly lifted with a slight head tilt. The risky plan has worked; composure matters more than celebration.",
      "{subject} holding a phone low near the hip, shoulders relaxed. Gaze directed downward at the screen with a faint half-smile — the task is closed, quietly won.",
      "{subject} leaning slightly forward, one palm lightly covering the mouth as if holding back a laugh. Body angled sideways — something absurd just happened and only they understand it.",
      "{subject} extending a phone forward as if showing a payment confirmation screen. Body mid-step and slightly in motion. Calm eye contact — the bill has already been paid.",
      "{subject} torso rotated with hands slightly apart at waist level. Head gently tilted downward with a soft knowing smile — the familiar mistake just happened again.",
      "{subject} sitting sideways with one leg slightly tucked in. Shoulders relaxed, body subtly leaning. A quiet side gaze and neutral breathing — nothing is happening, and that''s exactly the point."
    ]'::jsonb,
    220, true, 'calm_supportive_friendship', 9, 'single', false, 'affection_support'
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
