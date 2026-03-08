-- Style presets for inline buttons
create table if not exists style_presets (
  id text primary key,
  name_ru text not null,
  name_en text not null,
  prompt_hint text not null,
  emoji text not null,
  sort_order int default 0,
  is_active boolean default true,
  created_at timestamptz default now()
);

create index if not exists style_presets_active_idx on style_presets (is_active, sort_order);

INSERT INTO style_presets (id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('anime', '🎌', 'Аниме', 'Anime', 'anime style, clean lines, expressive eyes, detailed hair', 1),
  ('cartoon', '🎨', 'Мультфильм', 'Cartoon', 'cartoon style, bold outlines, vibrant colors, exaggerated features', 2),
  ('3d', '🧊', '3D', '3D', '3D rendered style, volumetric lighting, smooth surfaces', 3),
  ('pixel', '👾', 'Пиксель арт', 'Pixel Art', 'pixel art style, retro game aesthetic, 8-bit', 4),
  ('simpsons', '📺', 'Симпсоны', 'Simpsons', 'The Simpsons cartoon style, yellow skin, flat 2D, overbite', 5),
  ('chibi', '🍡', 'Чиби', 'Chibi', 'chibi style, big head, small body, cute, kawaii', 6),
  ('watercolor', '💧', 'Акварель', 'Watercolor', 'watercolor painting style, soft edges, artistic', 7),
  ('comic', '💥', 'Комикс', 'Comic', 'comic book style, halftone dots, dynamic poses, speech bubbles', 8)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  emoji = EXCLUDED.emoji,
  sort_order = EXCLUDED.sort_order;

-- Update bot_texts_new for new message
UPDATE bot_texts_new 
SET text = 'Отлично! Теперь выбери стиль стикера из вариантов ниже или напиши свой текстом.',
    updated_at = now()
WHERE lang = 'ru' AND key = 'photo.ask_style';

UPDATE bot_texts_new 
SET text = 'Great! Now choose a sticker style from the options below or describe your own.',
    updated_at = now()
WHERE lang = 'en' AND key = 'photo.ask_style';
