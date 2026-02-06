-- Styles v2: Groups + Substyles (isolated from existing style_presets)

-- 1. Style groups table
CREATE TABLE IF NOT EXISTS style_groups (
  id text PRIMARY KEY,
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS style_groups_active_idx 
ON style_groups (is_active, sort_order);

-- 2. Style presets v2 (separate table, does NOT modify style_presets!)
CREATE TABLE IF NOT EXISTS style_presets_v2 (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES style_groups(id),
  emoji text NOT NULL,
  name_ru text NOT NULL,
  name_en text NOT NULL,
  prompt_hint text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS style_presets_v2_idx 
ON style_presets_v2 (group_id, is_active, sort_order);

-- 3. Insert groups
INSERT INTO style_groups (id, emoji, name_ru, name_en, sort_order) VALUES
  ('anime', '🎌', 'Аниме', 'Anime', 1),
  ('meme', '😂', 'Мемы', 'Memes', 2),
  ('cute', '🥰', 'Милый', 'Cute', 3),
  ('love', '💕', 'Романтика', 'Romance', 4),
  ('cartoon', '🎨', 'Мультфильм', 'Cartoon', 5),
  ('game', '🎮', 'Игровой', 'Gaming', 6),
  ('drawn', '✏️', 'Рисунок', 'Drawn', 7),
  ('manhwa', '📚', 'Манхва', 'Manhwa', 8),
  ('tv', '📺', 'Сериалы', 'TV Series', 9),
  ('russian', '🇷🇺', 'Русский стиль', 'Russian', 10)
ON CONFLICT (id) DO UPDATE SET
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  sort_order = EXCLUDED.sort_order;

-- 4. Insert substyles

-- anime
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('anime_classic', 'anime', '🎯', 'Классический', 'Classic', 'Japanese anime style, clean precise linework, cel-shading, large expressive eyes with detailed reflections, stylized flowing hair', 1),
  ('anime_dark', 'anime', '🌑', 'Тёмный', 'Dark', 'Dark anime aesthetic, dramatic shadows, intense brooding eyes, muted colors with red/purple accents, seinen manga style', 2),
  ('anime_shonen', 'anime', '⚔️', 'Сёнен', 'Shonen', 'Shonen anime style, dynamic action pose, spiky hair, determined fierce expression, vibrant saturated colors', 3),
  ('anime_romance', 'anime', '💗', 'Романтик', 'Romance', 'Shoujo anime style, soft pastel colors, sparkles and bubbles, dreamy starry eyes, delicate features, bishoujo aesthetic', 4),
  ('anime_chibi', 'anime', '🍡', 'Чиби', 'Chibi', 'Super-deformed chibi anime, oversized head 3x body, tiny limbs, kawaii expression, simplified features', 5)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- meme
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('meme_classic', 'meme', '😤', 'Классика', 'Classic', 'Internet meme style, rage comic aesthetic, bold black outlines, extremely exaggerated facial expression, simple shapes', 1),
  ('meme_pepe', 'meme', '🐸', 'Пепе', 'Pepe', 'Pepe the frog meme style, green character, simple round shapes, expressive sad or smug face, iconic meme aesthetic', 2),
  ('meme_modern', 'meme', '🔥', 'Современный', 'Modern', 'Modern zoomer meme style, ironic aesthetic, chaotic energy, distorted proportions, TikTok meme vibe', 3),
  ('meme_reaction', 'meme', '😱', 'Реакция', 'Reaction', 'Reaction meme face, extremely over-the-top expression, screenshot aesthetic, viral meme energy', 4)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- cute
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('cute_kawaii', 'cute', '✨', 'Каваий', 'Kawaii', 'Japanese kawaii style, pastel pink and blue colors, round soft shapes, sparkles, blush cheeks, heart eyes', 1),
  ('cute_cat', 'cute', '🐱', 'Котик', 'Cat', 'Cute cat character style, cat ears added, whiskers, playful feline expression, fluffy and adorable', 2),
  ('cute_animal', 'cute', '🐾', 'Зверушка', 'Animal', 'Cute anthropomorphic animal, round fluffy body, oversized sparkly eyes, soft fur texture, adorable pose', 3),
  ('cute_plush', 'cute', '🧸', 'Плюшевый', 'Plush', 'Plush toy aesthetic, soft fabric texture, stitched details, huggable round shape, button eyes', 4)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- love
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('love_soft', 'love', '🌸', 'Нежный', 'Soft', 'Soft romantic style, watercolor effect, floating hearts, warm pink tones, dreamy gentle expression', 1),
  ('love_couple', 'love', '👫', 'Парочки', 'Couple', 'Romantic couple style, two characters close together, loving gaze, holding hands or hugging pose', 2),
  ('love_heart', 'love', '💖', 'С сердечками', 'Hearts', 'Romantic style with heart decorations, heart-shaped elements, love symbols, pink and red palette', 3),
  ('love_passion', 'love', '🔥', 'Страстный', 'Passionate', 'Passionate romantic style, intense loving gaze, dramatic lighting, deep red and warm tones', 4)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- cartoon
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('cartoon_american', 'cartoon', '🇺🇸', 'Американский', 'American', 'American cartoon style, bold black outlines, flat bright colors, exaggerated proportions, expressive', 1),
  ('cartoon_retro', 'cartoon', '📺', 'Ретро', 'Retro', 'Retro Soviet cartoon style, warm nostalgic colors, hand-painted aesthetic, classic animation look', 2),
  ('cartoon_modern', 'cartoon', '💎', 'Современный', 'Modern', 'Modern vector cartoon, clean geometric shapes, trendy flat design, minimalist features, stylish', 3),
  ('cartoon_3d', 'cartoon', '🎬', '3D стиль', '3D Style', '3D animated movie style, soft subsurface lighting, Pixar-like render, smooth surfaces, cinematic', 4)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- game
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('game_pixel', 'game', '👾', 'Пиксель', 'Pixel', '8-bit pixel art style, retro game aesthetic, limited color palette, blocky pixelated look, nostalgic', 1),
  ('game_rpg', 'game', '⚔️', 'RPG', 'RPG', 'Fantasy RPG character style, epic hero pose, magical effects, detailed armor or costume, game art', 2),
  ('game_mobile', 'game', '📱', 'Мобильный', 'Mobile', 'Mobile game art style, bright saturated colors, cute proportions, casual game aesthetic', 3)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- drawn
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('drawn_sketch', 'drawn', '✏️', 'Скетч', 'Sketch', 'Pencil sketch style, hand-drawn rough lines, artistic strokes, unfinished aesthetic, graphite look', 1),
  ('drawn_watercolor', 'drawn', '💧', 'Акварель', 'Watercolor', 'Watercolor painting style, soft wet edges, color bleeding, artistic brush strokes, dreamy', 2),
  ('drawn_ink', 'drawn', '🖤', 'Тушь', 'Ink', 'Black ink drawing style, bold confident strokes, high contrast, artistic linework, monochrome', 3)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- manhwa
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('manhwa_classic', 'manhwa', '📖', 'Классика', 'Classic', 'Korean manhwa webtoon style, sharp defined features, detailed eyes, clean digital art, vertical scroll aesthetic', 1),
  ('manhwa_romance', 'manhwa', '💕', 'Романтик', 'Romance', 'Romance manhwa style, beautiful detailed characters, soft coloring, emotional expression, webtoon romance', 2),
  ('manhwa_action', 'manhwa', '💥', 'Экшн', 'Action', 'Action manhwa style, dynamic poses, intense expression, dramatic angles, powerful energy effects', 3)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- tv
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('tv_american', 'tv', '🇺🇸', 'Американский мультсериал', 'American Cartoon', 'American TV cartoon style like Simpsons or Family Guy, yellow skin tone optional, bold outlines, flat colors, overbite, simplified features', 1),
  ('tv_adult', 'tv', '🔞', 'Взрослая анимация', 'Adult Animation', 'Adult animated series style like South Park or Rick and Morty, crude simple shapes, satirical exaggerated features, bold flat colors', 2),
  ('tv_kids', 'tv', '👶', 'Детский мультик', 'Kids Cartoon', 'Childrens cartoon style like Gravity Falls or Adventure Time, round friendly shapes, bright colors, cute expressive characters', 3),
  ('tv_disney', 'tv', '🏰', 'Дисней/Пиксар', 'Disney/Pixar', 'Disney or Pixar animation style, 3D rendered look, expressive big eyes, soft lighting, polished animated movie aesthetic', 4),
  ('tv_hellish', 'tv', '😈', 'Адская тема', 'Hellish Theme', 'Hazbin Hotel or Helluva Boss style, demon aesthetic, sharp angles, red and black palette, edgy cartoon look', 5)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- russian
INSERT INTO style_presets_v2 (id, group_id, emoji, name_ru, name_en, prompt_hint, sort_order) VALUES
  ('ru_90s', 'russian', '📼', '90-е', '90s Style', 'Russian 90s aesthetic, VHS quality, grainy texture, post-Soviet style, tracksuit gopnik vibe, nostalgic faded colors', 1),
  ('ru_love_is', 'russian', '💑', 'Любовь это...', 'Love Is...', 'Love Is comic strip style, simple cute couple, minimal lines, sweet romantic, Kim Casali inspired, heart-shaped elements', 2),
  ('ru_soviet_cartoon', 'russian', '🎬', 'Советский мультик', 'Soviet Cartoon', 'Soviet animation style like Nu Pogodi or Cheburashka, hand-painted aesthetic, warm nostalgic colors, classic USSR cartoon', 3),
  ('ru_ussr_aesthetic', 'russian', '☭', 'Эстетика СССР', 'USSR Aesthetic', 'Soviet propaganda poster style, constructivist aesthetic, bold red and gold colors, heroic worker pose, socialist realism, vintage USSR design', 4),
  ('ru_bogatyr', 'russian', '⚔️', 'Богатырь', 'Russian Hero', 'Russian bogatyr hero style, Tri Bogatyrya animation aesthetic, Slavic folklore, epic warrior, traditional Russian elements', 5),
  ('ru_gopnik', 'russian', '🧢', 'Пацан', 'Gopnik', 'Gopnik style, squatting pose, tracksuit Adidas aesthetic, Slavic meme culture, cigarette and semechki optional', 6),
  ('ru_criminal', 'russian', '🎰', 'Бригада/90е кино', '90s Crime', 'Russian 90s crime movie aesthetic, Brigada or Brat style, dark gritty, leather jacket, serious intense expression', 7)
ON CONFLICT (id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  emoji = EXCLUDED.emoji,
  name_ru = EXCLUDED.name_ru,
  name_en = EXCLUDED.name_en,
  prompt_hint = EXCLUDED.prompt_hint,
  sort_order = EXCLUDED.sort_order;

-- 5. Add selected_style_group to sessions for analytics
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS selected_style_group text;
