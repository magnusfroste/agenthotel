// The Environment tab's text view. It is a view of the same pairs, so the one
// thing it must never do is lose or alter a value on the way through.
const { test } = require('node:test');
const assert = require('node:assert');

const load = () => import('../../frontend/src/lib/envText.js');

test('what people paste is read: comments, export, quotes, = inside a value', async () => {
  const { parseEnvText } = await load();
  const { pairs, errors } = parseEnvText([
    '# from my laptop',
    '',
    'export OPENAI_API_KEY=sk-abc',
    'DATABASE_URL=postgres://u:p@db/x?sslmode=require&a=b',
    'SECRET_B64=YWJj==',
    'GREETING="hello world"',
    "SINGLE='kept as is'",
    'EMPTY=',
    '  SPACED_KEY = value  ',
  ].join('\r\n'));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(Object.fromEntries(pairs.map(p => [p.key, p.value])), {
    OPENAI_API_KEY: 'sk-abc',
    DATABASE_URL: 'postgres://u:p@db/x?sslmode=require&a=b',
    SECRET_B64: 'YWJj==',
    GREETING: 'hello world',
    SINGLE: 'kept as is',
    EMPTY: '',
    SPACED_KEY: 'value',
  });
});

test('a line that is not a variable is an error with its line number, not a silent drop', async () => {
  const { parseEnvText } = await load();
  const { errors } = parseEnvText('GOOD=1\njust some text\nmy-key=2\n=nokey');
  assert.strictEqual(errors.length, 3);
  assert.match(errors[0], /^Line 2:/);
  assert.match(errors[1], /^Line 3: "my-key"/);
  assert.match(errors[2], /^Line 4:/);
});

test('a duplicate keeps the last value, as a shell would, and says so', async () => {
  const { parseEnvText } = await load();
  const { pairs, warnings } = parseEnvText('A=1\nB=2\nA=3');
  assert.deepStrictEqual(pairs, [{ key: 'A', value: '3' }, { key: 'B', value: '2' }]);
  assert.strictEqual(warnings.length, 1);
});

test('rows → text → rows gives back exactly the same values', async () => {
  const { toEnvText, mergeTextEdit } = await load();
  const pairs = [
    { key: 'PLAIN', value: 'abc' },
    { key: 'LEADING_SPACE', value: '  padded' },
    { key: 'HASH', value: '#not-a-comment' },
    { key: 'QUOTED', value: '"already quoted"' },
    { key: 'EQUALS', value: 'a=b=c' },
    { key: 'EMPTY', value: '' },
  ];
  const back = mergeTextEdit(toEnvText(pairs), pairs);
  assert.deepStrictEqual(back.errors, []);
  assert.deepStrictEqual(back.pairs, pairs);
});

test('a multi-line value is never shown as text and never lost by a text edit', async () => {
  const { toEnvText, mergeTextEdit } = await load();
  const pairs = [{ key: 'A', value: '1' }, { key: 'COMPOSE_FILE', value: 'services:\n  web:\n    image: x' }];
  const text = toEnvText(pairs);
  assert.strictEqual(text, 'A=1');
  const edited = mergeTextEdit('A=2\nB=3', pairs);
  assert.deepStrictEqual(edited.pairs, [
    { key: 'A', value: '2' }, { key: 'B', value: '3' },
    { key: 'COMPOSE_FILE', value: 'services:\n  web:\n    image: x' },
  ]);
});
