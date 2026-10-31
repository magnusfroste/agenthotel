// A domain is checked when it is saved (lib/domainName.js): "take_01" was
// accepted and then refused by Let's Encrypt, leaving the guest unreachable.
const { test } = require('node:test');
const assert = require('node:assert');
const { domainProblem } = require('../lib/domainName');

test('no domain is fine', () => {
  for (const d of [undefined, null, '']) assert.strictEqual(domainProblem(d), null);
});

test('ordinary domains are fine', () => {
  for (const d of ['take-01.agenthotel.org', 'magnus.froste.eu', 'a.b', 'xn--bcher-kva.example', '1.example.com']) {
    assert.strictEqual(domainProblem(d), null, d);
  }
});

test('an underscore is refused, and the message says to use a hyphen', () => {
  assert.match(domainProblem('take_01.agenthotel.org'), /underscore.*hyphen/);
});

test('what people paste instead of a domain is explained', () => {
  assert.match(domainProblem('https://agent.example.com/'), /address, not a domain/);
  assert.match(domainProblem('agent.example.com:8443'), /port/);
  assert.match(domainProblem('Agent.Example.com'), /lower case/);
  assert.match(domainProblem(' agent.example.com'), /spaces/);
  assert.match(domainProblem('   '), /only spaces/);
  assert.match(domainProblem('localhost'), /needs a dot/);
  assert.match(domainProblem('bücher.example'), /punycode/);
});

test('labels must be well formed', () => {
  for (const d of ['-agent.example.com', 'agent-.example.com', 'agent..example.com', 'a.' + 'x'.repeat(64) + '.com', 'agent.example.com.']) {
    assert.match(domainProblem(d), /not a valid domain/, d);
  }
  assert.match(domainProblem(`${'a'.repeat(60)}.`.repeat(5) + 'com'), /253/);
});
