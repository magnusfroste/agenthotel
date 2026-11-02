// Replies that failed at the model (lib/modelErrors.js), read from Hermes'
// agent.log. Lines are as Hermes wrote them on peter, torbjorn, davida and
// matthias in October 2026, with ids shortened.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseHermesLog, classify, summarize, notification, redact } = require('../lib/modelErrors');

const LOG = [
  "2026-10-30 08:56:33,541 INFO run_agent: OpenAI client created (chat_completion_stream_request, shared=False) thread=Thread-8 provider=custom base_url=https://api.garageai.eu/v1 model=garageai/auto",
  "2026-10-30 08:56:35,305 WARNING [20260929_122908_4feab0c0] agent.conversation_loop: API call failed (attempt 1/3, not retryable) error_type=UnprocessableEntityError thread=x provider=custom base_url=https://api.garageai.eu/v1",
  "2026-10-30 08:56:36,368 ERROR [20260929_122908_4feab0c0] agent.conversation_loop: Non-retryable client error: Error code: 422 - {'error': {'message': 'ExceededBudget: User=f0c3e384-5bd3-4ef8-b612-503c080c15cb over budget. Spend=5.024757090200001, Budget=5.0', 'type': 'budget_exceeded', 'param': None, 'code': '422'}}",
  "2026-10-07 04:00:12,101 ERROR [cron_3e1cec2f_1_2] agent.conversation_loop: Non-retryable client error: Error code: 404 - {'error': {'message': 'The model `gpt-5.6-flash` does not exist.', 'type': 'invalid_request_error'}}",
  "2026-10-11 15:32:09,001 ERROR agent.conversation_loop: API call failed after 3 retries. HTTP 530 — Cloudflare Tunnel error | kluster.autoversio.ai | Cloudflare",
  "2026-10-12 02:35:00,000 ERROR agent.conversation_loop: Non-retryable client error: Error code: 401 - {'error': 'Unauthorized'}",
  "2026-09-29 17:46:00,000 ERROR [local-1] agent.conversation_loop: [subagent-2] Non-retryable client error: Error code: 400 - {'error': {'message': \"Unsupported parameter: 'reasoning.effort' is not supported with this model.\", 'type': 'invalid_request_error'}}"
].join('\n');

test('only the lines that end a turn count, with the gateway they were sent to', () => {
  const errors = parseHermesLog(LOG);
  assert.strictEqual(errors.length, 5);
  const budget = errors.find(e => e.kind === 'budget');
  assert.strictEqual(budget.at, Date.parse('2026-10-30T08:56:36Z'));
  assert.strictEqual(budget.host, 'api.garageai.eu');
  assert.strictEqual(budget.source, 'chat');
  assert.match(budget.summary, /^ExceededBudget: User=… over budget\. Spend=5\.02/);
});

test('each failure says what the operator can do about it', () => {
  const kinds = parseHermesLog(LOG).map(e => e.kind);
  assert.deepStrictEqual(kinds, ['budget', 'model', 'unavailable', 'key', 'other']);
  assert.strictEqual(parseHermesLog(LOG)[1].source, 'cron');
  assert.strictEqual(classify('Error code: 429 - rate limit reached'), 'rate_limit');
  assert.strictEqual(classify("This model's maximum context length is 996147 tokens"), 'context');
});

test('a provider message keeps the quotes inside it', () => {
  const other = parseHermesLog(LOG).find(e => e.kind === 'other');
  assert.strictEqual(other.summary, "Unsupported parameter: 'reasoning.effort' is not supported with this model.");
});

test('keys never get through', () => {
  assert.doesNotMatch(redact('Incorrect API key provided: sk-proj-abcdef1234567890abcdef'), /abcdef1234567890/);
  assert.doesNotMatch(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'), /eyJhbGci/);
  assert.doesNotMatch(redact('token 0123456789abcdef0123456789abcdef01'), /0123456789abcdef0123/);
});

test('the dashboard counts the last 24 hours, and the phone hears what to do', () => {
  const errors = parseHermesLog(LOG);
  const now = Date.parse('2026-10-30T12:00:00Z');
  const s = summarize(errors, now);
  assert.strictEqual(s.count, 1);
  assert.deepStrictEqual(s.kinds, { budget: 1 });
  assert.match(s.last.advice, /budget/);
  assert.deepStrictEqual(summarize([], now), { count: 0 });
  const msg = notification('peter', [errors[0]]);
  assert.match(msg, /^peter could not answer: the budget for its key at the model gateway is used up at api\.garageai\.eu\. 1 reply failed, the last at 08:56 UTC/);
  assert.strictEqual(notification('peter', []), null);
});

test('a log without failures, or no log at all, is no failures', () => {
  assert.deepStrictEqual(parseHermesLog(''), []);
  assert.deepStrictEqual(parseHermesLog(undefined), []);
  assert.deepStrictEqual(parseHermesLog('2026-10-30 08:56:35,305 WARNING agent.conversation_loop: Retrying API call in 4s (attempt 1/3)'), []);
});
