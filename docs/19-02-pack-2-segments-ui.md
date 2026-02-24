# 2. Введение групп паков (сегменты для UI)

**Дата:** 2026-02-19  
**Связано:** pack_content_sets, карусель паков, [19-02-pack-1-content-and-ru-descriptions.md](19-02-pack-1-content-and-ru-descriptions.md).

---

## Цель

Ввести **группы паков (сегменты)** для навигации в карусели/UI: пользователь сначала выбирает группу (Реакции, Сарказм, Дом и т.д.), затем — конкретный набор внутри группы.

---

## Таблица сегментов

| Сегмент (id) | name_ru | Кол-во паков | Назначение |
|--------------|---------|--------------|------------|
| reactions | Реакции | 5 | Живые реакции дня, интроверт, работа, отношения, с характером |
| sarcasm | Сарказм | 5 | Холодный, дерзкий, королевский, ленивый, рабочий |
| home | Дом | 3 | Домашний режим, хаос, хаос лёгкий абсурд |
| events | События | 7 | Праздник, романтический праздник, нежный вечер (2), ночной разговор, после ссоры (2) |
| affection_support | Нежность / поддержка | 4 | Благодарность, нежность, я рядом, лучший друг |
| after_dark | After Dark | 4 | Намёк, ночью все спят, уверенный флирт, опасно близко |
| boundaries | Границы | 0 | Зарезервировано под будущий пак |

---

## Привязка паков к сегментам

Каждый контент-набор из `pack_content_sets` привязан к одному сегменту.

**Вариант A:** в таблице `pack_content_sets` хранится поле **`segment`** (text или FK): значение = id сегмента (reactions, sarcasm, home, events, affection_support, after_dark, boundaries).

**Вариант B:** отдельная таблица **`pack_segments`** с колонками `id`, `name_ru`, `name_en`, `sort_order`; в `pack_content_sets` — колонка `segment_id` (FK на pack_segments).

---

## Список pack_content_set id по сегментам

| Сегмент | Pack id |
|---------|---------|
| reactions | reactions_daily_v2, reactions_emotions_v22, reactions_introvert_day_v1, reactions_work_day_v1, reactions_relationship_day_v1 |
| sarcasm | sass_v2, sass_bold_v1, sass_royal_v1, sass_lazy_v1, sass_work_v1 |
| home | everyday_home_mode_v2, everyday_home_chaos_v1, everyday_home_chaos_v2 |
| events | holiday_solo_v3, holiday_romantic_v1, holiday_tender_evening_v1, holiday_tender_evening_playful_v2, holiday_night_talk_v1, holiday_after_argument_v1, holiday_after_argument_sensual_v1 |
| affection_support | thanks_solo_v2, affection_solo_v2, support_presence_v1, friendship_core_v1 |
| after_dark | romantic_tension_v1, romantic_night_sensual_v1, romantic_night_confident_flirt_v1, after_dark_danger_close_v1 |
| boundaries | (пока пусто) |

Полные данные паков (поля, scene_descriptions_ru, carousel_description_ru и т.д.) — в документе **1**.

---

## Логика в UI (карусель)

1. **Первый уровень:** показать сегменты (вкладки или горизонтальный скролл по группам) в порядке `sort_order` сегментов.
2. **Второй уровень:** после выбора сегмента показать карточки паков этого сегмента по `sort_order` набора.
3. **Альтернатива:** одна общая карусель всех паков с визуальной группировкой — разделители или заголовки между сегментами.

Реализация: фильтрация наборов по `segment` (или `segment_id`), сортировка по `sort_order` внутри группы.
