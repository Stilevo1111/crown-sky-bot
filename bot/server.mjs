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
  addNews,
  getSubscribers,
  getReviews,
  addReview,
  ensureHalls,
  getSetting,
  setSetting,
  getStats,
  seatLabel
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

function webAppUrl(startParam = '') {
  return `${PUBLIC_URL}/webapp.html${startParam ? '?start=' + encodeURIComponent(startParam) : ''}`;
}

function mainKeyboard(startParam = '') {
  return new InlineKeyboard()
    .webApp('🚀 Продолжить в приложении', webAppUrl(startParam))
    .row()
    .text('✅ Подтвердить регистрацию', 'confirm')
    .text('📰 Новости', 'news')
    .row()
    .text('🎟 Мой билет', 'status');
}

function newsText(items) {
  if (!items.length) return '📰 Пока нет новостей — следи за этим местом.';
  return '📰 <b>Новости Crown Sky</b>\n\n' + items
    .map(n => `✦ <b>${escapeHtml(n.title)}</b>\n${escapeHtml(n.body)}`)
    .join('\n\n');
}

function postKeyboard() {
  return new InlineKeyboard()
    .webApp('🎟 Занять место', webAppUrl())
    .row()
    .url('🌐 Открыть сайт', PUBLIC_URL || 'https://t.me/' + BOT_USERNAME)
    .url('🤖 Открыть бота', `https://t.me/${BOT_USERNAME}?start=register`);
}

async function sendPost(chatId, text, photoFileId) {
  const base = {
    parse_mode: 'HTML',
    reply_markup: postKeyboard()
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
  await upsertUser({
    telegram_id: from.id,
    username: from.username || null,
    first_name: from.first_name || null,
    photo_url: from.photo_url || null,
    pending_seat: seatId,
    status: 'pending',
    invited_by: invitedBy
  });

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
    { parse_mode: 'HTML', reply_markup: mainKeyboard(payload) }
  );
});

bot.command('news', async ctx => {
  const items = await getNews(3);
  await ctx.reply(newsText(items), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().webApp('📄 Все новости', webAppUrl())
  });
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
    { parse_mode: 'HTML', reply_markup: mainKeyboard() }
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
    await ctx.reply('Отправьте /connect в той группе, куда бот должен публиковать посты.');
    return;
  }
  await setSetting('group_chat_id', String(ctx.chat.id));
  await ctx.reply(`✅ Группа подключена: ${ctx.chat.title || ctx.chat.id}. Теперь /post будет публиковать и сюда.`);
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
  const safeText = escapeHtml(text).slice(0, 1000);
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
  const targetGroup = GROUP_CHAT_ID || await getSetting('group_chat_id').catch(() => null);
  if (targetGroup) {
    try {
      await sendPost(targetGroup, safeText, photo);
      sent.push('группа');
    } catch (err) {
      console.warn('⚠️ Не удалось отправить в группу:', err.message);
      sent.push('ошибка отправки в группу');
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
    await ctx.reply('Выбери место в приложении, затем нажми «Подтвердить регистрацию».', {
      reply_markup: new InlineKeyboard().webApp('🚀 Открыть приложение', webAppUrl())
    });
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
  await ctx.reply(newsText(await getNews(3)), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().webApp('📄 Все новости', webAppUrl())
  });
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
    { parse_mode: 'HTML', reply_markup: mainKeyboard() }
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

app.post('/api/reviews', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 180);
    if (!text) return res.status(400).json({ ok: false, error: 'empty_text' });

    // Если записка отправлена из Telegram — берем имя и аватарку пользователя.
    const parsed = validateInitData(req.body?.initData, TOKEN);
    const from = parsed?.user;
    const name = String(req.body?.name || '').trim().slice(0, 32) ||
      from?.first_name || from?.username || 'Пилот';

    const item = await addReview({
      telegramId: from?.id || null,
      name,
      text,
      photoUrl: from?.photo_url || null
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
    const seatId = seatFromStartParam(startParam || parsed.startParam);
    if (seatId != null) {
      const seat = await getSeat(seatId);
      if (!seat) return res.status(400).json({ ok: false, error: 'unknown_seat' });
      if (seat.status === 'taken' && seat.owner_id !== from.id) {
        return res.status(409).json({ ok: false, error: 'seat_taken' });
      }
    }

    const existing = await getUser(from.id);
    const user = await upsertUser({
      telegram_id: from.id,
      username: from.username || null,
      first_name: from.first_name || null,
      photo_url: from.photo_url || null,
      name: name ? String(name).slice(0, 32) : existing?.name || null,
      pending_seat: seatId ?? existing?.pending_seat ?? null,
      status: existing?.status || 'pending'
    });

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
    invalidateCache();
    res.json({ ok: Boolean(user), status: user?.status || null, seat_id: user?.seat_id || null, ticket_no: user?.ticket_no || null });
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
