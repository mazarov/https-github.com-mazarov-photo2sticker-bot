# Аудит SEO лендинга по документу seo-landing-pages-spec.md

**Дата:** 2026-02-17  
**Основа:** [seo-landing-pages-spec.md](./seo-landing-pages-spec.md) (§4–§7, §6.7)

---

## 1. Соответствие спеки по типам страниц

### 1.1. Главная (/)

| Требование (спека) | Статус | Комментарий |
|--------------------|--------|-------------|
| Title 50–60 символов, целевой запрос | ✅ | В `layout.tsx`: «Сделать стикер из фото онлайн бесплатно \| Photo2Sticker» |
| Meta description 150–160 символов | ✅ | Есть в layout |
| Canonical на себя | ⚠️ | **Нет** — в layout только `openGraph.url`. Нужен `alternates.canonical: "https://photo2sticker.ru/"` для главной (лучше задать в `app/page.tsx`) |
| OG / Twitter | ✅ | Одна общая картинка, title/description в layout |
| H1 один, целевой | ✅ | Hero с UTM-вариантами + дефолт |
| Pain, Hope, Reviews, HowItWorks, Features, Price, FAQ | ✅ | Всё на месте |
| Яндекс.Метрика 106534984 | ✅ | В layout |
| Sticky CTA с pageSlug | ✅ | mainCluster.ctaSlug |

### 1.2. Кластерные (8 страниц: /bot, /telegram, /iphone, /android, /animirovannye, /s-nadpisyu, /besplatno)

| Требование | Статус | Комментарий |
|------------|--------|-------------|
| Уникальный title под кластер | ✅ | Из конфига cluster.title |
| Уникальный meta description | ✅ | cluster.metaDescription |
| Canonical на себя | ✅ | `${BASE}/${SLUG}` |
| OG / Twitter | ⚠️ | **Нет переопределения** — при шаринге в соцсетях уйдут title/description из layout (главная). По спеке §6.7: og:title, og:description, og:url — уникальные; og:image — общий. Нужно в `generateMetadata()` добавлять `openGraph` и `twitter` с title/description страницы и общим image |
| H1 + подзаголовок | ✅ | ClusterHero |
| Пилюли эмоций + блок фото→стикер | ✅ | Добавлены |
| Pain, Hope (каст под кластер) | ✅ | painTitle, painText, hopeTitle, hopeText, hopePoints из конфига |
| SocialProof, Reviews (уникальные отзывы) | ✅ | cluster.reviews |
| HowItWorks (шаги каст) | ✅ | cluster.howItWorksSteps |
| Features, PriceBlock | ✅ | Есть |
| SEO-текст 400–600 слов | ⚠️ | **Убран** — контент перенесён в Pain/Hope. Суммарный объём текста меньше 800–1200 слов по §5.4. По смыслу спеки «уникальный контент» закрыт блоками Pain/Hope; при желании усилить SEO можно вернуть короткий блок «О [теме]» (1–2 абзаца) под FAQ |
| FAQ 5–7 вопросов | ✅ | cluster.faq |
| Перелинковка «Посмотрите также» | ✅ | RelatedLinks с cluster.relatedLinks |
| Sticky CTA ?start=web_{slug} | ✅ | cluster.ctaSlug |
| В sitemap | ✅ | priority 0.9 (stiker-iz-foto исключён — маршрут отключён) |

### 1.3. Стилевые группы (/style/[group])

| Требование | Статус | Комментарий |
|------------|--------|-------------|
| Title, description, canonical | ✅ | generateMetadata из styleGroup |
| OG / Twitter | ⚠️ | То же — не переопределены, при шаринге уйдёт главная |
| H1 «{Стиль} стикеры из фото» | ✅ | group.h1 |
| Пилюли + фото→стикер (карусель подстилей) | ✅ | EmotionPills + StyleHero |
| Pain, Hope (уникальные под стиль) | ✅ | group.painTitle, painText, hopeTitle, hopeText, hopePoints |
| Подстили-карточки со ссылками | ✅ | StyleGallery с href на /style/[group]/[substyle] |
| HowItWorks (шаг 2 каст) | ✅ | group.howItWorksSteps |
| Reviews (уникальные) | ✅ | group.reviews |
| SEO-текст 400–600 слов | ⚠️ | Как на кластерах — блока нет, контент в Pain/Hope. При необходимости можно добавить блок «О стиле» |
| FAQ 5–7 | ✅ | group.faq (у части групп 2–3 вопроса — при желании дописать до 5–7) |
| Перелинковка | ✅ | relatedLinks (кластеры + группы) |
| Sticky CTA ?start=web_{group} | ✅ | group.ctaSlug |
| Sitemap | ✅ | priority 0.8 |

### 1.4. Стилевые подстраницы (/style/[group]/[substyle])

| Требование | Статус | Комментарий |
|------------|--------|-------------|
| Title «{Подстиль} стикеры из фото \| Photo2Sticker» | ✅ | Генерируется |
| Description, canonical | ✅ | Есть |
| OG / Twitter | ⚠️ | Не переопределены |
| H1 «{Подстиль} стикеры из фото» | ✅ | substyle.nameRu |
| Навигация «← Все {группа}» | ✅ | Link на группу |
| Pain, Hope от группы | ✅ | group.painTitle/hopeTitle и т.д., hopeTitle с подстановкой подстиля |
| Галерея (один подстиль) | ✅ | StyleGallery с одним элементом |
| HowItWorks каст под подстиль | ✅ | Шаги с подстановкой group/substyle |
| FAQ 4–6 | ✅ | 2 вопроса в коде — при желании расширить из конфига группы/подстиля |
| Sticky CTA ?start=web_{preset_id} | ✅ | substyle.presetId |
| Sitemap | ✅ | priority 0.7 |

### 1.5. Каталог /style/

| Требование | Статус |
|------------|--------|
| Title, description, canonical | ✅ |
| Сетка групп стилей | ✅ |
| Перелинковка на группы | ✅ |

---

## 2. Технический SEO (§6.7)

| Требование | Статус | Где править |
|------------|--------|-------------|
| Title 50–60 символов | ✅ | Конфиги, местами проверить длину |
| Meta description 150–160 | ✅ | Конфиги |
| Canonical на каждую страницу | ⚠️ | Главная: задать в `app/page.tsx` (или layout только для `/`) |
| Open Graph (title, description, image, url) | ⚠️ | Кластеры и стилевые: добавить в generateMetadata openGraph + twitter с title/description страницы, url = canonical, image общий |
| Twitter Card | ⚠️ | Вместе с OG |
| H1 один на страницу | ✅ | Везде |
| H2/H3 иерархия | ✅ | Блоки с заголовками |
| Alt у изображений | ⚠️ | Есть, но можно усилить: в StyleGallery — «{стиль} стикер из фото»; в ClusterHero — «Пример стикера из фото для Telegram» и т.п. по контексту страницы |
| Sitemap все URL, lastmod, priority | ✅ | sitemap.ts |
| robots.txt Allow /, Sitemap | ✅ | robots.ts |
| Schema.org FAQPage | ❌ | **Нет** — вынести FAQ в JSON-LD на страницах с FAQ |
| Schema.org HowTo | ❌ | **Нет** — опционально для HowItWorks на главной и кластерах |
| Schema.org BreadcrumbList | ❌ | **Нет** — на /style/[group] и /style/[group]/[substyle] добавить хлебные крошки (Главная → Стили → Группа [→ Подстиль]) |
| 404 с навигацией | ✅ | not-found.tsx (проверить наличие) |

---

## 3. Рекомендуемые улучшения (приоритет)

### Высокий приоритет

1. **Canonical для главной**  
   В `app/page.tsx` экспортировать `metadata` с `alternates: { canonical: "https://photo2sticker.ru/" }`, либо в layout задавать canonical только если путь `/` (через отдельный layout для главной или middleware).

2. **OG/Twitter для всех SEO-страниц**  
   В каждом `generateMetadata()` (кластеры, стилевые группа/подстраница) и в metadata каталога /style/ добавить:
   - `openGraph: { title, description, url: canonical, images: [{ url: "https://photo2sticker.ru/opengraph.jpg" }], type: "website" }`
   - `twitter: { card: "summary_large_image", title, description, images: ["..."] }`  
   Чтобы при расшаривании отображались заголовок и описание страницы, а не главной.

3. **Schema.org FAQPage**  
   На каждой странице, где рендерится блок FAQ, добавлять JSON-LD в head с типом FAQPage и массивом вопросов/ответов (можно компонент или хелпер, который по переданным questions формирует скрипт).

### Средний приоритет

4. **BreadcrumbList для /style/**  
   На страницах `/style/[group]` и `/style/[group]/[substyle]` выводить JSON-LD BreadcrumbList: Главная → Стили → [Группа] → [Подстиль]. Улучшает отображение в выдаче и навигацию.

5. **Alt у картинок**  
   - В ClusterHero: alt для стикера с контекстом кластера, например «Стикер из фото для Telegram» или «Пример стикера из фото на iPhone».  
   - В StyleGallery: оставить/дополнить формулой вида «{название стиля/подстиля} стикер из фото».

6. **Объём текста и «О [теме]»**  
   По спеке §5.4 на кластерах желательно 800–1200 слов суммарно. Сейчас основной текст — Pain + Hope + HowItWorks + FAQ. При необходимости добавить после FAQ короткий блок «О [боте / стикерах для Telegram / …]» (1–2 абзаца с ключами), без дублирования Pain/Hope.

### Низкий приоритет

7. **HowTo schema**  
   На главной и кластерных опционально добавить HowTo с шагами из HowItWorks для расширенных сниппетов.

8. **Количество вопросов в FAQ**  
   В стилевых группах часть имеет 2–3 вопроса; по спеке 5–7. Дописать вопросы из Wordstat по стилю в конфиг.

9. **Матрица блоков в спеке**  
   В §7.4 для стилевых указано «Pain/Hope — Нет». Фактически на стилевых мы выводим Pain и Hope с уникальными текстами. Имеет смысл обновить спеку под текущую реализацию (Pain/Hope на стилевых — есть, каст под стиль).

---

## 4. Краткий чек-лист по страницам

- **Главная:** canonical, при желании — HowTo schema.  
- **Кластеры:** OG/Twitter в generateMetadata, FAQPage schema.  
- **Стилевые группы:** OG/Twitter, FAQPage, BreadcrumbList, при желании — больше вопросов в FAQ.  
- **Подстили:** OG/Twitter, FAQPage, BreadcrumbList.  
- **Каталог /style/:** OG/Twitter (если ещё не заданы), BreadcrumbList при желании.

---

## 5. Итог

- **Уже хорошо:** уникальные title/description/canonical по страницам, sitemap, robots, Метрика, структура блоков (Pain, Hope, Reviews, HowItWorks, FAQ, перелинковка), CTA с правильным start.
- **Обязательно добавить:** canonical для главной, OG/Twitter для всех SEO-страниц, FAQPage в JSON-LD.
- **Желательно:** BreadcrumbList на стилевых, усиление alt, при необходимости — короткий текстовый блок и доп. вопросы в FAQ по спеке.

После внедрения пунктов высокого приоритета лендинг будет полностью соответствовать техническому чек-листу спеки §6.7 и лучше отображаться в соцсетях и поиске.
