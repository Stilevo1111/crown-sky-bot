# Crown Sky — инструкция по установке (один Render + Neon + Telegram)

Сайт, Mini App, бот и API работают на **одном** Render Web Service. База — Neon.

```
Telegram ──webhook──▶ Render (сайт + API + бот) ──▶ Neon
Сайт/Mini App ──fetch /api/*──▶ тот же Render ──▶ Neon
```

---

## 0. GitHub

Render разворачивает из Git.

```powershell
cd D:\fissure-bot\Seredin999\fissure-bot_new
git init
git add .
git commit -m "Crown Sky"
git branch -M main
git remote add origin https://github.com/<ВАС>/crown-sky.git
git push -u origin main
```

В репозитории: `package.json`, `bot/server.mjs`, `bot/db.mjs`, `bot/telegram.mjs`, `bot/schema.sql`, `render.yaml`, `bot/scripts/`, `site/`, `.gitignore`, `.env.example`. `.env` и `node_modules` не пушим.

---

## 1. Neon

1. https://neon.tech → Create project, регион **Europe (Frankfurt)**.
2. База `crownsky`, скопируйте connection string:

```
postgresql://user:pass@ep-xxx...neon.tech/crownsky?sslmode=require
```

3. Локально:

```powershell
copy .env.example .env
# вставьте DATABASE_URL и остальные значения
npm install
npm run init-db
```

Появится `✅ Схема и стартовые данные применены к Neon.` Таблицы: `users`, `halls`, `seats`, `news`, `reviews`. Повторный запуск безопасен.

---

## 2. Telegram-бот

1. [@BotFather](https://t.me/BotFather) → `/newbot` → имя и username → токен.
2. `/setcommands`:

```
start - Начать регистрацию в бета-тест
news - Последние новости
status - Статус моего билета
help - Справка
post - Опубликовать пост (админ)
connect - Подключить группу для постов (админ)
invite - Ссылка, чтобы позвать друга
```

3. `/setmenubutton` — после деплоя (шаг 4):

```
https://<ваш-сервис>.onrender.com/webapp.html
```

---

## 3. Render

Dashboard → **New** → **Web Service** → ваш GitHub-репозиторий.

| Настройка | Значение |
|---|---|
| Name | `crown-sky` |
| Region | `Europe (Frankfurt)` |
| Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Plan | Free |

Можно также нажать **New → Blueprint** — `render.yaml` создаст сервис с этими настройками.

### Environment Variables

| Ключ | Значение |
|---|---|
| `BOT_TOKEN` | токен от BotFather |
| `BOT_USERNAME` | username без `@` |
| `PUBLIC_URL` | `https://crown-sky.onrender.com` |
| `DATABASE_URL` | строка Neon |
| `WEBHOOK_SECRET` | случайная строка (Blueprint генерирует сам) |
| `SET_WEBHOOK` | `true` |
| `ADMIN_IDS` | ваш Telegram ID (у @userinfobot) |
| `GROUP_CHAT_ID` | ID группы/канала для постов `/post` (или `@username`) |
| `NODE_VERSION` | `20` |

Больше никаких `PUBLIC_SITE_URL` / `SITE_ORIGIN` не нужно.

---

## 4. Один момент в коде

В `site/index.html` замените:

```js
const BOT_USERNAME = 'crown_sky_bot';
```

на username своего бота. `config.js` трогать **не нужно** — он автоматически использует тот же домен.

```powershell
git add . && git commit -m "Set bot username" && git push
```

Render пересоберёт сервис. Затем BotFather `/setmenubutton` → `https://<ваш-сервис>.onrender.com/webapp.html`.

---

## 5. Проверка

| Адрес | Ожидаемо |
|---|---|
| `https://crown-sky.onrender.com/` | лендинг |
| `https://crown-sky.onrender.com/webapp.html` | Mini App |
| `https://crown-sky.onrender.com/health` | `{"ok":true,"bot":"..."}` |
| `.../api/news` | новости |
| `.../api/stats` | число подписавшихся |
| `.../api/subscribers` | аватарки пилотов |

Проверка webhook (локально):

```powershell
$env:BOT_TOKEN='токен'; npm run webhook:info
```

В Telegram: `/start`, выбрать место на сайте → билет → «Подтвердить регистрацию» → аватарка появится на кресле, счётчик обновится.

---

## Обновления

- Код → `git push` → Render сам пересоберёт.
- `bot/schema.sql` → обязательно `npm run init-db` с реальным `DATABASE_URL`.
- Сменили адрес сервиса → обновить `PUBLIC_URL` и заново `/setmenubutton`.

## Проблемы

| Симптом | Решение |
|---|---|
| `/api/*` → 500 | проверьте `DATABASE_URL`, выполните `npm run init-db` |
| Кнопка Mini App не открывается | проверьте `/setmenubutton` и `PUBLIC_URL` |
| Webhook 403 | пересоздайте `WEBHOOK_SECRET`, Redeploy |
| Счётчик 84 | API недоступен или подтверждённых пользователей нет |
| Первый запрос медленный | Free-план Render засыпает |
