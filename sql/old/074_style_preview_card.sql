-- ============================================================
-- Style Preview Card: add description_ru to style_presets_v2
-- ============================================================

ALTER TABLE style_presets_v2
  ADD COLUMN IF NOT EXISTS description_ru text;

-- Popular
UPDATE style_presets_v2 SET description_ru = 'Мультяшный стиль как в Telegram стикерах — яркие цвета, чёткие контуры, выразительные эмоции.' WHERE id = 'cartoon_telegram';
UPDATE style_presets_v2 SET description_ru = 'Классический аниме-стиль — большие глаза, тонкие линии, нежные цвета.' WHERE id = 'anime_classic';
UPDATE style_presets_v2 SET description_ru = 'Американский мультяшный стиль — как в Disney или Pixar, объёмный и детализированный.' WHERE id = 'cartoon_american';

-- Anime
UPDATE style_presets_v2 SET description_ru = 'Романтичное аниме — пастельные тона, мечтательные глаза с бликами, нежное выражение.' WHERE id = 'anime_romance';
UPDATE style_presets_v2 SET description_ru = 'Чиби-стиль — огромная голова, крошечное тело, максимум милоты и кавайности.' WHERE id = 'anime_chibi';
UPDATE style_presets_v2 SET description_ru = 'Сёнен-аниме — динамичная поза, яркие цвета, боевой дух и решительный взгляд.' WHERE id = 'anime_shonen';
UPDATE style_presets_v2 SET description_ru = 'Тёмное аниме — драматичные тени, мрачная атмосфера, красно-фиолетовые акценты.' WHERE id = 'anime_dark';

-- Cute
UPDATE style_presets_v2 SET description_ru = 'Японский кавай — пастельные розовые и голубые тона, блёстки, румяные щёчки.' WHERE id = 'cute_kawaii';
UPDATE style_presets_v2 SET description_ru = 'Стиль котика — кошачьи ушки и усики, игривое выражение, пушистая эстетика.' WHERE id = 'cute_cat';
UPDATE style_presets_v2 SET description_ru = 'Милый антропоморфный зверёк — пушистый, с огромными блестящими глазами.' WHERE id = 'cute_animal';
UPDATE style_presets_v2 SET description_ru = 'Плюшевая игрушка — мягкая ткань, пуговичные глазки, хочется обнять.' WHERE id = 'cute_plush';

-- Love
UPDATE style_presets_v2 SET description_ru = 'Мягкая акварель — нежные мазки, тёплые пастельные тона, романтичная воздушность.' WHERE id = 'love_soft';
UPDATE style_presets_v2 SET description_ru = 'Романтичная парочка — тёплые розовые тона, нежные улыбки, любовная атмосфера.' WHERE id = 'love_couple';
UPDATE style_presets_v2 SET description_ru = 'Страсть — глубокие красные и бордовые тона, уверенный взгляд, драматичное освещение.' WHERE id = 'love_passion';
UPDATE style_presets_v2 SET description_ru = 'Романтика с сердечками — розово-красная палитра, милое выражение, сердечки в деталях.' WHERE id = 'love_heart';

-- Manhwa
UPDATE style_presets_v2 SET description_ru = 'Корейская манхва — чёткие черты, детальные глаза, гладкая цифровая раскраска.' WHERE id = 'manhwa_classic';
UPDATE style_presets_v2 SET description_ru = 'Экшн-манхва — динамичные позы, драматичные ракурсы, мощная энергетика.' WHERE id = 'manhwa_action';
UPDATE style_presets_v2 SET description_ru = 'Романс-манхва — красивые персонажи, мягкая раскраска, эмоциональные выражения.' WHERE id = 'manhwa_romance';

-- Russian
UPDATE style_presets_v2 SET description_ru = 'Стиль Love Is — простые милые персонажи, минималистичные линии, романтичное настроение.' WHERE id = 'ru_love_is';
UPDATE style_presets_v2 SET description_ru = 'Стиль «Бригада» — кожаная куртка, серьёзный взгляд, кинематографичное освещение, 90-е.' WHERE id = 'ru_criminal';
UPDATE style_presets_v2 SET description_ru = 'Советский мультик — рисованная анимация, тёплые ностальгические цвета, как Ну Погоди или Чебурашка.' WHERE id = 'ru_soviet_cartoon';
UPDATE style_presets_v2 SET description_ru = 'Советский плакат — конструктивизм, красно-золотые тона, героическая поза, агитпроп.' WHERE id = 'ru_ussr_aesthetic';
UPDATE style_presets_v2 SET description_ru = 'Русский богатырь — славянский фольклор, эпический воин, как из мультфильма Три Богатыря.' WHERE id = 'ru_bogatyr';
UPDATE style_presets_v2 SET description_ru = 'Стиль пацана — поза на кортах, спортивный костюм, славянская мем-культура.' WHERE id = 'ru_gopnik';
UPDATE style_presets_v2 SET description_ru = 'Эстетика русских 90-х — VHS-качество, зернистость, выцветшие цвета, ностальгия.' WHERE id = 'ru_90s';

-- Meme
UPDATE style_presets_v2 SET description_ru = 'Рейдж-комикс — жирные контуры, утрированные эмоции, классика интернет-мемов.' WHERE id = 'meme_classic';
UPDATE style_presets_v2 SET description_ru = 'Стиль Пепе — зелёный лягушонок, простые формы, грустное или довольное выражение.' WHERE id = 'meme_pepe';
UPDATE style_presets_v2 SET description_ru = 'Зумер-мем — ироничная эстетика, хаотичная энергия, TikTok-вайб.' WHERE id = 'meme_modern';
UPDATE style_presets_v2 SET description_ru = 'Мем-реакция — максимально утрированная эмоция, скриншотная эстетика, вирусный мем.' WHERE id = 'meme_reaction';

-- Cartoon
UPDATE style_presets_v2 SET description_ru = 'Ретро-мультик — рисованная анимация, тёплые ностальгические тона, классика.' WHERE id = 'cartoon_retro';
UPDATE style_presets_v2 SET description_ru = '3D-мультфильм — рендер как в Pixar, мягкое освещение, кинематографичный.' WHERE id = 'cartoon_3d';
UPDATE style_presets_v2 SET description_ru = 'Современный вектор — чистые геометрические формы, минимализм, стильный флэт-дизайн.' WHERE id = 'cartoon_modern';

-- Game
UPDATE style_presets_v2 SET description_ru = 'Пиксель-арт — 8-битная ретро-графика, ограниченная палитра, ностальгия по старым играм.' WHERE id = 'game_pixel';
UPDATE style_presets_v2 SET description_ru = 'RPG-герой — эпическая поза, магические эффекты, детальная броня, фэнтези.' WHERE id = 'game_rpg';
UPDATE style_presets_v2 SET description_ru = 'Казуальная игра — яркие цвета, милые пропорции, мобильный стиль.' WHERE id = 'game_mobile';

-- Drawn
UPDATE style_presets_v2 SET description_ru = 'Карандашный скетч — рваные штрихи, графитовый вид, эффект незавершённого рисунка.' WHERE id = 'drawn_sketch';
UPDATE style_presets_v2 SET description_ru = 'Акварель — мягкие края, растёкшиеся цвета, художественные мазки, мечтательность.' WHERE id = 'drawn_watercolor';
UPDATE style_presets_v2 SET description_ru = 'Тушь — смелые чёрные штрихи, высокий контраст, художественная графика, монохром.' WHERE id = 'drawn_ink';

-- TV
UPDATE style_presets_v2 SET description_ru = 'Стиль Симпсонов — жёлтая кожа, жирные контуры, плоские цвета, прикус.' WHERE id = 'tv_american';
UPDATE style_presets_v2 SET description_ru = 'Стиль South Park — грубые простые формы, сатирическая утрированность, плоские цвета.' WHERE id = 'tv_adult';
UPDATE style_presets_v2 SET description_ru = 'Стиль Гравити Фолз — дружелюбные круглые формы, яркие цвета, милые персонажи.' WHERE id = 'tv_kids';
UPDATE style_presets_v2 SET description_ru = 'Стиль Disney/Pixar — 3D-рендер, большие выразительные глаза, мягкое освещение.' WHERE id = 'tv_disney';
UPDATE style_presets_v2 SET description_ru = 'Стиль Hazbin Hotel — демоническая эстетика, острые углы, красно-чёрная палитра, дерзость.' WHERE id = 'tv_hellish';
