import { neon, Pool } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL не задан. Скопируйте .env.example в .env и заполните его.');
}

export const sql = neon(process.env.DATABASE_URL);

// Небольшой кэш, чтобы поток регистраций не будил Neon на каждый чих
const cache = new Map();
export function invalidateCache() { cache.clear(); }
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.val;
  const val = await fn();
  cache.set(key, { ts: Date.now(), val });
  return val;
}

// Выполнение SQL-скрипта целиком (CREATE TABLE и т.д.) через пул connection
export async function runSchema(schemaText) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(schemaText);
  } finally {
    await pool.end();
  }
}

export async function getSeat(id) {
  const rows = await sql`SELECT * FROM seats WHERE seat_id = ${id} LIMIT 1`;
  return rows[0] || null;
}

export async function getUser(telegramId) {
  const rows = await sql`SELECT * FROM users WHERE telegram_id = ${telegramId} LIMIT 1`;
  return rows[0] || null;
}

export async function upsertUser(data) {
  const rows = await sql`
    INSERT INTO users (telegram_id, username, first_name, photo_url, name, pending_seat, status, invited_by, updated_at)
    VALUES (
      ${data.telegram_id}, ${data.username || null}, ${data.first_name || null},
      ${data.photo_url || null}, ${data.name || null}, ${data.pending_seat ?? null},
      ${data.status || 'new'}, ${data.invited_by ?? null}, now()
    )
    ON CONFLICT (telegram_id) DO UPDATE SET
      username = COALESCE(EXCLUDED.username, users.username),
      first_name = COALESCE(EXCLUDED.first_name, users.first_name),
      photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url),
      name = COALESCE(EXCLUDED.name, users.name),
      pending_seat = COALESCE(EXCLUDED.pending_seat, users.pending_seat),
      invited_by = COALESCE(EXCLUDED.invited_by, users.invited_by),
      status = CASE WHEN users.status = 'confirmed' THEN users.status ELSE EXCLUDED.status END,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function confirmRegistration(telegramId) {
  const user = await getUser(telegramId);
  if (!user || user.pending_seat == null) return null;
  if (user.status === 'confirmed' && user.seat_id != null) return user; // идемпотентно

  const seatRows = await sql`SELECT kind, status FROM seats WHERE seat_id = ${user.pending_seat}`;
  if (!seatRows.length) return null;
  const isDouble = seatRows[0].kind === 'double';
  const maxPlayers = isDouble ? 2 : 1;
  const countRows = await sql`
    SELECT COUNT(*)::int AS n FROM users
    WHERE seat_id = ${user.pending_seat} AND status = 'confirmed'
  `;
  const occupied = countRows[0]?.n || 0;
  if (occupied >= maxPlayers) return null; // диван заполнен или кресло занято
  const slot = isDouble ? occupied + 1 : 1;

  const ticketNo = 'CS-' + String(user.pending_seat).padStart(3, '0') +
    '-' + String(telegramId).slice(-4) + (isDouble ? '-' + slot : '');
  const rows = await sql`
    UPDATE users
    SET status = 'confirmed',
        seat_id = ${user.pending_seat},
        slot = ${slot},
        pending_seat = NULL,
        ticket_no = ${ticketNo},
        registered_at = now(),
        updated_at = now()
    WHERE telegram_id = ${telegramId}
    RETURNING *
  `;
  const updated = rows[0];

  await sql`
    UPDATE seats
    SET status = ${occupied + 1 >= maxPlayers ? 'taken' : 'partial'}, owner_id = ${telegramId}
    WHERE seat_id = ${user.pending_seat}
  `;

  return updated;
}

// Пользователь перешёл по новой ссылке на место — освобождаем старое
export async function resetRegistration(telegramId, pendingSeat) {
  const old = await getUser(telegramId);
  if (!old || old.seat_id == null) return;
  if (pendingSeat == null || pendingSeat === old.seat_id) return;

  const countRows = await sql`
    SELECT COUNT(*)::int AS n FROM users
    WHERE seat_id = ${old.seat_id} AND status = 'confirmed'
  `;
  const rest = Math.max(0, (countRows[0]?.n || 0) - 1);
  await sql`
    UPDATE seats SET status = ${rest > 0 ? 'partial' : 'free'}, owner_id = NULL
    WHERE seat_id = ${old.seat_id}
  `;
  await sql`
    UPDATE users
    SET status = 'pending', seat_id = NULL, slot = NULL, pending_seat = ${pendingSeat},
        ticket_no = NULL, registered_at = NULL, updated_at = now()
    WHERE telegram_id = ${telegramId}
  `;
  invalidateCache();
}

// Подписчики для аватарок на креслах сайта и Mini App
export async function getSubscribers() {
  return cached('subscribers', 30000, () => sql`
    SELECT u.seat_id AS seat, u.slot, u.name, u.first_name, u.username, u.photo_url, u.ticket_no
    FROM users u
    WHERE u.status = 'confirmed' AND u.seat_id IS NOT NULL
    ORDER BY u.seat_id, u.slot NULLS FIRST
  `);
}

export async function getReviews(limit = 30) {
  return cached('reviews', 30000, () => sql`SELECT * FROM reviews ORDER BY created_at DESC LIMIT ${limit}`);
}

export async function addReview({ telegramId = null, name = 'Пилот', text = '', photoUrl = null }) {
  return sql`
    INSERT INTO reviews (telegram_id, name, text, photo_url)
    VALUES (${telegramId}, ${name}, ${text}, ${photoUrl})
    RETURNING *
  `;
}

export async function getSetting(key) {
  const rows = await sql`SELECT value FROM bot_settings WHERE key = ${key} LIMIT 1`;
  return rows[0]?.value || null;
}

export async function setSetting(key, value) {
  await sql`
    INSERT INTO bot_settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
  invalidateCache();
}

export async function getNews(limit = 5) {
  return cached('news', 60000, () => sql`SELECT * FROM news ORDER BY published_at DESC LIMIT ${limit}`);
}

export async function addNews(title, body, photoUrl = null) {
  return sql`
    INSERT INTO news (title, body, photo_url)
    VALUES (${title}, ${body}, ${photoUrl})
    ON CONFLICT (title) DO UPDATE SET body = EXCLUDED.body, photo_url = EXCLUDED.photo_url
    RETURNING *
  `;
}

export async function ensureHalls(upto) {
  const target = Math.min(Number(upto) || 1, 1000);
  const rows = await sql`SELECT COUNT(*)::int AS n FROM halls`;
  const have = rows[0]?.n || 0;
  if (have >= target) return target;

  for (let h = have + 1; h <= target; h++) {
    const start = (h - 1) * 126;
    await sql`INSERT INTO halls (id, name) VALUES (${h}, ${'Зал ' + h}) ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO seats (seat_id, hall_id, row_number, place, kind)
      SELECT i, ${h}, ((i - ${start}) / 12) + 1, ((i - ${start}) % 12) + 1, 'single'
      FROM generate_series(${start}::int, ${(start + 119)}::int) AS i
      ON CONFLICT (seat_id) DO NOTHING
    `;
    await sql`
      INSERT INTO seats (seat_id, hall_id, row_number, place, kind)
      SELECT i, ${h}, 11, i - ${start + 119}, 'double'
      FROM generate_series(${(start + 120)}::int, ${(start + 125)}::int) AS i
      ON CONFLICT (seat_id) DO NOTHING
    `;
  }
  return target;
}

export async function getHallCount() {
  const rows = await sql`SELECT COUNT(*)::int AS n FROM halls`;
  return rows[0]?.n || 1;
}

export async function getStats() {
  return cached('stats', 30000, async () => {
    const users = await sql`SELECT COUNT(*)::int AS n FROM users WHERE status = 'confirmed'`;
    const seats = await sql`SELECT COUNT(DISTINCT seat_id)::int AS n FROM users WHERE status = 'confirmed' AND seat_id IS NOT NULL`;
    return {
      waiting: users[0]?.n || 0,
      seats_taken: seats[0]?.n || 0
    };
  });
}

export function seatLabel(seat) {
  if (!seat) return '—';
  const hall = seat.hall_id ? `зал ${seat.hall_id}, ` : '';
  return hall + (seat.kind === 'double'
    ? `ряд ${seat.row_number}, диван ${seat.place}`
    : `ряд ${seat.row_number}, место ${seat.place}`);
}
