// Notification channels for operational alerts (agent down, disk/memory
// pressure). Supports a generic webhook (Slack/Discord-compatible JSON
// {"text": ...}) and the Telegram Bot API. Settings are read fresh on every
// send so changes apply without a restart. Sends are fire-and-forget —
// failures are logged, never thrown.
const fetch = require('node-fetch');

function getSetting(db, key) {
  try {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
  } catch {
    return '';
  }
}

function channelsConfigured(db) {
  return {
    webhook: getSetting(db, 'notify_webhook_url'),
    telegramToken: getSetting(db, 'notify_telegram_token'),
    telegramChatId: getSetting(db, 'notify_telegram_chat_id')
  };
}

function anyChannelConfigured(db) {
  const c = channelsConfigured(db);
  return Boolean(c.webhook || (c.telegramToken && c.telegramChatId));
}

async function sendNotification(db, message) {
  const c = channelsConfigured(db);
  const jobs = [];

  if (c.webhook) {
    jobs.push(fetch(c.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
      timeout: 10000
    }).then(res => {
      if (!res.ok) console.error(`[Notify] Webhook responded HTTP ${res.status}`);
    }).catch(err => console.error('[Notify] Webhook failed:', err.message)));
  }

  if (c.telegramToken && c.telegramChatId) {
    jobs.push(fetch(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: c.telegramChatId, text: message }),
      timeout: 10000
    }).then(async res => {
      if (!res.ok) console.error(`[Notify] Telegram responded HTTP ${res.status}:`, await res.text().catch(() => ''));
    }).catch(err => console.error('[Notify] Telegram failed:', err.message)));
  }

  await Promise.all(jobs);
}

module.exports = { sendNotification, anyChannelConfigured };
