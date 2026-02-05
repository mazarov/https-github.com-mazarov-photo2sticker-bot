# Self-hosted rembg — Удаление фона на своём сервере

## Цель

Заменить Pixian API на self-hosted rembg для:
- Снижения стоимости (фиксированная цена вместо pay-per-image)
- Повышения надёжности (нет зависимости от внешнего API)
- Контроля над качеством и скоростью

---

## Архитектура

### Текущая схема (Pixian)

```
┌─────────┐     ┌─────────┐     ┌─────────────┐
│  Bot    │────▶│ Worker  │────▶│ Pixian API  │ (внешний)
│(Dockhost)│    │(Dockhost)│    │             │
└─────────┘     └─────────┘     └─────────────┘
```

### Новая схема (rembg)

```
┌─────────┐     ┌─────────┐     ┌─────────────┐
│  Bot    │────▶│ Worker  │────▶│ rembg API   │ (свой контейнер)
│(Dockhost)│    │(Dockhost)│    │ (Dockhost)  │
└─────────┘     └─────────┘     └─────────────┘
                                      │
                            Внутренняя сеть Dockhost
                            (быстро, бесплатно)
```

---

## Компоненты

### 1. rembg API контейнер

**Dockerfile.rembg:**
```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir rembg[cpu] flask gunicorn pillow

# Download model on build (faster startup)
RUN python -c "from rembg import remove; import io; remove(io.BytesIO())" || true

COPY rembg_server.py .

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--timeout", "120", "--workers", "2", "rembg_server:app"]
```

**rembg_server.py:**
```python
from flask import Flask, request, Response
from rembg import remove
from PIL import Image
import io

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health():
    return {'status': 'ok'}

@app.route('/remove-background', methods=['POST'])
def remove_background():
    if 'image' not in request.files:
        return {'error': 'No image provided'}, 400
    
    input_image = request.files['image'].read()
    
    # Remove background
    output_image = remove(input_image)
    
    return Response(output_image, mimetype='image/png')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
```

### 2. Изменения в worker.ts

```typescript
// Config
const REMBG_URL = process.env.REMBG_URL || 'http://rembg:5000';

// В функции runJob, вместо Pixian:
const rembgForm = new FormData();
rembgForm.append("image", paddedBuffer, {
  filename: "image.png",
  contentType: "image/png",
});

const rembgRes = await retryWithBackoff(
  () => axios.post(`${REMBG_URL}/remove-background`, rembgForm, {
    headers: rembgForm.getHeaders(),
    responseType: "arraybuffer",
    timeout: 120000, // 2 минуты для CPU
  }),
  { maxAttempts: 3, baseDelayMs: 2000, name: "rembg" }
);

const noBgBuffer = Buffer.from(rembgRes.data);
```

---

## Ресурсы и ограничения

### Минимальные требования

| Параметр | Значение | Примечание |
|----------|----------|------------|
| RAM | 2 GB | Минимум для модели U2Net |
| CPU | 2 cores | Больше = быстрее |
| Disk | 1 GB | Модель + Docker image |

### Производительность (CPU)

| CPU cores | Время обработки | Параллельных запросов |
|-----------|-----------------|----------------------|
| 2 | 15-25 сек | 1-2 |
| 4 | 10-15 сек | 2-4 |
| 8 | 5-10 сек | 4-8 |

### Ограничения

1. **Скорость CPU** — 10-25 сек/фото (vs 2-5 сек у Pixian)
2. **Параллельность** — ограничена RAM и CPU
3. **Качество** — хорошее, но Pixian/remove.bg чуть лучше на сложных фото
4. **Первый запрос** — модель загружается ~5-10 сек (потом кешируется)

---

## Деплой в Dockhost

### Шаг 1: Создать контейнер rembg

В Dockhost:
1. Создать новый контейнер из Git
2. Указать Dockerfile.rembg
3. Настройки: 2 GB RAM, 2 CPU
4. Внутренний порт: 5000

### Шаг 2: Настроить сеть

В Dockhost контейнеры в одном проекте видят друг друга по имени.
URL: `http://rembg-container-name:5000`

### Шаг 3: Обновить Worker

Добавить переменную окружения:
```
REMBG_URL=http://rembg:5000
```

---

## Fallback стратегия

Рекомендуется оставить Pixian как fallback:

```typescript
async function removeBackground(imageBuffer: Buffer): Promise<Buffer> {
  // Try rembg first (self-hosted)
  try {
    return await callRembg(imageBuffer);
  } catch (err) {
    console.log("rembg failed, falling back to Pixian:", err.message);
  }
  
  // Fallback to Pixian
  return await callPixian(imageBuffer);
}
```

---

## Стоимость

### Dockhost (примерно)

| Ресурс | Цена/мес |
|--------|----------|
| 2 GB RAM + 2 CPU | ~800₽ |
| 4 GB RAM + 4 CPU | ~1500₽ |

### Сравнение с Pixian

| Генераций/мес | Pixian ($0.07) | rembg (800₽) | Экономия |
|---------------|----------------|--------------|----------|
| 100 | 700₽ | 800₽ | -100₽ |
| 300 | 2100₽ | 800₽ | +1300₽ |
| 500 | 3500₽ | 800₽ | +2700₽ |
| 1000 | 7000₽ | 800₽ | +6200₽ |

**Breakeven:** ~150 генераций/месяц

---

## Мониторинг

### Health check

```bash
curl http://rembg:5000/health
# {"status": "ok"}
```

### Метрики для алертов

- Время обработки > 60 сек → алерт
- HTTP 5xx → алерт
- Контейнер restart → алерт

---

## Checklist

- [x] Создать `Dockerfile.rembg`
- [x] Создать `rembg_server.py`
- [x] Задеплоить контейнер в Dockhost
- [x] Настроить внутреннюю сеть
- [x] Добавить `REMBG_URL` в Worker
- [x] Обновить `worker.ts` — использовать rembg
- [x] Добавить fallback на Pixian
- [ ] Тестирование
- [ ] Мониторинг

---

## Альтернативные модели

Если качество U2Net недостаточно:

| Модель | Качество | Скорость | RAM |
|--------|----------|----------|-----|
| u2net (default) | Хорошее | Быстро | 2 GB |
| u2net_human_seg | Лучше для людей | Быстро | 2 GB |
| isnet-general-use | Отличное | Медленнее | 4 GB |
| birefnet | SOTA | Медленно | 6 GB |

Выбор модели в rembg:
```python
output = remove(input, model_name="u2net_human_seg")
```
