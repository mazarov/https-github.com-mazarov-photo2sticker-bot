# Photo2Sticker Bot Service

**Node.js:** нужна версия **20+** (tsx и зависимости). В проекте есть `.nvmrc`.

- Если используешь **nvm**: один раз сделай `nvm alias default 20`, затем в папке проекта — `nvm use` (подхватит из `.nvmrc`). Тогда в любом новом терминале будет Node 20.
- Чтобы nvm сам переключал версию при заходе в папку, добавь в `~/.zshrc` (или `~/.bashrc`) после строк, которые грузят nvm:
  ```bash
  # авто nvm use при cd в каталог с .nvmrc
  autoload -U add-zsh-hook
  load-nvmrc() { [ -f .nvmrc ] && nvm use; }
  add-zsh-hook chpwd load-nvmrc
  load-nvmrc
  ```
  (для bash аналог — через `cd`-функцию и `PROMPT_COMMAND`.)

Сервис состоит из двух процессов:
- API (Telegram webhook)
- Worker (очередь генерации)

## Запуск локально

```bash
npm install
npm run dev:api
npm run dev:worker
```

По умолчанию API запускается с long polling, если `PUBLIC_BASE_URL` пустой.
Если нужен webhook, укажи публичный URL (например, ngrok) в `PUBLIC_BASE_URL`
и сервис сам вызовет `setWebhook`.

## ENV
См. `.env.example`.

## Примечания
- Все ключи в ENV.
- Таблицы `users`, `sessions`, `transactions`, `bot_texts` используются как есть.
- Для очереди используется таблица `jobs` (будет добавлена позже).
