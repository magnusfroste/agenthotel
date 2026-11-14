// The reception: the one MCP endpoint every guest is given at check-in.
//
// Until this existed a guest learned about a place in the hotel (Lobby for
// landing pages, and so on) only when someone edited that guest's own MCP
// servers: the place's address and token written into the agent by hand, a
// gateway restart to pick it up, and the same again for the next guest and the
// next place. One evening of doing it for a single agent (2026-11-11) met five
// separate problems, none of them the agent's.
//
// Here the hotel answers instead. A guest holds one room key and one MCP
// server, and through it reaches every place the hotel has. The places' own
// tokens stay with the reception: a guest never holds one, so there is nothing
// in its config or on its volume to leak or to rotate.
//
// The tool list is three fixed tools on purpose. An MCP client lists tools
// once, when it connects: Hermes's gateway kept a place's old tool list until
// it was restarted. A reception that listed every place's tools as its own
// would go stale in the same way the day a place opened, closed or was
// upgraded. Three tools that never change, and answers that are always read
// live from the place, cannot.
//
// Only registered places are ever called, at the address the panel itself
// routes to. Nothing in a request names a host, so a guest cannot turn the
// reception into a way to reach something else on the network.

const crypto = require('crypto');
const { parseEnv } = require('./skillhubLink');

// The name the guest's MCP client knows the reception by.
const SERVER_NAME = 'hotel';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;          // what a guest may send in one request
const MAX_REPLY = 8 * 1024 * 1024;     // what a place may answer with
const LIST_TIMEOUT = 20 * 1000;
// Below the 120 s the Hermes plugin gives an MCP call, so a slow place ends as
// an answer from the reception, not as a timeout in the guest's own client.
const CALL_TIMEOUT = 100 * 1000;
// How long a handshake with a place is trusted. A place that was redeployed
// since is noticed sooner, by its refusal of the old session.
const SESSION_TTL = 10 * 60 * 1000;

const INSTRUCTIONS = 'You are a guest in an AgentHotel. The hotel has places you can use, each a service the hotel runs for its guests. '
  + 'Call hotel_guide to see what is here, place_tools to see what one place can do, and use_place to do it. '
  + 'You need no addresses or keys of your own for any of them.';

const TOOLS = [
  {
    name: 'hotel_guide',
    description: 'Start here. What this hotel offers its guests: the places you can use (each is a service the hotel runs, for example a lobby for landing pages), what each one is for, and how to call them. Takes no arguments. Call it again whenever you need to know what is here: places open and close without your tool list changing.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'place_tools',
    description: 'What one place can do. With only `place`: the place\'s own instructions and its tools, one line each. With `tool` as well: that tool\'s full description and input schema. Read the schema before the first use_place call for a tool.',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'A place name from hotel_guide' },
        tool: { type: 'string', description: 'One tool of that place, to get its full schema' }
      },
      required: ['place']
    }
  },
  {
    name: 'use_place',
    description: 'Call a tool at a place. `arguments` is the tool\'s own arguments object, exactly as its schema from place_tools describes it. The answer is the place\'s own answer. If the call fails, the tool\'s schema comes back with the error, so you can correct the arguments and try again.',
    inputSchema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'A place name from hotel_guide' },
        tool: { type: 'string', description: 'A tool name from place_tools' },
        arguments: { type: 'object', description: 'The arguments for that tool. Leave out for a tool that takes none' }
      },
      required: ['place', 'tool']
    }
  }
];

function newRoomKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Which guest a presented key belongs to. Every key is compared, in constant
// time, so how long the answer takes says nothing about how close a guess was.
function guestForKey(keys, presented) {
  const given = crypto.createHash('sha256').update(String(presented || '')).digest();
  let found = null;
  for (const row of keys) {
    if (!row || !row.key) continue;
    const mine = crypto.createHash('sha256').update(String(row.key)).digest();
    if (crypto.timingSafeEqual(given, mine) && presented) found = row.agent_id;
  }
  return found;
}

function configOf(agent) {
  if (agent && agent.config && typeof agent.config === 'object') return agent.config;
  try { return JSON.parse((agent && agent.config) || '{}') || {}; } catch (e) { return {}; }
}

// A place's token is wherever its runtime keeps environment: a key of its own
// for a single container, a line in the env file for a stack.
function tokenOf(config, name) {
  if (!name) return '';
  if (config[name]) return String(config[name]);
  for (const field of ['CUSTOM_ENV', 'COMPOSE_ENV']) {
    const value = parseEnv(config[field])[name];
    if (value) return value;
  }
  return '';
}

// The places open to one guest: every running guest whose template says it is
// a place, except the caller itself. Named after the guest, since a hotel can
// run two of the same kind; a second guest with a name already taken gets -2.
// `targetOf(agent)` is the panel's own answer to where that guest listens.
function listPlaces(agents, templateOf, targetOf, callerId) {
  const places = [];
  const taken = new Set();
  const sorted = [...agents].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)));
  for (const agent of sorted) {
    if (!agent.template || agent.status !== 'running') continue;
    const template = templateOf(agent.template);
    const place = template && template.place;
    if (!place) continue;

    let id = agent.name;
    for (let n = 2; taken.has(id); n++) id = `${agent.name}-${n}`;
    taken.add(id);
    if (agent.id === callerId) continue;

    const headers = {};
    if (place.auth !== 'none') {
      const token = tokenOf(configOf(agent), place.tokenEnv);
      // No token, no way in: a place the reception cannot open is not offered.
      if (!token) continue;
      if (place.auth === 'header') headers[place.header] = token;
      else headers.Authorization = `Bearer ${token}`;
    }
    const target = targetOf(agent);
    if (!target || !target.container || !target.port) continue;

    places.push({
      id,
      agentId: agent.id,
      kind: template.name || agent.template,
      about: String(template.description || '').trim(),
      address: agent.domain ? `https://${agent.domain}` : null,
      url: `http://${target.container}:${target.port}${place.mcp}`,
      headers
    });
  }
  return places;
}

// A reply to a POST is JSON, or an event stream carrying the same JSON in its
// data lines. Either way: the message that answers `id`.
function parseReply(text, contentType, id) {
  const body = String(text || '');
  const messages = [];
  if (/text\/event-stream/i.test(contentType || '')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try { messages.push(JSON.parse(data)); } catch (e) { /* not ours */ }
    }
  } else {
    try {
      const parsed = JSON.parse(body);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch (e) { /* nothing readable */ }
  }
  return messages.find(m => m && m.id === id && ('result' in m || 'error' in m)) || null;
}

function firstLine(text) {
  const line = String(text || '').trim().split(/\n/)[0] || '';
  const sentence = /^(.{20,}?[.!?])(\s|$)/.exec(line);
  const short = sentence ? sentence[1] : line;
  return short.length > 200 ? short.slice(0, 197) + '…' : short;
}

function textResult(value, isError = false) {
  const result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
  if (isError) result.isError = true;
  return result;
}

// The activity log gets one line per guest and place per minute, not one per
// call: an agent at work makes dozens, and a log that is all reception calls
// has no room left for the deploy that failed. `write(guest, message)` is the
// panel's own event writer.
function createUseLog(write, windowMs = 60 * 1000) {
  const open = new Map();

  function flush(key) {
    const b = open.get(key);
    if (!b) return;
    open.delete(key);
    clearTimeout(b.timer);
    const tools = [...b.tools].sort((x, y) => y[1] - x[1]).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
    const calls = b.count === 1 ? 'once' : `${b.count} times`;
    const failed = b.failed ? `, ${b.failed} failed` : '';
    write(b.guest, `${b.guest.name} used ${b.place} ${calls} (${tools})${failed}, ${Math.round(b.ms / b.count)} ms on average`);
  }

  function add({ guest, place, tool, ok, ms }) {
    const key = `${guest.id}|${place}`;
    let b = open.get(key);
    if (!b) {
      b = { guest, place, tools: new Map(), count: 0, failed: 0, ms: 0, timer: setTimeout(() => flush(key), windowMs) };
      if (b.timer.unref) b.timer.unref();
      open.set(key, b);
    }
    b.count++;
    b.ms += ms || 0;
    if (!ok) b.failed++;
    b.tools.set(tool, (b.tools.get(tool) || 0) + 1);
  }

  return { add, flushAll: () => [...open.keys()].forEach(flush) };
}

// `deps`:
//   enabled()            whether the reception is open at all
//   keys()               [{ agent_id, key }], every room key
//   agents()             every guest row
//   templateOf(id)       the template a guest was deployed from, or null
//   targetOf(agent)      { container, port } where that guest listens
//   fetch                node-fetch (injected so the tests can run without it)
//   logUse(entry)        one line per use_place: who, where, what, how it went
//   hotelName()          what the hotel calls itself, for the guide
function createReception(deps) {
  const fetch = deps.fetch || require('node-fetch');
  const sessions = new Map();
  let nextId = 1;

  function placesFor(guest) {
    return listPlaces(deps.agents(), deps.templateOf, deps.targetOf, guest.id);
  }

  async function post(place, guest, message, session, timeout) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      // Who is asking, for a place that keeps things apart per guest. The
      // reception is the only one holding the place's token, so the place can
      // take its word for it.
      'X-Hotel-Guest': guest.name,
      ...place.headers
    };
    if (session && session.id) headers['Mcp-Session-Id'] = session.id;
    if (session && session.version) headers['MCP-Protocol-Version'] = session.version;
    const res = await fetch(place.url, { method: 'POST', headers, body: JSON.stringify(message), timeout, size: MAX_REPLY });
    const text = await res.text();
    return {
      status: res.status,
      sessionId: res.headers.get('mcp-session-id'),
      message: 'id' in message ? parseReply(text, res.headers.get('content-type'), message.id) : null
    };
  }

  function refusal(place, status) {
    if (status === 401 || status === 403) {
      return new Error(`${place.id} refused the hotel's own key (${status}). This is the hotel's to fix, not yours: tell the operator`);
    }
    return new Error(`${place.id} answered ${status} with nothing the reception could read`);
  }

  // One handshake per guest and place, so a place that keeps a session keeps
  // one per guest and never mixes two guests' work.
  async function open(place, guest) {
    const key = `${place.agentId}|${guest.id}`;
    const now = Date.now();
    for (const [k, s] of sessions) if (now - s.at > SESSION_TTL) sessions.delete(k);
    const hit = sessions.get(key);
    if (hit && hit.url === place.url) return hit;

    const id = nextId++;
    const reply = await post(place, guest, {
      jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'agenthotel-reception', version: '1' } }
    }, null, LIST_TIMEOUT);
    if (!reply.message || reply.message.error) throw refusal(place, reply.status);
    const result = reply.message.result || {};
    const session = {
      id: reply.sessionId || null,
      version: typeof result.protocolVersion === 'string' ? result.protocolVersion : null,
      instructions: typeof result.instructions === 'string' ? result.instructions.trim() : '',
      url: place.url,
      at: now
    };
    // A notification; a place that answers it with an error is still open.
    await post(place, guest, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, LIST_TIMEOUT).catch(() => {});
    sessions.set(key, session);
    return session;
  }

  async function call(place, guest, method, params, timeout) {
    const key = `${place.agentId}|${guest.id}`;
    let session = await open(place, guest);
    const send = () => post(place, guest, { jsonrpc: '2.0', id: nextId++, method, params }, session, timeout);
    let reply = await send();
    // A place that was restarted has forgotten the session it gave out.
    if (!reply.message && session.id && (reply.status === 404 || reply.status === 400)) {
      sessions.delete(key);
      session = await open(place, guest);
      reply = await send();
    }
    if (!reply.message) {
      sessions.delete(key);
      throw refusal(place, reply.status);
    }
    return { message: reply.message, session };
  }

  async function toolsOf(place, guest) {
    const { message, session } = await call(place, guest, 'tools/list', {}, LIST_TIMEOUT);
    if (message.error) throw new Error(`${place.id} could not list its tools: ${message.error.message || 'no reason given'}`);
    const tools = Array.isArray(message.result && message.result.tools) ? message.result.tools : [];
    return { tools, session };
  }

  function findPlace(guest, name) {
    const places = placesFor(guest);
    const place = places.find(p => p.id === name);
    if (place) return { place };
    const names = places.map(p => p.id);
    return {
      error: textResult({
        error: name ? `There is no place called "${name}"` : 'Say which place: the `place` argument is required',
        places: names,
        hint: names.length ? 'hotel_guide describes each of them' : 'No places are open to you right now'
      }, true)
    };
  }

  function hotelGuide(guest) {
    const places = placesFor(guest).map(p => {
      const entry = { place: p.id, kind: p.kind, about: p.about };
      if (p.address) entry.address = p.address;
      return entry;
    });
    return textResult({
      hotel: (deps.hotelName && deps.hotelName()) || 'AgentHotel',
      you: guest.name,
      places,
      how: places.length
        ? [
          'place_tools(place) gives a place\'s own instructions and its tools.',
          'place_tools(place, tool) gives one tool\'s full schema.',
          'use_place(place, tool, arguments) calls it. You need no address or key: the reception holds them.',
          'A place\'s `address` is where people see the result in a browser, not something you need to call.'
        ]
        : ['No places are open to you right now. The operator opens them; ask again later.']
    });
  }

  async function placeTools(guest, args) {
    const { place, error } = findPlace(guest, args.place);
    if (error) return error;
    let listed;
    try {
      listed = await toolsOf(place, guest);
    } catch (err) {
      return textResult({ error: `Could not reach ${place.id}: ${err.message}` }, true);
    }
    const { tools, session } = listed;
    if (args.tool) {
      const tool = tools.find(t => t.name === args.tool);
      if (!tool) return textResult({ error: `${place.id} has no tool "${args.tool}"`, tools: tools.map(t => t.name) }, true);
      return textResult({ place: place.id, tool: { name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema || { type: 'object', properties: {} } } });
    }
    const out = { place: place.id, kind: place.kind };
    if (session.instructions) out.instructions = session.instructions;
    out.tools = tools.map(t => ({ name: t.name, description: firstLine(t.description) }));
    out.next = 'place_tools(place, tool) for one tool\'s schema, then use_place(place, tool, arguments)';
    return textResult(out);
  }

  async function usePlace(guest, args) {
    const { place, error } = findPlace(guest, args.place);
    if (error) return error;
    const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (!tool) return textResult({ error: 'Say which tool: the `tool` argument is required', hint: `place_tools("${place.id}") lists them` }, true);

    // Models hand over arguments as a JSON string often enough that refusing
    // it would only cost a round trip to say what was plainly meant.
    let input = args.arguments;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { input = null; }
    }
    if (input === undefined || input === null || input === '') input = {};
    if (typeof input !== 'object' || Array.isArray(input)) {
      return textResult({ error: '`arguments` must be an object: the tool\'s own arguments, by name' }, true);
    }

    const started = Date.now();
    let result;
    try {
      const { message } = await call(place, guest, 'tools/call', { name: tool, arguments: input }, CALL_TIMEOUT);
      if (message.error) {
        result = textResult({ error: message.error.message || `${place.id} refused the call`, code: message.error.code }, true);
      } else {
        result = message.result && Array.isArray(message.result.content)
          ? message.result
          : textResult(message.result === undefined ? null : message.result);
      }
    } catch (err) {
      result = textResult({ error: `Could not reach ${place.id}: ${err.message}` }, true);
    }
    const ok = !result.isError;

    // Who used what, and how it went. Never the arguments or the answer: they
    // are the guest's work, and can hold whatever the guest was given.
    if (deps.logUse) {
      try { deps.logUse({ guest, place: place.id, tool, ok, ms: Date.now() - started }); } catch (e) { /* the call still counts */ }
    }

    if (!ok) {
      // The schema, with the error: the next attempt can be the right one.
      try {
        const { tools } = await toolsOf(place, guest);
        const known = tools.find(t => t.name === tool);
        const hint = known
          ? { hint: `What ${tool} takes`, inputSchema: known.inputSchema || { type: 'object', properties: {} } }
          : { hint: `${place.id} has no tool "${tool}"`, tools: tools.map(t => t.name) };
        result = { ...result, content: [...(result.content || []), { type: 'text', text: JSON.stringify(hint, null, 2) }] };
      } catch (e) { /* the error stands on its own */ }
    }
    return result;
  }

  async function callTool(guest, name, args) {
    switch (name) {
      case 'hotel_guide': return hotelGuide(guest);
      case 'place_tools': return placeTools(guest, args);
      case 'use_place': return usePlace(guest, args);
      default:
        return textResult({ error: `The reception has no tool "${name}"`, tools: TOOLS.map(t => t.name) }, true);
    }
  }

  // One JSON-RPC message from a guest. Returns the reply, or null for a
  // notification, which gets none.
  async function respond(guest, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'One JSON-RPC request per call' } };
    }
    const { id, method, params } = message;
    if (id === undefined || id === null) return null;
    try {
      switch (method) {
        case 'initialize': {
          const asked = params && params.protocolVersion;
          return {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
              capabilities: { tools: {} },
              serverInfo: { name: 'agenthotel-reception', version: '1.0.0' },
              instructions: INSTRUCTIONS
            }
          };
        }
        // Hermes pings to see whether a server is still there. Lobby had no
        // answer and was called "method not found" once a minute.
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        case 'tools/call': {
          const name = params && params.name;
          const args = (params && params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
          return { jsonrpc: '2.0', id, result: await callTool(guest, name, args) };
        }
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: err.message } };
    }
  }

  function send(res, status, body, headers = {}) {
    const text = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, text ? { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } : headers);
    res.end(text);
  }

  function rpcError(message) {
    return { jsonrpc: '2.0', id: null, error: { code: -32000, message } };
  }

  // The whole listener. It has a server of its own (see server.js): the panel's
  // API stays off the network guests share, and this is the one door on it.
  function handle(req, res) {
    const pathname = String(req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
    if (pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (pathname !== '/reception') return send(res, 404, { error: 'Not found' });
    // No stream to open and no session to close: everything is one POST.
    if (req.method !== 'POST') return send(res, 405, rpcError('The reception takes POST only'), { Allow: 'POST' });
    if (!deps.enabled()) return send(res, 403, rpcError('The reception is closed: the operator has turned it off'));

    const auth = String(req.headers.authorization || '');
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const agentId = guestForKey(deps.keys(), key);
    const guest = agentId && deps.agents().find(a => a.id === agentId);
    if (!guest) return send(res, 401, rpcError('Unknown room key'), { 'WWW-Authenticate': 'Bearer' });

    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        send(res, 413, rpcError('Request too large'));
        return req.destroy();
      }
      chunks.push(chunk);
    });
    req.on('error', () => { done = true; });
    req.on('end', async () => {
      if (done) return;
      done = true;
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON' } });
      }
      const reply = await respond(guest, message);
      if (reply === null) return send(res, 202, null);
      send(res, 200, reply);
    });
  }

  return { handle, respond, placesFor };
}

module.exports = {
  createReception, createUseLog, listPlaces, guestForKey, parseReply, newRoomKey, tokenOf, firstLine,
  SERVER_NAME, TOOLS, INSTRUCTIONS
};
