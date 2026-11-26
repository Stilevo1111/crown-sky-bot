import { createHmac, timingSafeEqual } from 'node:crypto';

// Проверка подписи Telegram WebApp / Mini App (initData)
export function validateInitData(initData, token) {
  if (!initData || !token) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secretKey).update(checkString).digest();

  let provided;
  try {
    provided = Buffer.from(hash, 'hex');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    user = null;
  }

  const authDate = Number(params.get('auth_date') || 0);
  // Защита от повторного использования старых initData (сутки)
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

  return {
    user,
    startParam: params.get('start_param') || '',
    authDate
  };
}

export function seatFromStartParam(startParam) {
  const match = /^seat_(\d+)$/.exec(String(startParam || ''));
  return match ? Number(match[1]) : null;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
