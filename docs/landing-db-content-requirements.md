# Требования: контент Hero и галереи стилей из БД

**Дата:** 2026-02  
**Контекст:** Блоки на главной (Hero — карусель «фото → стикер», блок «Выбери свой стиль») должны тянуть контент напрямую из базы. Изначально в ТЗ SEO-лендинга этого не было; документ фиксирует требования и детальный план реализации.

---

## 1. Текущее состояние

### Hero (карусель паков эмоций)

- **Компоненты:** `Hero.tsx` → `EmotionPackCarousel.tsx`; данные из `lib/emotion-packs.ts`.
- **Содержимое:** пилюли (С юмором, Быт и уют, На каждый день, Поддержка, Праздник, Сарказм, Ласка и комплименты, Романтика), слева — статичное фото `/images/examples/photo-1.webp`, справа — карусель из 9 картинок по выбранному паку.
- **Источник картинок карусели:** `getCarouselImagesForPack(sort_order)` → `/images/carousel/{sort_order}/1.png` … `9.png` (статичные файлы в `public/`). В БД URL картинок паков нет.

### Блок «Выбери свой стиль» (StyleGallery)

- **Расположение:** `main > section.py-8` (max-w-4xl), заголовок «Выбери свой стиль», подзаголовок, сетка карточек стилей.
- **Источник данных:** `app/page.tsx` формирует `mainStyleGalleryItems` из `lib/seo/style-groups.ts` — для каждой группы берётся первый подстиль (emoji, image), `image` — статичный путь или fallback `/images/examples/sticker-klassicheskiy.webp`. Ссылки — `/style/{slug}`.

---

## 2. Релевантные таблицы БД

| Таблица | Назначение |
|--------|------------|
| `pack_content_sets` | Паки для карусели Hero: id, pack_template_id, name_ru, labels (jsonb), sort_order, is_active. URL картинок в БД нет. |
| `style_groups` | Группы стилей: id (anime, meme, cute, love, …), name_ru, emoji, sort_order, is_active. |
| `style_presets_v2` | Пресеты: id, group_id, name_ru, emoji, sort_order, is_active. |
| `stickers` | Стикеры: style_preset_id, is_example, result_storage_path, telegram_file_id. Колонки `public_url` пока нет — вводится миграцией. |

**Маппинг group_id (БД) → slug (URL лендинга):** anime→anime, meme→memy, cute→milye (и отдельная страница kotiki из той же группы), love→lyubov, cartoon→multfilm / 3d, game→igry, drawn→risunok, tv→serialy, ru→russkiy и т.д. Лендинг хранит маппинг в конфиге или в ответе API (поле `slug`).

---

## 3. Изменения в БД (миграции)

### 3.1. Публичный URL примеров стикеров (обязательно для картинок галереи из БД)

**Файл:** `sql/090_stickers_public_url.sql` (новый; следующий номер после 089).

- Добавить в таблицу `stickers` колонку `public_url text`.
- Назначение: после загрузки стикера с `is_example = true` в Supabase Storage воркер записывает сюда публичный HTTP-URL картинки; лендинг по нему отдаёт примеры в блоке «Выбери свой стиль» и на страницах `/style/[group]` / `/style/[group]/[substyle]`.
- Заполнение: при нажатии админом «Сделать примером» (callback `make_example` в боте): скачивание файла из bucket `stickers` по `result_storage_path`, загрузка в bucket `stickers-examples`, запись `getPublicUrl()` в `stickers.public_url`. Bucket `stickers-examples` должен быть создан в Supabase Storage и сделан публичным (Public).

### 3.2. Картинки карусели Hero из БД (опционально, позже)

Сейчас карусель использует статичные пути `/images/carousel/{sort_order}/{1..9}.png`. Чтобы тянуть картинки из БД, можно ввести:

- **Вариант A:** таблица `pack_carousel_images` (content_set_id, position 1..9, url text). API паков отдаёт для каждого пака массив URL; при отсутствии — fallback на статику по sort_order.
- **Вариант B:** не менять БД, оставить статику; только метаданные паков (названия, labels) из `pack_content_sets`.

**Рекомендация на первый этап:** Вариант B — Hero тянет из БД только список паков и labels; картинки карусели остаются статичными. Вариант A — отдельная задача после запуска контента из БД.

---

## 4. API лендинга (Next.js)

Лендинг подключается к Supabase: env в `landing/`: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (или серверный API основного бота, если данные отдаются через него).

### 4.1. GET /api/packs/content-sets

- **Назначение:** данные для Hero — пилюли и подписи слайдов карусели.
- **Источник:** Supabase, таблица `pack_content_sets`, фильтр `is_active = true`, сортировка `sort_order ASC`.
- **Поля ответа:** `{ id, name_ru, labels, sort_order }[]`. `labels` — массив строк (jsonb в БД).
- **Картинки карусели:** не отдаются; клиент строит пути сам: `/images/carousel/{sort_order}/1.png` … `9.png`. Если у пака в БД нет соответствующего sort_order (например дубли), fallback — использовать первый доступный preset (например 1).
- **Маппинг id:** в БД уже есть id humor, everyday, reactions, support, holiday, sass, sweet, romance — совпадают с текущим `lib/emotion-packs.ts`. DEFAULT_EMOTION_PACK_ID = "humor".

### 4.2. GET /api/styles/groups

- **Назначение:** список групп для блока «Выбери свой стиль» (главная) — название, эмодзи, slug для ссылки, картинка (превью группы).
- **Источник:** `style_groups` + первый пресет по группе из `style_presets_v2` (min sort_order); при наличии примеров — один пример из `stickers` по этому пресету (is_example = true, public_url не null), иначе — fallback.
- **Поля ответа:** `{ id, name_ru, emoji, sort_order, slug, preview_image? }[]`. `slug` — для URL (маппинг group_id → slug в API или в конфиге лендинга). `preview_image` — URL строкой или null; если null — лендинг подставляет fallback из конфига (первый подстиль группы, поле image из style-groups.ts).
- **Порядок:** по sort_order группы. Лендинг отображает карточки с ссылкой `/style/{slug}`.

### 4.3. GET /api/styles/[groupId]/examples (существующий по плану этапа 3)

- **Назначение:** примеры стикеров по группе (для галереи на странице группы и для подстановки в превью на главной).
- **Параметры:** groupId — id группы (anime, meme, …); query `limit` (по умолчанию 16).
- **Источник:** `stickers` где is_example = true и style_preset_id входит в пресеты данной группы; при наличии — public_url. Сортировка по created_at DESC.
- **Поля ответа:** `{ id, public_url, style_preset_id }[]`. Если public_url нет в БД — возвращать пустой массив или не включать такие записи; лендинг использует статичный fallback.

---

## 5. Поведение блоков на главной

### 5.1. Hero

1. При монтировании (или при загрузке страницы) запрос `GET /api/packs/content-sets`.
2. **Успех:** рендер пилюль и карусели по ответу: названия паков из `name_ru`, подписи слайдов из `labels`, картинки карусели — `/images/carousel/{sort_order}/{1..9}.png`. Сохранить текущую логику переключения пака и автопрокрутки.
3. **Ошибка / таймаут:** использовать захардкоженные данные из `lib/emotion-packs.ts` и те же статичные пути. Страница не ломается, контент остаётся видимым.

### 5.2. Блок «Выбери свой стиль» (StyleGallery)

1. При загрузке главной запрос `GET /api/styles/groups` (и при необходимости для превью — запросы к `/api/styles/[groupId]/examples` с limit=1 по группам, или один объединённый endpoint с превью в ответе групп).
2. **Успех:** построить массив карточек: name из name_ru (на главной можно обрезать « из фото» по текущей логике stripIzFoto), emoji, href=`/style/${slug}`, image = preview_image ?? fallback из конфига (первый подстиль группы).
3. **Ошибка:** использовать текущий `mainStyleGalleryItems` из `getAllStyleGroupSlugs()` + `getStyleGroupBySlug()` и статичные image из конфига.

---

## 6. Детальный порядок реализации

### Фаза 1: API и контент без картинок из БД

1. **Миграция 090:** добавить `stickers.public_url` (без обязательного заполнения).
2. **Landing API:** реализовать `GET /api/packs/content-sets` (Supabase → pack_content_sets). При ошибке/отсутствии env возвращать 200 с пустым массивом или 503; клиент — fallback на emotion-packs.
3. **Landing API:** реализовать `GET /api/styles/groups`: выборка из style_groups + первый пресет по группе; поле `slug` — маппинг group_id → slug (жёстко в коде API или в конфиге). Поле `preview_image` пока null; позже подставить из examples.
4. **Hero:** при загрузке вызывать `/api/packs/content-sets`; при успехе подменять EMOTION_PACKS на ответ; labels и sort_order для путей карусели оставить как сейчас.
5. **StyleGallery на главной:** при загрузке вызывать `/api/styles/groups`; при успехе строить items из ответа, image = preview_image ?? fallback из конфига (getStyleGroupBySlug(slug).substyles[0].image или общий fallback).

### Фаза 2: Картинки галереи из БД

6. **Воркер (основной репо):** при сохранении стикера с is_example = true загружать файл в Supabase Storage (bucket sticker-examples), записывать public_url в stickers.
7. **Landing API:** в `GET /api/styles/[groupId]/examples` читать из stickers (is_example, style_preset_id в группе, public_url not null), отдавать массив { id, public_url, style_preset_id }.
8. **Landing API:** в `GET /api/styles/groups` для каждой группы опционально подставлять preview_image: один пример из examples по группе (limit 1); при отсутствии — null (клиент использует fallback).
9. **Страницы /style/[group]** и **главная StyleGallery:** при наличии данных из examples подставлять их в галерею; при отсутствии — статичный fallback из конфига.

### Фаза 3 (опционально): Картинки карусели Hero из БД

10. Миграция: таблица pack_carousel_images(content_set_id, position, url) + заполнение или загрузка в Storage.
11. API паков расширить полем carousel_urls: string[] (9 URL по позициям 1..9).
12. Hero: при наличии carousel_urls использовать их вместо `/images/carousel/{sort_order}/{i}.png`.

---

## 7. Критерии приёмки

- [ ] Миграция 090: в таблице `stickers` есть колонка `public_url`.
- [ ] В landing есть `GET /api/packs/content-sets` и `GET /api/styles/groups`, при наличии Supabase читают из БД; при ошибке/нет env — корректный fallback (пустой массив или 503).
- [ ] Hero на главной при успешном ответе API отображает паки из БД (названия, переключатель, labels); картинки карусели — статика по sort_order.
- [ ] StyleGallery на главной при успешном ответе API отображает группы из БД (названия, ссылки, порядок); картинки — preview_image из API или fallback из конфига.
- [ ] При недоступности API оба блока используют текущий статичный/конфиговый fallback без поломки страницы.
- [ ] (Фаза 2) Воркер при is_example записывает public_url; GET /api/styles/[groupId]/examples возвращает примеры с public_url; галереи на главной и на /style/[group] при наличии данных показывают картинки из БД.

---

## 8. Связанные документы

- [seo-landing-pages-spec.md](./seo-landing-pages-spec.md) — §6.4 (public_url, API примеров), §6.5 (галерея из API).
- [seo-landing-implementation-plan.md](./seo-landing-implementation-plan.md) — этап 3 и этап 3а (контент Hero и галереи из БД).
- [architecture/04-database.md](./architecture/04-database.md) — схема БД.
