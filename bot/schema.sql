-- Crown Sky: база знаний и регистрации (Neon / Postgres)
-- Выполнить: npm run init-db

CREATE TABLE IF NOT EXISTS users (
  telegram_id   BIGINT PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  photo_url     TEXT,
  name          TEXT,
  pending_seat  INTEGER,
  seat_id       INTEGER,
  status        TEXT NOT NULL DEFAULT 'new',
  ticket_no     TEXT,
  invited_by    BIGINT,
  registered_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS halls (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seats (
  seat_id    INTEGER PRIMARY KEY,
  hall_id    INTEGER,
  row_number INTEGER NOT NULL,
  place      INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'single',
  status     TEXT NOT NULL DEFAULT 'free',
  owner_id   BIGINT
);

CREATE TABLE IF NOT EXISTS news (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL UNIQUE,
  body         TEXT NOT NULL,
  photo_url    TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id           SERIAL PRIMARY KEY,
  telegram_id  BIGINT,
  name         TEXT NOT NULL DEFAULT 'Пилот',
  text         TEXT NOT NULL,
  photo_url    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Миграция для уже существующей базы
ALTER TABLE users ADD COLUMN IF NOT EXISTS ticket_no TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by BIGINT;
ALTER TABLE seats ADD COLUMN IF NOT EXISTS hall_id INTEGER;

-- Первый зал
INSERT INTO halls (id, name) VALUES (1, 'Зал 1') ON CONFLICT (id) DO NOTHING;

-- 120 одиночных кресел: 10 рядов по 12 мест, id 0..119
INSERT INTO seats (seat_id, hall_id, row_number, place, kind)
SELECT i, 1, (i / 12) + 1, (i % 12) + 1, 'single'
FROM generate_series(0, 119) AS i
ON CONFLICT (seat_id) DO NOTHING;

-- Нижний ряд: 6 двойных диванов, id 120..125
INSERT INTO seats (seat_id, hall_id, row_number, place, kind)
SELECT i, 1, 11, i - 119, 'double'
FROM generate_series(120, 125) AS i
ON CONFLICT (seat_id) DO NOTHING;

UPDATE seats SET hall_id = 1 WHERE hall_id IS NULL;

-- Стартовые новости
INSERT INTO news (title, body) VALUES
  ('Набор в бета-тест открыт', 'Займи место в небесном зале, забери билет и подпишись на бота. Первые пилоты получат корабль «Гуль».'),
  ('Корабль «Гуль» в подарок', 'Огненный корабль с расправленными крыльями достанется тем, кто подтвердит регистрацию одним из первых.'),
  ('Мидгейт ждёт пилотов', 'Небесный город, парящие острова и открытое небо — всё это уже близко. Следи за новостями здесь.')
ON CONFLICT (title) DO NOTHING;

-- Удаляем демонстрационные записки, если они попали в базу раньше
DELETE FROM reviews WHERE text IN (
  'Попробовала полёт — небо просто космос! Очень жду бета-тест.',
  'Хочу собрать корабль под мортиры и летать с друзьями.',
  'Оставлю записку: сделайте больше островов с уютными домиками 🙂',
  'Когда уже можно будет зайти? Готов тестировать каждый вечер.'
);

-- Удалить тестовую регистрацию, оставленную при проверке API
UPDATE seats SET status = 'free', owner_id = NULL
WHERE owner_id IN (SELECT telegram_id FROM users WHERE name = 'Проверка');
DELETE FROM users WHERE name = 'Проверка';
