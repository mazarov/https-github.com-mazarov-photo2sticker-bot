# Админ: «Сделать примером» из меню по ссылке на стикерпак (pack_content_sets)

**Дата:** 27.02.2026  
**Формат:** требования (docs)  
**Контекст:** Заполнение примеров для **карусели паков в боте** (первый шаг выбора пака): админ выбирает набор из **pack_content_sets** (инлайн-кнопки), присылает ссылку на стикерпак; бот скачивает до 9 статичных стикеров, **собирает их в одну сетку 1024×1024** (WebP) и загружает в Storage как **`sticker_pack_example/{content_set_id}/example.webp`** (бакет stickers-examples). Папка **`pack/content/`** используется только для лендинга — в неё не сохраняем из этого сценария.

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

### 1.4. Сборка сетки и загрузка в Storage (sticker_pack_example/{id}/example.webp)

- Скачанные стикеры (до 9 штук) **собираются в одну картинку 1024×1024** (сетка 3×3) через `assembleGridTo1024` (как для примеров эмоций).
- Один файл загружается в Storage: **`sticker_pack_example/{content_set_id}/example.webp`** (бакет `stickers-examples`). Папка **`pack/content/`** — только для лендинга.
- После загрузки: сброс кэша наборов (`clearPackContentSetsCache()`), сообщение админу «Пример для набора «{id}» сохранён (сетка 1024×1024 в sticker_pack_example/)».

---

## 2. Сценарий (flow)

1. Админ нажимает в меню кнопку **«Сделать примером»**.
2. Бот загружает активные наборы из **pack_content_sets** и отправляет сообщение «Выбери набор (для карусели паков):» с инлайн-кнопками (name_ru / name_en).
3. Админ нажимает кнопку нужного набора. Бот проверяет набор в БД, сохраняет contentSetId в `adminPackContentExampleFlow` и просит ссылку.
4. Бот: «Пришли ссылку на стикерпак (https://t.me/addstickers/...)».
5. Админ присылает ссылку. Бот парсит short_name, getStickerSet, скачивает до 9 статичных стикеров, собирает их в сетку 1024×1024 (`assembleGridTo1024`), загружает один файл `sticker_pack_example/{contentSetId}/example.webp`, сбрасывает кэш и пишет подтверждение.
6. Выход из сценария. Повтор: снова нажать «Сделать примером» и выбрать набор.

---

## 3. Технические детали

### 3.1. Telegram Bot API

- getStickerSet(name) — имя набора (short_name из ссылки).
- getFile(file_id) → file_path → скачивание по URL Telegram.

### 3.2. Storage и сборка сетки

- Путь: **`sticker_pack_example/{content_set_id}/example.webp`** — один файл (сетка 1024×1024, WebP) в бакете примеров (config.supabaseStorageBucketExamples).
- Сборка: `assembleGridTo1024(buffers, 3, 3)` из `src/lib/image-utils.ts` (как для примеров эмоций). Карусель паков в боте показывает этот файл. Лендинг использует отдельно **`pack/content/`**.

### 3.3. Состояние админа

- В памяти: `adminPackContentExampleFlow` — Map по telegram_id, значение `{ step: 2, contentSetId }` после выбора набора кнопкой. Шаг 1 — только отображение кнопок.

---

## 4. Критерии приёмки

- [ ] У админа в меню есть кнопка «Сделать примером».
- [ ] По нажатию бот показывает список наборов из **pack_content_sets** инлайн-кнопками; после выбора запрашивает ссылку на стикерпак.
- [ ] По ссылке бот получает набор стикеров (getStickerSet), скачивает до 9 статичных, собирает в сетку 1024×1024 (`assembleGridTo1024`), загружает один файл `sticker_pack_example/{contentSetId}/example.webp`.
- [ ] Кэш pack content sets сбрасывается; админу выводится подтверждение с числом загруженных файлов.

---

## 5. Связанные документы и код

- Карусель паков, pack_content_sets: `docs/architecture/04-database.md`, `docs/architecture/06-style-carousel.md`.
- Лендинг, пилюли: `landing/app/api/packs/content-sets/route.ts`, путь `pack/content/{id}/1..9.webp` (отдельно от бота). Бот: `sticker_pack_example/`.
- Меню админа: `src/index.ts` — `getMainMenuKeyboard`, `adminPackContentExampleFlow`, `handleAdminPackContentExampleText`.
- БД: `pack_content_sets` / `pack_content_sets_test` (config.packContentSetsTable).
