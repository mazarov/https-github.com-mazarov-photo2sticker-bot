# План реализации SEO-посадочных (лендинг)

**Дата:** 2026-02-20  
**Основа:** [seo-landing-pages-spec.md](./seo-landing-pages-spec.md)  
**Где:** сабмодуль `landing/` (вся реализация в нём).  
**Тестирование:** только локально (`npm run build`, `npm run start` в landing), без релизов и деплоя.

---

## Принципы

1. **Один этап — один проверяемый результат.** После каждого этапа — локальная проверка (чеклист).
2. **Не ломать текущую главную.** До конца этапа 0 главная должна оставаться рабочей (после миграции — как `app/page.tsx`).
3. **Сохранить логику лендинга:** CTA с `buildTelegramStartLink(pageSlug?)`, UTM + yclid, Яндекс.Метрика 106534984 ([п. 6.1.1 спеки](./seo-landing-pages-spec.md#611-перенос-с-текущего-лендинга-обязательно-сохранить)).
4. **Контент по спеке:** контент-план и матрица блоков — в [seo-landing-pages-spec.md](./seo-landing-pages-spec.md) (§4, §5, §7.4).

---

## Этап 0. Миграция на Next.js и базовая инфраструктура

**Цель:** Лендинг на Next.js App Router, главная отдаёт полный HTML с мета, одна кнопка CTA с поддержкой page_slug и UTM/yclid, Метрика, sitemap/robots. Всё тестируется локально.

### 0.1. Инициализация Next.js в landing

- [ ] В `landing/` создать Next.js проект (App Router): можно `npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir=false` в пустой подпапке или перенести текущий код в структуру `app/`, `public/`, `next.config.*`, `package.json` (Next + React 19 + Tailwind).
- [ ] Настроить `next.config.*`: output при необходимости для SSG, пути к ассетам.
- [ ] Скопировать/перенести `tailwind.config.*`, глобальные стили, шрифты (Nunito, Varela Round) — как в текущем лендинге.
- [ ] Перенести `landing/client/public/*` в `landing/public/` (images, fonts, favicon, manifest).
- [ ] **Локальная проверка:** `npm run build` в landing без ошибок, `npm run start` — открыть `/` и убедиться, что стили и шрифты подгружаются (пока можно пустая или заглушка страница).

### 0.2. Layout и главная страница

- [ ] Создать `app/layout.tsx`: корневой layout с `<html lang="ru">`, подключением шрифтов (preload как в текущем `index.html`), глобальных стилей, **Яндекс.Метрика** (счётчик 106534984) — скрипт из текущего `landing/client/index.html` перенести в клиентский компонент или в layout (Script из `next/script`).
- [ ] Создать `app/page.tsx`: перенести разметку и порядок секций из `client/src/pages/home.tsx` (Hero → PainBlock → HopeBlock → SocialProof → Reviews → StyleGallery → HowItWorks → Features → PriceBlock → FAQ + Sticky CTA). Импортировать компоненты из `components/landing/` (путь скорректировать под новую структуру, например `src/components/landing/` или `components/landing/`).
- [ ] Перенести все компоненты из `client/src/components/landing/` и `client/src/components/ui/` в выбранную структуру (например `components/landing/`, `components/ui/`), поправить импорты (`@/` алиас).
- [ ] Перенести `client/src/lib/utils.ts` (cn, buildTelegramStartLink) в `lib/utils.ts`; обновить импорты.
- [ ] Фон Hero (`heroBg` из `@assets/generated_images/...`) перенести в `public/` и обновить путь в разметке главной.
- [ ] **Локальная проверка:** `npm run build` и `npm run start`. Главная `/` визуально совпадает с текущим лендингом, все секции на месте, кнопка «Сделать пак стикеров в Telegram» ведёт на `t.me/Photo_2_StickerBot?start=web` (или текущее поведение без UTM).

### 0.3. CTA и buildTelegramStartLink(pageSlug)

- [ ] Расширить `buildTelegramStartLink(pageSlug?: string)`: если в URL есть `utm_source` или `yclid` — формировать payload из utm_* и yclid (логика как в текущем `utils.ts`, макс 64 символа); иначе возвращать `pageSlug ? `web_${pageSlug}` : 'web'`. На клиенте использовать `window.location.search` (вызов только в браузере).
- [ ] Обновить `TelegramButton`: принимать опциональный проп `startPayload?: string` или `pageSlug?: string`; если передан — использовать для формирования ссылки при отсутствии UTM/yclid; иначе вызывать `buildTelegramStartLink()` без аргумента (текущее поведение).
- [ ] На главной передавать в Sticky CTA `pageSlug=""` или не передавать (чтобы было `?start=web`).
- [ ] **Локальная проверка:**  
  - Открыть `/` → ссылка кнопки `...?start=web`.  
  - Открыть `/?utm_source=yandex&utm_medium=cpc&yclid=1234567890123` → ссылка содержит utm и yclid в start (без `web_`).  
  - Убедиться, что при передаче `pageSlug="stiker-iz-foto"` ссылка без UTM даёт `?start=web_stiker-iz-foto`.

### 0.4. Метаданные главной и canonical

- [ ] В `app/page.tsx` (или layout для главной) задать `metadata`: title, description, openGraph, twitter (одно общее OG-изображение по спеке), `metadataBase: new URL('https://photo2sticker.ru')`, canonical для главной `https://photo2sticker.ru/`.
- [ ] **Локальная проверка:** View Source на `/` — в `<head>` есть нужные теги (title, description, og:*, canonical).

### 0.5. Sitemap и robots

- [ ] Реализовать `app/sitemap.ts`: отдавать массив URL (пока только главная `https://photo2sticker.ru/` с priority 1.0 и lastmod).
- [ ] Реализовать `app/robots.ts` (или статичный `public/robots.txt`): `User-agent: *`, `Allow: /`, `Sitemap: https://photo2sticker.ru/sitemap.xml`.
- [ ] **Локальная проверка:** GET `/sitemap.xml` и `/robots.txt` — корректное содержимое.

### 0.6. Страница 404

- [ ] Создать `app/not-found.tsx`: простая страница с текстом «Страница не найдена» и ссылками на главную и (позже) на `/style/`.
- [ ] **Локальная проверка:** открыть несуществующий путь — отображается кастомная 404.

### Критерий завершения этапа 0

- В `landing/` работает `npm run build` и `npm run start`.
- Главная визуально и по поведению соответствует текущему лендингу (секции, CTA, Метрика).
- CTA: без UTM → `?start=web`, с UTM/yclid → payload из параметров; с pageSlug без UTM → `?start=web_{pageSlug}`.
- В HTML главной есть title, description, og-теги, canonical.
- Работают `/sitemap.xml`, `/robots.txt`, кастомная 404.
- Старый Vite/Express при необходимости отключён или удалён (по решению о полной миграции в этом же репозитории).

---

## Этап 1. Восемь кластерных посадочных

**Цель:** 8 статичных страниц с уникальными title, h1, контентом (Hero, Pain, Hope, HowItWorks, FAQ, SEO-текст, перелинковка, CTA). Без StyleGallery (по матрице §7.4 спеки). Локальное тестирование.

### 1.1. Шаблон кластерной страницы

- [ ] Создать общий layout/компонент «кластерная страница»: Hero (H1 + подзаголовок из пропсов) → PainBlock → HopeBlock → SocialProof → Reviews → HowItWorks (шаги из пропсов) → Features → PriceBlock → FAQ (вопросы из пропсов) → блок «Посмотрите также» (ссылки из пропсов) → Sticky CTA с `pageSlug` из пропсов. StyleGallery не выводить.
- [ ] Данные страницы передавать через пропсы или импорт из конфига (см. 1.2).

### 1.2. Конфиг данных для кластерных

- [ ] Создать конфиг/данные для 8 кластеров (по таблице из спеки §5.1): slug, title, metaDescription, h1, heroSubtitle, тексты для Pain/Hope (каст под кластер или общий), шаги HowItWorks, массив FAQ {q, a}, SEO-текст (400–600 слов — можно заглушка с ключами), ссылки для «Посмотрите также» (другие кластерные + позже стилевые), ctaStart (например `web_foto` для /stiker-iz-foto). Пример slug: `stiker-iz-foto`, `bot`, `telegram`, `iphone`, `android`, `animirovannye`, `s-nadpisyu`, `besplatno`.

### 1.3. Роуты и метаданные

- [ ] Создать для каждого slug папку и `page.tsx`: `app/stiker-iz-foto/page.tsx`, `app/bot/page.tsx`, … (8 штук). В каждом — `generateMetadata` из конфига (title, description, canonical), рендер шаблона кластерной с данными этого кластера.
- [ ] Добавить в `app/sitemap.ts` все 8 URL с priority 0.9 и lastmod.

### 1.4. Компоненты контента

- [ ] SEO-текст: секция с H2 и абзацами, контент из пропсов; разметка семантичная (article или section).
- [ ] «Посмотрите также»: блок с заголовком и ссылками на другие страницы (внутренняя перелинковка).
- [ ] Убедиться, что TelegramButton на каждой кластерной получает свой `pageSlug` (например `stiker-iz-foto` для /stiker-iz-foto).

### 1.5. Локальная проверка этапа 1

- [ ] `npm run build` без ошибок; для каждой из 8 страниц — `generateStaticParams` не требуется (статичные пути).
- [ ] Открыть каждую из 8 URL: уникальные title и h1 в HTML, canonical указывает на себя, внизу кнопка с `?start=web_{slug}` (при отсутствии UTM в адресе).
- [ ] Проверить одну страницу с UTM: `/?utm_source=yandex&yclid=123` — CTA должна содержать payload с yclid, а не `web_*`.
- [ ] На каждой странице нет галереи стилей; есть блок «Посмотрите также» со ссылками.
- [ ] `/sitemap.xml` содержит главную и 8 кластерных URL.

---

## Этап 2. Каталог стилей и 12 стилевых групп

**Цель:** Страница `/style/` (каталог) и 12 страниц `/style/[group]` с галереей, подстилями, HowItWorks, SEO-текстом, FAQ, перелинковкой, CTA. Без блоков Pain/Hope. Локальное тестирование.

### 2.1. Данные стилевых групп

- [ ] Конфиг для 12 групп по спеке §5.2: slug (anime, memy, milye, 3d, lyubov, kotiki, multfilm, igry, manhwa, risunok, serialy, russkiy), title, h1, metaDescription, список подстилей (slug, nameRu, presetId, emoji, image fallback), relatedStyles (slugs для перелинковки), ctaStart (например `web_anime`), SEO-текст и FAQ (5–7 вопросов). Маппинг slug группы и подстилей — по таблицам §3.2–3.3 спеки.

### 2.2. Страница каталога /style/

- [ ] `app/style/page.tsx`: список всех 12 групп (карточки/ссылки на `/style/[group]`). Метаданные: title «Стили стикеров», description, canonical `.../style/`.
- [ ] Добавить `/style/` в sitemap.

### 2.3. Динамическая страница группы /style/[group]

- [ ] `app/style/[group]/page.tsx`: `generateStaticParams` возвращает массив из 12 group slug. По `params.group` брать данные из конфига.
- [ ] Разметка: Hero (H1 + подзаголовок) → StyleGallery (сетка примеров по группе; пока статичные картинки или заглушки из конфига) → карточки подстилей (ссылки на `/style/[group]/[substyle]`) → HowItWorks (3 шага, шаг 2 каст под стиль) → SEO-текст → FAQ → «Посмотрите также» (другие группы + 1–2 кластерные) → Sticky CTA с `pageSlug` группы (например `anime`).
- [ ] `generateMetadata` из конфига группы (title, description, canonical).
- [ ] Pain/Hope не выводить.

### 2.4. StyleGallery под группу

- [ ] Компонент StyleGallery принимает массив стилей (превью + название); на странице группы передавать подстили этой группы. Источник изображений — статичные fallback из конфига (фаза 3 позже подключит API).

### 2.5. Локальная проверка этапа 2

- [ ] `npm run build`: генерируются 1 + 12 страниц (style + style/[group]).
- [ ] Открыть `/style/` — список 12 групп, ссылки ведут на `/style/anime` и т.д.
- [ ] Открыть `/style/anime`: есть H1 «Аниме стикеры из фото», галерея/карточки подстилей, нет Pain/Hope, CTA с `?start=web_anime`.
- [ ] Sitemap включает `/style/` и все `/style/[group]`.

---

## Этап 3. API примеров и галереи (подготовка к фазам 3–4 спеки)

**Цель:** В лендинге есть API-маршрут для примеров стикеров по группе/подстилю; на страницах стилей можно подставлять данные из API или пока оставить статичные fallback. Локальное тестирование без обязательного подключения к Supabase (можно мок).

### 3.1. API route в Next.js

- [ ] Создать `app/api/styles/[groupId]/examples/route.ts`: GET, возвращает JSON массив вида `[{ id, public_url, style_preset_id }]`. Пока без БД: захардкоженный мок или пустой массив; позже — запрос в Supabase (env SUPABASE_URL, SUPABASE_ANON_KEY в landing).
- [ ] Опционально: query-параметр `limit` (по умолчанию 16).

### 3.2. Использование на страницах (опционально в этом этапе)

- [ ] На странице группы при наличии данных из API подставлять их в StyleGallery; при отсутствии — оставить статичные картинки из конфига. Локально можно не подключать Supabase, только проверить вызов API и fallback.

### 3.3. Локальная проверка этапа 3

- [ ] GET `/api/styles/anime/examples` возвращает 200 и JSON (мок или пустой массив).
- [ ] Сборка и главная/стилевые страницы не падают.

---

## Этап 3а. Контент Hero и блока «Выбери свой стиль» из БД

**Цель:** Блоки Hero (карусель паков эмоций) и StyleGallery («Выбери свой стиль») тянут данные из Supabase; при недоступности API — fallback на текущий конфиг/статику. Картинки карусели Hero остаются статичными; картинки галереи стилей — из БД при наличии `stickers.public_url`.

**Детальный план и правки БД:** [landing-db-content-requirements.md](./landing-db-content-requirements.md).

### 3а.1. Изменения в БД (основной репо)

- [ ] Миграция `sql/090_stickers_public_url.sql`: добавить в таблицу `stickers` колонку `public_url text`. Комментарий: публичный URL примера стикера для лендинга (заполняется воркером при загрузке в Storage для is_example = true).

### 3а.2. API лендинга

- [ ] `GET /api/packs/content-sets`: читать из Supabase таблицу `pack_content_sets` (is_active = true, order by sort_order). Ответ: `[{ id, name_ru, labels, sort_order }]`. При ошибке/нет env — 503 или пустой массив; клиент Hero использует fallback из `lib/emotion-packs.ts`.
- [ ] `GET /api/styles/groups`: читать из Supabase `style_groups` + первый пресет по группе из `style_presets_v2`; маппинг group_id → slug для URL. Ответ: `[{ id, name_ru, emoji, sort_order, slug, preview_image? }]`. Поле `preview_image` — по возможности один пример из `stickers` (is_example, public_url) по пресету группы; иначе null (лендинг подставляет fallback из конфига). При ошибке — fallback на конфиг style-groups.
- [ ] Расширить `GET /api/styles/[groupId]/examples`: при наличии Supabase возвращать примеры из `stickers` (is_example = true, style_preset_id в группе, public_url not null); иначе мок/пустой массив.

### 3а.3. Hero (EmotionPackCarousel)

- [ ] При загрузке главной: `fetch('/api/packs/content-sets')`. При успехе — рендер пилюль и подписей слайдов из ответа; картинки карусели по-прежнему `/images/carousel/{sort_order}/1.png` … `9.png`. При ошибке — данные из `lib/emotion-packs.ts` и те же статичные пути.

### 3а.4. Блок «Выбери свой стиль» (StyleGallery на главной)

- [ ] При загрузке главной: `fetch('/api/styles/groups')`. При успехе — строить карточки из ответа: name_ru (на главной можно stripIzFoto), emoji, href=`/style/${slug}`, image = preview_image ?? fallback из конфига (первый подстиль группы). При ошибке — текущий `mainStyleGalleryItems` из `getAllStyleGroupSlugs()` + конфиг.

### 3а.5. Воркер (фаза 2 — после 3а.1–3а.4)

- [ ] При сохранении стикера с `is_example = true`: загрузка файла в Supabase Storage (bucket stickers-examples), запись `public_url` в `stickers`. По спеке §6.4 — только примеры попадают в Storage.

### 3а.6. Локальная проверка этапа 3а

- [ ] С миграцией 090: колонка `stickers.public_url` есть; сборка основного репо не падает.
- [ ] В landing: при наличии SUPABASE_URL/SUPABASE_ANON_KEY API возвращают данные из БД; при отключённом Supabase Hero и StyleGallery показывают fallback без ошибок.
- [ ] Главная: Hero отображает паки из API (или fallback); StyleGallery — группы из API с превью или fallback-картинками.

---

## Этап 4. Подстраницы стилей /style/[group]/[substyle]

**Цель:** 45 подстраниц (или подмножество для MVP), генерируемых по данным из конфига/`style_presets_v2`. Уникальные title, H1, галерея по подстилю, SEO-текст, FAQ, CTA. Локальное тестирование.

### 4.1. Конфиг подстилей

- [ ] Расширить конфиг (или отдельный файл) списком всех подстилей: `groupSlug`, `substyleSlug`, `presetId`, `nameRu`, SEO-текст (300–500 слов), FAQ (4–6 вопросов). Данные по таблице §3.3 и маппингу из спеки.

### 4.2. Страница /style/[group]/[substyle]

- [ ] `app/style/[group]/[substyle]/page.tsx`: `generateStaticParams` — все пары (group, substyle) из конфига. По params брать данные подстиля.
- [ ] Разметка: H1 «{nameRu} стикеры из фото» → галерея примеров (из API по presetId или статичный fallback) → навигация «← Все стили» (ссылка на `/style/[group]`) → HowItWorks → SEO-текст → FAQ → «Посмотрите также» (соседние подстили + группа) → Sticky CTA с `?start=web_{presetId}`.
- [ ] `generateMetadata`: title, description, canonical. BreadcrumbList (JSON-LD) при желании уже на этом этапе.

### 4.3. Sitemap

- [ ] В `app/sitemap.ts` добавить все URL подстилей (или генерировать из того же конфига, что и generateStaticParams).

### 4.4. Локальная проверка этапа 4

- [ ] `npm run build`: генерируются все подстраницы без ошибок.
- [ ] Открыть несколько подстраниц (например `/style/anime/chibi`): уникальный title/h1, галерея, CTA с нужным start.
- [ ] Sitemap содержит подстраницы.

---

## Этап 5. Schema.org, финальный SEO и чеклист

**Цель:** FAQPage, HowTo, SoftwareApplication, BreadcrumbList где нужно; внутренняя перелинковка по спеке; чеклист технического SEO (§6.7 спеки) выполнен. Всё проверяется локально.

### 5.1. Schema.org

- [ ] На страницах с FAQ добавить JSON-LD FAQPage (данные из пропсов FAQ).
- [ ] На главной и/или кластерных с инструкцией — HowTo (шаги из HowItWorks).
- [ ] На главной и `/bot` — SoftwareApplication (название, category, operatingSystem: Telegram).
- [ ] На страницах `/style/[group]` и `/style/[group]/[substyle]` — BreadcrumbList (Главная → Стили → Группа [→ Подстиль]).

### 5.2. Внутренняя перелинковка

- [ ] Проверить по спеке §6.6: кластерные → 3–4 стилевые; стилевые группы → подстили + 3–4 другие группы + 1–2 кластерные; подстили → группа + 2–3 соседних. Footer при наличии — ссылки на группы стилей.

### 5.3. Чеклист технического SEO (по п. 6.7)

- [ ] Title 50–60 символов, description 150–160, canonical на себя, OG/Twitter, один H1, H2/H3 без пропусков, alt у изображений, sitemap с lastmod, robots.txt, 404.

### 5.4. Локальная проверка этапа 5

- [ ] View Source на нескольких страницах: в head есть JSON-LD (FAQPage, HowTo или SoftwareApplication, BreadcrumbList где нужно).
- [ ] Перелинковка «Посмотрите также» и футер соответствуют спеке.
- [ ] Пройти чеклист 6.7 по выборочным страницам.

---

## Порядок выполнения и зависимости

```
0 (миграция + CTA + мета + sitemap/robots)
    ↓
1 (8 кластерных)
    ↓
2 (каталог /style/ + 12 групп)
    ↓
3 (API examples, мок/подключение)
    ↓
3а (Hero + StyleGallery из БД; миграция stickers.public_url, API паков/групп, воркер → Storage)
    ↓
4 (подстраницы стилей)
    ↓
5 (Schema, перелинковка, чеклист)
```

После каждого этапа — полная локальная проверка (build + ручные проверки из чеклиста этапа). Релизы и деплой не делаем до явного запроса.

---

## Где что лежит (после миграции)

| Что | Путь в landing/ |
|-----|-----------------|
| Layout, Метрика | `app/layout.tsx` |
| Главная | `app/page.tsx` |
| Кластерные | `app/[slug]/page.tsx` (8 папок) |
| Каталог стилей | `app/style/page.tsx` |
| Группа стиля | `app/style/[group]/page.tsx` |
| Подстиль | `app/style/[group]/[substyle]/page.tsx` |
| Sitemap, robots | `app/sitemap.ts`, `app/robots.ts` |
| CTA, buildTelegramStartLink | `lib/utils.ts`, `components/landing/TelegramButton.tsx` |
| Конфиг кластеров/стилей | например `lib/seo/cluster-pages.ts`, `lib/seo/style-pages.ts` (или один конфиг) |

---

## Ссылки

- [seo-landing-pages-spec.md](./seo-landing-pages-spec.md) — полное ТЗ, контент-план, матрица блоков, технические требования.
- [landing-db-content-requirements.md](./landing-db-content-requirements.md) — контент Hero и галереи стилей из БД: детальный план, миграции, API, fallback.
- [17-02-landing-changes-by-framework.md](./done/02/17-02-landing-changes-by-framework.md) — структура лендинга Pain → Hope → Solution.
- [13-02-yandex-direct-conversions.md](./done/02/13-02-yandex-direct-conversions.md) — UTM, yclid, офлайн-конверсии.
