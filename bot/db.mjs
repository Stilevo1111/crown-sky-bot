import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL не задан. Скопируйте .env.example в .env и заполните его.');
}

export const sql = neon(process.env.DATABASE_URL);

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
    INSERT INTO users (telegram_id, username, first_name, photo_url, name, pending_seat, status, updated_at)
    VALUES (
      ${data.telegram_id}, ${data.username || null}, ${data.first_name || null},
      ${data.photo_url || null}, ${data.name || null}, ${data.pending_seat ?? null},
      ${data.status || 'new'}, now()
    )
    ON CONFLICT (telegram_id) DO UPDATE SET
      username = COALESCE(EXCLUDED.username, users.username),
      first_name = COALESCE(EXCLUDED.first_name, users.first_name),
      photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url),
      name = COALESCE(EXCLUDED.name, users.name),
      pending_seat = COALESCE(EXCLUDED.pending_seat, users.pending_seat),
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

  const seatRows = await sql`SELECT status FROM seats WHERE seat_id = ${user.pending_seat}`;
  if (!seatRows.length || seatRows[0].status === 'taken') return null; // место уже занято

  const ticketNo = 'CS-' + String(user.pending_seat).padStart(3, '0') + '-' + String(telegramId).slice(-4);
  const rows = await sql`
    UPDATE users
    SET status = 'confirmed',
        seat_id = ${user.pending_seat},
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
    SET status = 'taken', owner_id = ${telegramId}
    WHERE seat_id = ${user.pending_seat}
  `;

  return updated;
}

// Подписчики для аватарок на креслах сайта и Mini App
export async function getSubscribers() {
  return sql`
    SELECT u.seat_id AS seat, u.name, u.first_name, u.username, u.photo_url, u.ticket_no
    FROM users u
    WHERE u.status = 'confirmed' AND u.seat_id IS NOT NULL
    ORDER BY u.seat_id
  `;
}

export async function getReviews(limit = 30) {
  return sql`SELECT * FROM reviews ORDER BY created_at DESC LIMIT ${limit}`;
}

export async function addReview({ telegramId = null, name = 'Пилот', text = '', photoUrl = null }) {
  return sql`
    INSERT INTO reviews (telegram_id, name, text, photo_url)
    VALUES (${telegramId}, ${name}, ${text}, ${photoUrl})
    RETURNING *
  `;
}

export async function getNews(limit = 5) {
  return sql`SELECT * FROM news ORDER BY published_at DESC LIMIT ${limit}`;
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
      FROM generate_series(${start}, ${start + 119}) AS i
      ON CONFLICT (seat_id) DO NOTHING
    `;
    await sql`
      INSERT INTO seats (seat_id, hall_id, row_number, place, kind)
      SELECT i, ${h}, 11, i - ${start + 119}, 'double'
      FROM generate_series(${start + 120}, ${start + 125}) AS i
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
  const users = await sql`SELECT COUNT(*)::int AS n FROM users WHERE status = 'confirmed'`;
  const seats = await sql`SELECT COUNT(*)::int AS n FROM seats WHERE status = 'taken'`;
  return {
    waiting: users[0]?.n || 0,
    seats_taken: seats[0]?.n || 0
  };
}

export function seatLabel(seat) {
  if (!seat) return '—';
  const hall = seat.hall_id ? `зал ${seat.hall_id}, ` : '';
  return hall + (seat.kind === 'double'
    ? `ряд ${seat.row_number}, диван ${seat.place}`
    : `ряд ${seat.row_number}, место ${seat.place}`);
}
