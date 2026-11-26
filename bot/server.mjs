import 'dotenv/config';
import express from 'express';
import { Bot, InlineKeyboard } from 'grammy';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  runSchema,
  invalidateCache,
  getNews,
  getSeat,
  getUser,
  upsertUser,
  confirmRegistration,
  getUserByTicket,
  resetRegistration,
  addNews,
  getSubscribers,
  getReviews,
  addReview,
  ensureHalls,
  getSetting,
  setSetting,
  getStats,
  seatLabel,
  avatarUrl,
  setUserPhotoFile,
  getUsersNeedingPhoto
} from './db.mjs';
import { validateInitData, seatFromStartParam, escapeHtml } from './telegram.mjs';

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error('BOT_TOKEN не задан. Скопируйте .env.example в .env.');

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const BOT_USERNAME = process.env.BOT_USERNAME || 'crown_sky_bot';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SET_WEBHOOK = String(process.env.SET_WEBHOOK || 'true').toLowerCase() === 'true';
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
// Куда публиковать посты (/post):groupId или @channel
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'site');

const bot = new Bot(TOKEN);
bot.catch(err => console.error('[bot error]', err));

// Аватарка из профиля Telegram: держим file_id и отдаём через свой прокси,
// чтобы не светить токен бота в ссылках на сайте.
async function syncUserPhoto(telegramId) {
  try {
    if (!telegramId) return;
    const u = await getUser(telegramId);
    if (!u || u.photo_url || u.photo_file_id) return;
    const photos = await bot.api.getUserProfilePhotos(telegramId, { limit: 1 });
    const fileId = photos?.photos?.[0]?.slice(-1)?.[0]?.file_id;
    if (fileId) await setUserPhotoFile(telegramId, fileId);
  } catch (err) {
    console.warn('⚠️ Не удалось получить аватарку:', err?.description || err?.message);
  }
}

function photoFor(pilot) {
  return pilot?.photo_url || (pilot?.photo_file_id ? avatarUrl(pilot.telegram_id) : null);
}

function webAppUrl(startParam = '') {
  return `${PUBLIC_URL}/webapp.html${startParam ? '?start=' + encodeURIComponent(startParam) : ''}`;
}

const isGroupChat = chatId => chatId != null && String(chatId).startsWith('-');
const BETA_URL = PUBLIC_URL || 'https://crown-sky.onrender.com';
const BOT_START_URL = `https://t.me/${BOT_USERNAME}?start=register`;

// В группах Telegram не принимает web_app-кнопки — там только кнопки бета-теста
function addWebAppButton(kb, chatId, label, startParam = '') {
  if (isGroupChat(chatId)) return addBetaButtons(kb);
  kb.webApp(label, webAppUrl(startParam));
  return kb;
}

function addBetaButtons(kb) {
  kb.url('🚀 Открыть бета-тест', BETA_URL)
    .row()
    .url('🤖 Зарегистрироваться в боте', BOT_START_URL);
  return kb;
}

function mainKeyboard(startParam = '', chatId = null) {
  const kb = new InlineKeyboard();
  if (isGroupChat(chatId)) return addBetaButtons(kb);
  kb.webApp('🚀 Продолжить в приложении', webAppUrl(startParam))
    .row()
    .text('✅ Подтвердить регистрацию', 'confirm')
    .text('📰 Новости', 'news')
    .row()
    .text('🎟 Мой билет', 'status');
  return kb;
}

function newsText(items) {
  if (!items.length) return '📰 Пока нет новостей — следи за этим местом.';
  return '📰 <b>Новости Crown Sky</b>\n\n' + items
    .map(n => `✦ <b>${escapeHtml(n.title)}</b>\n${escapeHtml(n.body)}`)
    .join('\n\n');
}

function postKeyboard(chatId) {
  const kb = new InlineKeyboard();
  if (isGroupChat(chatId)) return addBetaButtons(kb);
  kb.webApp('🎟 Занять место', webAppUrl('register'))
    .row()
    .url('🌐 Открыть сайт', BETA_URL)
    .url('🤖 Открыть бота', BOT_START_URL);
  return kb;
}

async function sendPost(chatId, text, photoFileId) {
  const base = {
    parse_mode: 'HTML',
    reply_markup: postKeyboard(chatId)
  };
  const msg = photoFileId
    ? await bot.api.sendPhoto(chatId, photoFileId, { ...base, caption: text || '📢 Crown Sky' })
    : await bot.api.sendMessage(chatId, text || '📢 Crown Sky', base);

  // Реакции «сердечко» и «разбитое сердечко»
  try {
    await bot.api.setMessageReaction(chatId, msg.message_id, [
      { type: 'emoji', emoji: '❤️' },
      { type: 'emoji', emoji: '💔' }
    ]);
  } catch (err) {
    console.warn('⚠️ Не удалось поставить реакции:', err.message);
  }
  return msg.message_id;
}

// ─── Команды бота ───────────────────────────────────────────────
bot.command('start', async ctx => {
  const payload = String(ctx.match || '').trim();
  const seatId = seatFromStartParam(payload);
  const refMatch = /^ref_(\d+)$/.exec(payload);
  const invitedBy = refMatch ? Number(refMatch[1]) : null;
  const seat = seatId != null ? await getSeat(seatId) : null;

  if (seatId != null && !seat) {
    await ctx.reply('⚠️ Это место не найдено. Открой заново ссылку с сайта.');
    return;
  }

  const from = ctx.from;
  const existing = await getUser(from.id);
  await upsertUser({
    telegram_id: from.id,
    username: from.username || null,
    first_name: from.first_name || null,
    photo_url: from.photo_url || null,
    pending_seat: seatId,
    status: 'pending',
    invited_by: invitedBy
  });
  if (seatId != null && existing?.status === 'confirmed' && existing.seat_id !== seatId) {
    await resetRegistration(from.id, seatId);
  }
  await syncUserPhoto(from.id);

  const seatLine = seat
    ? `\n\n🎟 Твоё место: <b>${escapeHtml(seatLabel(seat))}</b>`
    : '\n\nВыбери место на сайте или в приложении.';

  let waiting = null;
  try { waiting = (await getStats()).waiting; } catch (err) {}
  const statsLine = waiting != null ? `\n\n👥 Уже <b>${waiting}</b> пилотов в списке.` : '';
  const inviteLine = invitedBy ? `\n\n🤝 Вас пригласил пилот <b>${invitedBy}</b>.` : '';

  await ctx.reply(
    `👑 <b>CROWN SKY</b>\nНабор в бета-тест открыт!` +
    seatLine +
    statsLine +
    inviteLine +
    `\n\nПодтверди регистрацию — и мы сообщим, когда небеса откроются.`,
    { parse_mode: 'HTML', reply_markup: mainKeyboard(payload, ctx.chat?.id) }
  );
});

bot.command('news', async ctx => {
  const items = await getNews(3);
  const kb = new InlineKeyboard();
  addWebAppButton(kb, ctx.chat?.id, '📄 Все новости');
  await ctx.reply(newsText(items), { parse_mode: 'HTML', reply_markup: kb });
});

bot.command('status', async ctx => {
  const user = await getUser(ctx.from.id);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Открой сайт или нажми /start.');
    return;
  }
  const seatId = user.seat_id ?? user.pending_seat;
  const seat = seatId != null ? await getSeat(seatId) : null;
  const status = user.status === 'confirmed' ? '✅ Подтверждена' : '⏳ Ожидает подтверждения';
  await ctx.reply(
    `🎟 <b>Твой билет</b>\n\nСтатус: <b>${status}</b>\nМесто: <b>${escapeHtml(seatLabel(seat))}</b>\nИмя: <b>${escapeHtml(user.name || user.first_name || 'Гость')}</b>`,
    { parse_mode: 'HTML', reply_markup: mainKeyboard('', ctx.chat?.id) }
  );
});

bot.command('help', async ctx => {
  await ctx.reply(
    '👑 <b>Crown Sky Bot</b>\n\n' +
    '• /start — начать регистрацию (или продолжить с ссылки с сайта)\n' +
    '• /news — последние новости\n' +
    '• /status — статус билета\n' +
    '• /help — эта справка\n' +
    '• /invite — ссылка, чтобы позвать друга\n' +
    '• /post — опубликовать пост (только админ)\n' +
    '• /connect — подключить группу для постов (в группе)\n\n' +
    'В приложении можно выбрать место, оставить записку и следить за новостями.',
    { parse_mode: 'HTML' }
  );
});

bot.command('news_add', async ctx => {
  if (!ADMIN_IDS.has(String(ctx.from.id))) {
    await ctx.reply('⛔ Недостаточно прав.');
    return;
  }
  const raw = String(ctx.match || '').trim();
  const [title, ...rest] = raw.split('|');
  if (!title || !rest.length) {
    await ctx.reply('Формат: /news_add Заголовок | Текст новости');
    return;
  }
  await addNews(title.trim(), rest.join('|').trim());
  invalidateCache();
  await ctx.reply('✅ Новость опубликована.');
});

bot.command('invite', async ctx => {
  const url = `https://t.me/${BOT_USERNAME}?start=ref_${ctx.from.id}`;
  const shareUrl = 'https://t.me/share/url?url=' + encodeURIComponent(url) +
    '&text=' + encodeURIComponent('Полетаем вместе в Crown Sky? Забирай билет в бета-тест!');
  await ctx.reply(
    `🤝 <b>Пригласи друга</b>\n\nОтправь эту ссылку — и он попадёт к нам в бот:\n<code>${escapeHtml(url)}</code>\n\nРегистрация продолжится автоматически, и мы увидим, кто кого позвал.`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().url('📤 Поделиться', shareUrl)
    }
  );
});

// Подключить группу: отправить /connect прямо в нужной группе
bot.command('connect', async ctx => {
  if (!ADMIN_IDS.has(String(ctx.from.id))) {
    await ctx.reply('⛔ Недостаточно прав.');
    return;
  }
  if (ctx.chat?.type === 'private') {
    const current = await getSetting('group_chat_id').catch(() => null) || GROUP_CHAT_ID;
    await ctx.reply(
      current
        ? `Текущая группа для постов: <code>${escapeHtml(String(current))}</code>\nОтправьте /connect в нужной группе, чтобы изменить.`
        : 'Группа не подключена. Отправьте /connect в той группе, куда бот должен публиковать посты.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  const chatId = String(ctx.chat.id);
  await setSetting('group_chat_id', chatId);
  await ctx.reply(
    `✅ Группа подключена: ${escapeHtml(ctx.chat.title || chatId)}\nID: <code>${escapeHtml(chatId)}</code>\nТеперь /post будет публиковать и сюда.`,
    { parse_mode: 'HTML' }
  );
});

// Общая публикация поста
async function publishPost(ctx, text, photo) {
  if (!ADMIN_IDS.has(String(ctx.from.id))) {
    await ctx.reply('⛔ Недостаточно прав.');
    return;
  }
  if (!text && !photo) {
    await ctx.reply('Формат: /post Текст поста — или отправьте фото с подписью /post Текст');
    return;
  }
  // Telegram не даёт подпись к фото длиннее 1024 символов
  const safeText = escapeHtml(text.slice(0, 1000));
  const sent = [];
  for (const id of ADMIN_IDS) {
    try {
      await sendPost(Number(id) || id, safeText, photo);
      sent.push('личный чат');
    } catch (err) {
      console.warn('⚠️ Не удалось отправить в личный чат ' + id + ':', err.message);
      sent.push('ошибка личного чата');
    }
  }
  const targetGroup = await getSetting('group_chat_id').catch(() => null) || GROUP_CHAT_ID;
  if (targetGroup) {
    try {
      await sendPost(targetGroup, safeText, photo);
      sent.push('группа');
    } catch (err) {
      const detail = err?.description || err?.message || 'unknown error';
      console.warn(`⚠️ Не удалось отправить в группу ${targetGroup}:`, detail);
      sent.push(`ошибка отправки в группу ${targetGroup} (${detail})`);
    }
  } else {
    sent.push('группа не подключена — отправьте /connect в группе');
  }
  await ctx.reply('✅ Пост опубликован: ' + sent.join(', '));
}

// Текстовый пост: /post Текст
bot.command('post', async ctx => {
  if (ctx.msg?.photo?.length) return; // фото обрабатывается отдельным хендлером ниже
  await publishPost(ctx, String(ctx.match || '').trim(), null);
});

// Пост с фото: фото + подпись "/post Текст"
bot.on('message:photo', async ctx => {
  const caption = String(ctx.msg?.caption || '').trim();
  if (!/^\/post\b/i.test(caption)) return;
  const text = caption.replace(/^\/post\s*/i, '').trim();
  const photo = ctx.msg.photo[ctx.msg.photo.length - 1].file_id;
  await publishPost(ctx, text, photo);
});

// ─── Inline-кнопки ──────────────────────────────────────────────
bot.callbackQuery('confirm', async ctx => {
  const updated = await confirmRegistration(ctx.from.id);
  if (!updated) {
    await ctx.answerCallbackQuery('Место уже занято или ссылка устарела — выбери другое');
    const kb = new InlineKeyboard();
    addWebAppButton(kb, ctx.chat?.id, '🚀 Открыть приложение');
    await ctx.reply('Выбери место в приложении, затем нажми «Подтвердить регистрацию».', { reply_markup: kb });
    return;
  }
  await ctx.answerCallbackQuery('✅ Регистрация подтверждена');
  invalidateCache();
  const seat = await getSeat(updated.pending_seat ?? updated.seat_id);
  await ctx.editMessageText(
    `🎉 <b>Регистрация подтверждена!</b>\n\nТвоё место: <b>${escapeHtml(seatLabel(seat))}</b>\nБилет: <b>${escapeHtml(updated.ticket_no || '—')}</b>\n\nКорабль «Гуль» ждёт первых пилотов. Держи связь — напишем, когда начнётся бета-тест.`,
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery('news', async ctx => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  addWebAppButton(kb, ctx.chat?.id, '📄 Все новости');
  await ctx.reply(newsText(await getNews(3)), { parse_mode: 'HTML', reply_markup: kb });
});

bot.callbackQuery('status', async ctx => {
  await ctx.answerCallbackQuery();
  const user = await getUser(ctx.from.id);
  if (!user) {
    await ctx.reply('Ты ещё не зарегистрирован. Нажми /start.');
    return;
  }
  const seatId = user.seat_id ?? user.pending_seat;
  const seat = seatId != null ? await getSeat(seatId) : null;
  await ctx.reply(
    `🎟 <b>Твой билет</b>\n\nСтатус: <b>${user.status === 'confirmed' ? '✅ Подтверждена' : '⏳ Ожидает подтверждения'}</b>\nМесто: <b>${escapeHtml(seatLabel(seat))}</b>`,
    { parse_mode: 'HTML', reply_markup: mainKeyboard('', ctx.chat?.id) }
  );
});

// ─── HTTP-сервер: сайт, Web App и API ───────────────────────────
const app = express();

// Сайт и API на одном домене — CORS всё равно оставляем на всякий случай.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

app.get('/health', (_req, res) => res.json({ ok: true, bot: BOT_USERNAME }));

// Реальная статистика подписавшихся — для счётчика на сайте
app.get('/api/stats', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await getStats()) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.get('/api/news', async (_req, res) => {
  try {
    res.json({ ok: true, items: await getNews(10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// Бесконечная лента залов: frontend просит создать очередные залы при скролле
app.get('/api/halls', async (req, res) => {
  try {
    const offset = Math.max(1, Number(req.query.offset) || 1);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 1, 10));
    const total = await ensureHalls(offset + limit - 1);
    const halls = [];
    for (let h = offset; h <= Math.min(offset + limit - 1, total); h++) {
      halls.push({ id: h, name: 'Зал ' + h, start: (h - 1) * 126, end: h * 126 - 1 });
    }
    res.json({ ok: true, total, halls });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// Аватарки подтверждённых подписчиков для кресел на сайте и в Mini App
app.get('/api/subscribers', async (_req, res) => {
  try {
    res.json({ ok: true, items: await getSubscribers() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// Чат записок на сайте (сохраняется в Neon)
app.get('/api/reviews', async (_req, res) => {
  try {
    res.json({ ok: true, items: await getReviews(30) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/verify-ticket', async (req, res) => {
  try {
    const ticket = String(req.body?.ticket_no || '').trim().toUpperCase().slice(0, 64);
    if (!ticket) return res.status(400).json({ ok: false, error: 'empty_ticket' });
    const pilot = await getUserByTicket(ticket);
    if (!pilot) return res.status(404).json({ ok: false, error: 'ticket_not_found' });
    if (!pilot.photo_url && !pilot.photo_file_id) {
      await syncUserPhoto(pilot.telegram_id);
      const fresh = await getUserByTicket(ticket);
      Object.assign(pilot, fresh || {});
    }
    res.json({
      ok: true,
      ticket_no: pilot.ticket_no,
      name: pilot.name || pilot.first_name || pilot.username || 'Пилот',
      photo_url: photoFor(pilot)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 180);
    if (!text) return res.status(400).json({ ok: false, error: 'empty_text' });

    // Записки доступны только зарегистрированным в боте пилотам.
    const parsed = validateInitData(req.body?.initData, TOKEN);
    let pilot = null;
    if (parsed?.user?.id) {
      const dbUser = await getUser(parsed.user.id);
      if (dbUser?.status === 'confirmed') pilot = dbUser;
    }
    if (!pilot && req.body?.ticket_no) {
      pilot = await getUserByTicket(String(req.body.ticket_no).trim().toUpperCase().slice(0, 64));
    }
    if (!pilot) return res.status(401).json({ ok: false, error: 'registration_required' });

    if (!pilot.photo_url && !pilot.photo_file_id) await syncUserPhoto(pilot.telegram_id);
    const fresh = await getUser(pilot.telegram_id);
    const name = fresh?.name || fresh?.first_name || fresh?.username || 'Пилот';
    const item = await addReview({
      telegramId: pilot.telegram_id,
      name,
      text,
      photoUrl: photoFor(fresh || pilot)
    });
    invalidateCache();
    res.json({ ok: true, item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { initData, name, startParam } = req.body || {};
    const parsed = validateInitData(initData, TOKEN);
    if (!parsed || !parsed.user?.id) {
      return res.status(401).json({ ok: false, error: 'invalid_init_data' });
    }

    const from = parsed.user;
    const existing = await getUser(from.id);
    // Уже зарегистрированный пилот не должен проходить регистрацию повторно
    if (existing?.status === 'confirmed' && existing.seat_id != null) {
      return res.status(409).json({
        ok: false,
        error: 'already_registered',
        seat_id: existing.seat_id,
        ticket_no: existing.ticket_no || null
      });
    }
    const seatId = seatFromStartParam(startParam || parsed.startParam);
    if (seatId != null) {
      const seat = await getSeat(seatId);
      if (!seat) return res.status(400).json({ ok: false, error: 'unknown_seat' });
      if (seat.status === 'taken' && existing?.seat_id !== seatId) {
        return res.status(409).json({ ok: false, error: 'seat_taken' });
      }
    }

    const user = await upsertUser({
      telegram_id: from.id,
      username: from.username || null,
      first_name: from.first_name || null,
      photo_url: from.photo_url || null,
      name: name ? String(name).slice(0, 32) : existing?.name || null,
      pending_seat: seatId ?? existing?.pending_seat ?? null,
      status: existing?.status || 'pending'
    });
    if (seatId != null && existing?.status === 'confirmed' && existing.seat_id !== seatId) {
      await resetRegistration(from.id, seatId);
    }
    await syncUserPhoto(from.id);

    invalidateCache();
    res.json({
      ok: true,
      status: user.status,
      seat_id: user.seat_id ?? user.pending_seat ?? null,
      ticket_no: user.ticket_no || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/confirm', async (req, res) => {
  try {
    const parsed = validateInitData(req.body?.initData, TOKEN);
    if (!parsed || !parsed.user?.id) {
      return res.status(401).json({ ok: false, error: 'invalid_init_data' });
    }
    const user = await confirmRegistration(parsed.user.id);
    await syncUserPhoto(parsed.user.id);
    invalidateCache();
    res.json({ ok: Boolean(user), status: user?.status || null, seat_id: user?.seat_id || null, ticket_no: user?.ticket_no || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// Аватарка пилота через сервер: токен бота не попадает в HTML/CCL
app.get('/api/avatar/:telegramId', async (req, res) => {
  try {
    const id = Number(req.params.telegramId);
    if (!Number.isFinite(id)) return res.sendStatus(404);
    let u = await getUser(id);
    if (!u) return res.sendStatus(404);
    if (!u.photo_url && !u.photo_file_id) {
      await syncUserPhoto(id);
      u = await getUser(id);
    }
    if (!u?.photo_file_id) return res.sendStatus(404);
    const file = await bot.api.getFile(u.photo_file_id);
    const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
    if (!r.ok) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type(r.headers.get('content-type') || 'image/jpeg');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.warn('avatar proxy failed:', err?.message);
    res.sendStatus(404);
  }
});

// Статус текущего пилота — чтобы Mini App не предлагала повторную регистрацию
app.post('/api/me', async (req, res) => {
  try {
    const parsed = validateInitData(req.body?.initData, TOKEN);
    if (!parsed || !parsed.user?.id) {
      return res.status(401).json({ ok: false, error: 'invalid_init_data' });
    }
    const user = await getUser(parsed.user.id);
    res.json({
      ok: true,
      status: user?.status || null,
      seat_id: user?.seat_id ?? user?.pending_seat ?? null,
      ticket_no: user?.ticket_no || null,
      name: user?.name || user?.first_name || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.post('/telegram-webhook', (req, res) => {
  if (WEBHOOK_SECRET && req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  // Отвечаем Telegram быстро, обработку продолжаем асинхронно.
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(err => console.error('[update error]', err));
});

try {
  await bot.init();
} catch (err) {
  console.warn('⚠️ Не удалось получить данные бота (проверьте BOT_TOKEN):', err.message);
  // Запасной botInfo, чтобы вебхук не падал даже с невалидным токеном
  bot.botInfo = {
    id: 0, is_bot: true, first_name: 'Crown Sky', username: BOT_USERNAME,
    can_join_groups: true, can_read_all_group_messages: false,
    supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false
  };
}

// Схема создаётся автоматически при старте — не нужно вручную запускать init-db
try {
  const schema = await readFile(resolve(here, 'schema.sql'), 'utf8');
  await runSchema(schema);
  console.log('✅ Схема Neon проверена/создана');
} catch (err) {
  console.error('❌ Не удалось применить схему Neon:', err.message);
}

// Подтягиваем аватарки уже зарегистрированным пилотам, у которых их нет
try {
  const needing = await getUsersNeedingPhoto();
  for (const u of needing) await syncUserPhoto(u.telegram_id);
} catch (err) {
  console.warn('⚠️ Не удалось обновить аватарки:', err.message);
}

// В группе показываем только одну команду — переход в бету; остальные — в личке
async function setupBotCommands() {
  try {
    await bot.api.deleteMyCommands();
    await bot.api.setMyCommands([
      { command: 'start', description: '🚀 Открыть бета-тест Crown Sky' },
      { command: 'news', description: 'Новости бета-теста' },
      { command: 'status', description: 'Мой билет' },
      { command: 'invite', description: 'Пригласить друга' },
      { command: 'help', description: 'Справка' },
      { command: 'post', description: 'Опубликовать пост (админ)' },
      { command: 'connect', description: 'Подключить группу (админ)' },
      { command: 'news_add', description: 'Добавить новость (админ)' }
    ], { scope: { type: 'all_private_chats' } });
    await bot.api.setMyCommands([
      { command: 'start', description: '🚀 Открыть бета-тест: регистрация и сайт' }
    ], { scope: { type: 'all_group_chats' } });
    console.log('✅ Команды бота обновлены');
  } catch (err) {
    console.warn('⚠️ Не удалось обновить команды бота:', err.message);
  }
}
setupBotCommands();

app.listen(PORT, async () => {
  console.log(`✅ Crown Sky сервер запущен на порту ${PORT}`);
  console.log(`   Сайт:      ${PUBLIC_URL || 'http://localhost:' + PORT}/`);
  console.log(`   Web App:   ${PUBLIC_URL || 'http://localhost:' + PORT}/webapp.html`);
  console.log(`   API/бот:   ${PUBLIC_URL || 'http://localhost:' + PORT}`);

  if (SET_WEBHOOK) {
    if (!PUBLIC_URL) {
      console.warn('⚠️ PUBLIC_URL не задан — вебхук не установлен.');
      return;
    }
    const url = `${PUBLIC_URL}/telegram-webhook`;
    try {
      await bot.api.setWebhook(url, WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : undefined);
      console.log(`✅ Webhook установлен: ${url}`);
    } catch (err) {
      console.error('❌ Не удалось установить webhook:', err);
    }
  }
});
