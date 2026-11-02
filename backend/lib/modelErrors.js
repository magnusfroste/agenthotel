// An agent can be "healthy" and still unable to think. peter and torbjorn
// answered every health probe with HTTP 302 while every reply they tried died
// at the model gateway with "ExceededBudget" (2026-10-30). Peter got the error
// message in WhatsApp, and the panel showed nothing. These are the replies
// that failed at the model, read from the agent's own log.

// The lines a Hermes agent writes when a turn has failed for good: a client
// error it will not retry, or a server error after its retries ran out.
// Everything before them (attempt 1/3, retrying in 4s) may still succeed.
const FINAL = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:,\d+)? ERROR (?:\[([^\]]+)\] )?agent\.conversation_loop: (?:\[subagent-\d+\] )?(Non-retryable client error|API call failed after \d+ retries)[:.]? ?(.*)$/;
const BASE_URL = /base_url=(https?:\/\/[^\s/]+)/;

// What the operator can do about it, most specific first.
const KINDS = [
  ['budget', /ExceededBudget|budget_exceeded|insufficient_quota|exceeded your current quota|credit balance/i],
  ['key', /\b401\b|Unauthorized|AuthenticationError|invalid[_ ]api[_ ]key|Incorrect API key/i],
  ['model', /Invalid model name|does not exist|model_not_found|NotFoundError|\b404\b/i],
  ['rate_limit', /\b429\b|rate.?limit/i],
  ['context', /context length|maximum context|too many tokens/i],
  ['unavailable', /\b5\d\d\b|Cloudflare|unavailable|timed? ?out|connection/i]
];

const ADVICE = {
  budget: 'the budget for its key at the model gateway is used up',
  key: 'the model gateway refused its key',
  model: 'the model it asks for does not exist at the gateway',
  rate_limit: 'the model gateway is rate limiting it',
  context: 'the conversation is longer than the model can take',
  unavailable: 'the model gateway did not answer',
  other: 'the model call failed'
};

function classify(text) {
  for (const [kind, re] of KINDS) if (re.test(text)) return kind;
  return 'other';
}

// Keys must never reach the panel, the event log or a phone.
function redact(text) {
  return String(text)
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-…')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer …')
    .replace(/[A-Za-z0-9_-]{32,}/g, '…');
}

// The provider's own words where it gave some ('message': '…'), otherwise the
// start of what was logged.
function summaryOf(rest) {
  // Up to the quote that closes the value, so quotes inside it survive:
  // "Unsupported parameter: 'max_tokens' is not supported with this model."
  const m = rest.match(/['"]message['"]\s*:\s*(['"])(.{1,300}?)\1\s*[,}]/) || rest.match(/['"]error['"]\s*:\s*(['"])(.{1,300}?)\1\s*[,}]/);
  const text = m ? m[2] : rest.replace(/^Error code:\s*/, 'HTTP ');
  return redact(text).slice(0, 200);
}

// Whose turn it was: a scheduled job, or someone talking to the agent.
function sourceOf(tag) {
  return tag && tag.startsWith('cron') ? 'cron' : 'chat';
}

// Failed replies in a Hermes agent.log excerpt, oldest first. Times are the
// container's clock, which the hotel's images keep on UTC.
function parseHermesLog(text) {
  const out = [];
  let host = null;
  for (const line of String(text || '').split('\n')) {
    const b = line.match(BASE_URL);
    if (b) host = new URL(b[1]).host;
    const m = line.match(FINAL);
    if (!m) continue;
    const at = Date.parse(`${m[1].replace(' ', 'T')}Z`);
    if (Number.isNaN(at)) continue;
    const rest = `${m[3]} ${m[4]}`;
    out.push({ at, kind: classify(rest), summary: summaryOf(m[4] || m[3]), source: sourceOf(m[2]), host });
  }
  return out;
}

// What the dashboard shows for one agent: the failures of the last 24 hours.
function summarize(errors, now = Date.now()) {
  const recent = errors.filter(e => now - e.at < 24 * 3600 * 1000);
  if (!recent.length) return { count: 0 };
  const kinds = {};
  for (const e of recent) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  const last = recent[recent.length - 1];
  return { count: recent.length, kinds, last: { ...last, advice: ADVICE[last.kind] } };
}

// The phone message for new failures of one agent, or null.
function notification(name, fresh) {
  if (!fresh.length) return null;
  const last = fresh[fresh.length - 1];
  const at = new Date(last.at).toISOString().slice(11, 16);
  const where = last.host ? ` at ${last.host}` : '';
  return `${name} could not answer: ${ADVICE[last.kind]}${where}. `
    + `${fresh.length === 1 ? '1 reply' : `${fresh.length} replies`} failed, the last at ${at} UTC: ${last.summary}`;
}

module.exports = { parseHermesLog, classify, summarize, notification, redact, ADVICE };
