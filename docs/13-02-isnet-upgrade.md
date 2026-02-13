# Переключение модели rembg: u2net → isnet-general-use

**Дата:** 2026-02-13
**Статус:** В работе

---

## Проблема

Текущая модель `u2net` в rembg часто плохо удаляет фон:
- Оставляет куски фона на сложных изображениях (волосы, тени, мелкие детали)
- Зелёный фон от Gemini не всегда генерируется → модели приходится работать с произвольным фоном (тёмный, градиентный)
- Pixian fallback работает лучше, но платный ($0.07/фото)

---

## Решение

Заменить модель `u2net` на `isnet-general-use` в rembg-сервере.

### Почему isnet-general-use

| Параметр | u2net (текущая) | isnet-general-use |
|----------|-----------------|-------------------|
| Качество | Среднее | Высокое |
| Размер модели | 176 MB | 176 MB |
| RAM | 2 GB | 2-4 GB |
| CPU время | ~1-3 сек | ~1-3 сек |
| GPU нужен? | Нет | Нет |

- Тот же размер и примерно та же скорость, но заметно лучше качество
- Drop-in замена: менять только имя модели, API rembg не меняется
- Не требует GPU, не требует нового сервера
- Не требует изменений в worker.ts — API rembg остаётся прежним

---

## Что менять

### 1. rembg_server.py (3 строки)

**Строка 20** — модель при инициализации:
```python
# Было:
session = new_session("u2net")

# Стало:
session = new_session("isnet-general-use")
```

**Строка 27** — health check:
```python
# Было:
return jsonify({'status': 'ok', 'model': 'u2net'})

# Стало:
return jsonify({'status': 'ok', 'model': 'isnet-general-use'})
```

**Строка 100** — info endpoint:
```python
# Было:
'model': 'u2net',

# Стало:
'model': 'isnet-general-use',
```

### 2. alpha_matting параметры — проверить/тюнить

Текущие параметры (строки 58-65):
```python
output_data = remove(
    input_data,
    session=session,
    alpha_matting=True,
    alpha_matting_foreground_threshold=240,
    alpha_matting_background_threshold=10,
    alpha_matting_erode_size=10,
)
```

**Важно:** `isnet-general-use` может работать иначе с alpha matting.
Рекомендуется:
- Сначала протестировать с текущими параметрами
- Если результат хуже — попробовать без alpha_matting (`alpha_matting=False`)
- isnet часто даёт достаточно чистую маску без alpha matting

### 3. Dockerfile для rembg

Обновить pre-download модели при сборке:
```dockerfile
RUN python -c "from rembg import new_session; new_session('isnet-general-use')"
```

### 4. Ресурсы контейнера на Dockhost

| Параметр | Текущее | Рекомендуемое |
|----------|---------|---------------|
| RAM | 2 GB | 2-4 GB (проверить потребление) |
| CPU | 2 cores | 2 cores (без изменений) |

Если текущих 2 GB хватает — не менять. Если OOM — увеличить до 4 GB.

---

## Что НЕ менять

- **worker.ts** — без изменений, API rembg тот же
- **Pixian fallback** — остаётся как есть
- **Chroma key pipeline** — остаётся как есть
- **Промпт Gemini** — без изменений (зелёный фон по-прежнему запрашиваем)
- **Timeout 90 сек** — оставить, скорость примерно та же

---

## Деплой

### Шаги

1. Обновить `rembg_server.py` (3 строки)
2. Обновить Dockerfile rembg (pre-download модели)
3. Пересобрать Docker-образ rembg
4. Задеплоить на test
5. Проверить:
   - Health check: `curl http://p2s-rembg:5000/health` → `{"model": "isnet-general-use"}`
   - Сгенерировать 3-5 стикеров на тесте
   - Сравнить качество вырезания с текущим
   - Проверить время обработки (ожидание: ~1-3 сек, не более 10 сек)
   - Проверить потребление RAM
6. Если ОК — деплой в прод

### Rollback

Если качество хуже или проблемы с производительностью:
```python
session = new_session("u2net")  # откатить обратно
```
Пересобрать и задеплоить.

---

## Риски

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| isnet потребляет больше RAM → OOM | Низкая | Увеличить RAM до 4 GB |
| alpha_matting работает хуже с isnet | Средняя | Отключить alpha_matting |
| Качество не улучшится заметно | Низкая | Откатить на u2net |
| Первый запрос медленный (загрузка модели) | Низкая | Pre-download в Dockerfile |

---

## Метрики успеха

- Субъективно лучше вырезание на 3-5 тестовых стикерах (особенно: волосы, тёмный фон, мелкие детали)
- Время обработки ≤ 5 сек на 512x512 изображение
- Нет OOM в контейнере в течение суток
- Pixian fallback срабатывает не чаще, чем сейчас

---

## Чеклист

- [x] Обновить `rembg_server.py`: `u2net` → `isnet-general-use` (3 строки)
- [x] Обновить Dockerfile rembg: pre-download `isnet-general-use`
- [x] Обновить docs/architecture/02-worker.md (модель rembg)
- [ ] Пересобрать Docker-образ на Dockhost
- [ ] Деплой на test
- [ ] Тестовые генерации (3-5 стикеров)
- [ ] Проверить RAM / время обработки
- [ ] Деплой в прод
