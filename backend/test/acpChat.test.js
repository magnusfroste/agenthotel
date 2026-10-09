// The Chat page: the ACP bridge (backend) and the conversation logic the
// browser uses (frontend/src/lib/acpClient.js), against fakes. The real thing
// was run against Hermes and OpenClaw containers while it was built.
const { test } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const path = require('path');
const { pathToFileURL } = require('url');
const acpBridge = require('../lib/acpBridge');

test('lines are split across chunks and blank lines dropped', () => {
  const lines = [];
  const feed = acpBridge.lineSplitter(l => lines.push(l));
  feed(Buffer.from('{"a":1}\n{"b"'));
  feed(Buffer.from(':2}\r\n\n'));
  assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}']);
});

// A docker whose exec is a pipe: what the client writes comes back as the
// agent's stdout, framed the way docker multiplexes a non-TTY exec.
function fakeDocker({ running = true } = {}) {
  const started = [];
  return {
    started,
    modem: {
      demuxStream(stream, stdout) { stream.on('data', c => stdout.write(c)); }
    },
    getContainer() {
      return {
        inspect: async () => ({ State: { Running: running } }),
        exec: async (opts) => {
          started.push(opts);
          const stream = new PassThrough();
          return {
            start: async () => stream,
            inspect: async () => ({ Running: false })
          };
        }
      };
    }
  };
}

test('a session carries lines both ways and is counted until closed', async () => {
  const docker = fakeDocker();
  const session = await acpBridge.openAcpSession(docker, {
    agentId: 'a1', containerName: 'agenthotel-a1', command: ['hermes', 'acp'], user: 'node', cwd: '/opt/data'
  });
  assert.deepStrictEqual(docker.started[0].Cmd, ['hermes', 'acp']);
  assert.strictEqual(docker.started[0].User, 'node');
  assert.strictEqual(docker.started[0].WorkingDir, '/opt/data');
  assert.strictEqual(docker.started[0].Tty, false);

  const received = [];
  session.onLine(l => received.push(l));
  session.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(received, ['{"jsonrpc":"2.0","id":1,"method":"initialize"}']);
  assert.strictEqual(acpBridge.liveCount('a1'), 1);

  await session.close();
  assert.strictEqual(acpBridge.liveCount('a1'), 0);
  assert.strictEqual(session.send('x'), false);
});

test('a stopped agent cannot be chatted with', async () => {
  await assert.rejects(
    acpBridge.openAcpSession(fakeDocker({ running: false }), { agentId: 'a2', containerName: 'c', command: ['x'] }),
    /not running/
  );
});

test('sessions are capped per agent', async () => {
  const docker = fakeDocker();
  const open = [];
  for (let i = 0; i < acpBridge.MAX_PER_AGENT; i++) {
    open.push(await acpBridge.openAcpSession(docker, { agentId: 'busy', containerName: 'c', command: ['x'] }));
  }
  assert.match(acpBridge.capacityError('busy'), /already has/);
  assert.strictEqual(acpBridge.capacityError('other'), null);
  await Promise.all(open.map(s => s.close()));
  assert.strictEqual(acpBridge.capacityError('busy'), null);
});

async function client() {
  return import(pathToFileURL(path.join(__dirname, '../../frontend/src/lib/acpClient.js')).href);
}

test('updates fold into chat entries', async () => {
  const { applyUpdate } = await client();
  let entries = [];
  const chunk = (sessionUpdate, text) => ({ sessionUpdate, content: { type: 'text', text } });
  entries = applyUpdate(entries, chunk('agent_thought_chunk', 'Thinking '));
  entries = applyUpdate(entries, chunk('agent_thought_chunk', 'hard'));
  entries = applyUpdate(entries, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read_file', kind: 'read', status: 'pending' });
  entries = applyUpdate(entries, chunk('agent_message_chunk', 'Hel'));
  entries = applyUpdate(entries, chunk('agent_message_chunk', 'lo'));
  entries = applyUpdate(entries, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
  entries = applyUpdate(entries, { sessionUpdate: 'usage_update' });
  assert.deepStrictEqual(entries.map(e => e.kind), ['thought', 'tool', 'agent']);
  assert.strictEqual(entries[0].text, 'Thinking hard');
  assert.strictEqual(entries[1].status, 'completed');
  assert.strictEqual(entries[2].text, 'Hello');
});

test('the client answers a permission request with the chosen option', async () => {
  const { AcpClient } = await client();
  const sent = [];
  const socket = { send: s => sent.push(JSON.parse(s)), close() {}, onmessage: null, onclose: null };
  new AcpClient(socket, { onPermission: async (p) => p.options[0].optionId });
  await socket.onmessage({ data: JSON.stringify({
    jsonrpc: '2.0', id: 7, method: 'session/request_permission',
    params: { sessionId: 's', toolCall: { title: 'rm -rf' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] }
  }) });
  assert.deepStrictEqual(sent[0], { jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });

  await socket.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'fs/read_text_file', params: {} }) });
  assert.strictEqual(sent[1].error.code, -32601);
});

test('a request resolves with its response and fails when the socket closes', async () => {
  const { AcpClient } = await client();
  const sent = [];
  const socket = { send: s => sent.push(JSON.parse(s)), close() {}, onmessage: null, onclose: null };
  const c = new AcpClient(socket);
  const answered = c.request('initialize', {});
  await socket.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { agentInfo: { name: 'x' } } }) });
  assert.deepStrictEqual(await answered, { agentInfo: { name: 'x' } });
  const pending = c.request('session/prompt', {});
  socket.onclose();
  await assert.rejects(pending, /closed/);
});
