const { test } = require('node:test');
const assert = require('node:assert');
const { timeZoneProblem } = require('../lib/timeZone');

test('empty means where you are, and a request without it is left alone', () => {
  assert.strictEqual(timeZoneProblem(''), null);
  assert.strictEqual(timeZoneProblem(undefined), null);
});

test('a zone name is fine', () => {
  for (const zone of ['Europe/Stockholm', 'UTC', 'America/New_York', 'Asia/Kolkata']) assert.strictEqual(timeZoneProblem(zone), null, zone);
});

test('anything else is refused with what to write instead', () => {
  assert.match(timeZoneProblem('Stockholm/Europe'), /not a time zone this server knows.*Europe\/Stockholm/);
  assert.match(timeZoneProblem(42), /zone name such as Europe\/Stockholm/);
  assert.match(timeZoneProblem('x'.repeat(65)), /zone name/);
});
