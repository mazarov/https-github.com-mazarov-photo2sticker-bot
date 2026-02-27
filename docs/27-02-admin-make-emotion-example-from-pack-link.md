# Админ: «Сделать примером» из меню по ссылке на стикерпак (pack_content_sets)

**Дата:** 27.02.2026  
**Формат:** требования (docs)  
**Контекст:** Заполнение примеров для **карусели паков** (первый шаг выбора пака): админ выбирает набор из таблицы **pack_content_sets** (инлайн-кнопки), присылает ссылку на стикерпак; бот скачивает до 9 статичных стикеров и загружает их в Storage как `pack/content/{content_set_id}/1.webp` … `9.webp` (бакет stickers-examples). Эти файлы используются на лендинге и в карусели паков.

---

## 1. Требования

### 1.1. Кнопка в меню для админа

- В нижнем меню (Reply Keyboard) у **админа** появляется кнопка: **«Сделать примером»** (или «Make as example»).
- По нажатию бот показывает список **наборов из pack_content_sets** (инлайн-кнопки) и после выбора запрашивает ссылку на стикерпак.

### 1.2. Выбор набора (pack_content_sets, инлайн-кнопки)

- Админ указывает, **для какого набора** загрузить примеры, **нажимая инлайн-кнопку**.
- **Источник:** таблица **pack_content_sets** (или pack_content_sets_test при APP_ENV=test). Бот загружает список (`getActivePackContentSets()`), для каждой записи — кнопка с подписью (name_ru / name_en по языку), callback_data: `admin_pack_content_example:{id}`.
- После нажатия кнопки бот проверяет наличие и активность набора в БД, сохраняет contentSetId в памяти и просит ссылку на стикерпак.

### 1.3. Ссылка на стикерпак

- Админ присылает ссылку в формате `https://t.me/addstickers/{short_name}` или `t.me/addstickers/{short_name}`.
- Бот извлекает short_name, вызывает getStickerSet(short_name), получает список стикеров. Берутся только статичные (не анимированные, не видео), до 9 штук.

### 1.4. Загрузка в Storage (pack/content/{id}/1..9.webp)

- Каждый скачанный стикер загружается отдельным файлом в Storage:
  - Путь: **`pack/content/{content_set_id}/1.webp`**, **`2.webp`**, … **`9.webp`** (бакет `stickers-examples`).
  - Стикер 1 → 1.webp, стикер 2 → 2.webp и т.д.
- После загрузки: сброс кэша наборов (`clearPackContentSetsCache()`), сообщение админу «Примеры для набора «{id}» сохранены (N файлов в pack/content/)».

---

## 2. Сценарий (flow)

1. Админ нажимает в меню кнопку **«Сделать примером»**.
2. Бот загружает активные наборы из **pack_content_sets** и отправляет сообщение «Выбери набор (для карусели паков):» с инлайн-кнопками (name_ru / name_en).
3. Админ нажимает кнопку нужного набора. Бот проверяет набор в БД, сохраняет contentSetId в `adminPackContentExampleFlow` и просит ссылку.
4. Бот: «Пришли ссылку на стикерпак (https://t.me/addstickers/...)».
5. Админ присылает ссылку. Бот парсит short_name, getStickerSet, скачивает до 9 статичных стикеров, загружает каждый в `pack/content/{contentSetId}/1.webp` … `9.webp`, сбрасывает кэш и пишет подтверждение.
6. Выход из сценария. Повтор: снова нажать «Сделать примером» и выбрать набор.

---

## 3. Технические детали

### 3.1. Telegram Bot API

- getStickerSet(name) — имя набора (short_name из ссылки).
- getFile(file_id) → file_path → скачивание по URL Telegram.

### 3.2. Storage

- Путь: **`pack/content/{content_set_id}/1.webp`** … **`9.webp`** в бакете примеров (config.supabaseStorageBucketExamples).
- Лендинг и карусель паков читают примеры из этих путей (см. landing/app/api/packs/content-sets, docs/architecture/04-database.md).

### 3.3. Состояние админа

- В памяти: `adminPackContentExampleFlow` — Map по telegram_id, значение `{ step: 2, contentSetId }` после выбора набора кнопкой. Шаг 1 — только отображение кнопок.

---

## 4. Критерии приёмки

- [ ] У админа в меню есть кнопка «Сделать примером».
- [ ] По нажатию бот показывает список наборов из **pack_content_sets** инлайн-кнопками; после выбора запрашивает ссылку на стикерпак.
- [ ] По ссылке бот получает набор стикеров (getStickerSet), скачивает до 9 статичных, загружает каждый в `pack/content/{contentSetId}/1.webp` … `9.webp`.
- [ ] Кэш pack content sets сбрасывается; админу выводится подтверждение с числом загруженных файлов.

---

## 5. Связанные документы и код

- Карусель паков, pack_content_sets: `docs/architecture/04-database.md`, `docs/architecture/06-style-carousel.md`.
- Лендинг, пилюли: `landing/app/api/packs/content-sets/route.ts`, путь `pack/content/{id}/1..9.webp`.
- Меню админа: `src/index.ts` — `getMainMenuKeyboard`, `adminPackContentExampleFlow`, `handleAdminPackContentExampleText`.
- БД: `pack_content_sets` / `pack_content_sets_test` (config.packContentSetsTable).
