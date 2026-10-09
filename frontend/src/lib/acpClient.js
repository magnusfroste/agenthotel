// The browser side of the Agent Client Protocol (https://agentclientprotocol.com):
// JSON-RPC 2.0 over a WebSocket that the panel bridges to the agent's
// `<agent> acp` process in its container (backend/lib/acpBridge.js).
//
// The client offers no filesystem and no terminal of its own: the agent works
// in its own container with its own tools, as it does when it runs on its own.
// What comes back to the browser is the conversation — message and thought
// chunks, tool calls, plans — and the agent's requests for permission.
//
// `socket` is anything WebSocket-shaped: send(string), close(), and the
// onmessage / onclose properties. Kept free of React and of the DOM so the
// same code can be exercised against a real agent from Node.

export const PROTOCOL_VERSION = 1

export class AcpClient {
  constructor(socket, { onUpdate, onPermission, onClose } = {}) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.onUpdate = onUpdate || (() => {})
    this.onPermission = onPermission || (async () => null)
    this.onClose = onClose || (() => {})
    this.agentInfo = null
    this.authMethods = []
    socket.onmessage = (event) => this._receive(event.data)
    socket.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('The connection to the agent closed'))
      this.pending.clear()
      this.onClose()
    }
  }

  _send(message) {
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this._send({ id, method, params })
      if (timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`${method} took longer than ${Math.round(timeoutMs / 1000)} s`))
        }, timeoutMs)
      }
    })
  }

  notify(method, params) {
    this._send({ method, params })
  }

  async _receive(raw) {
    let message
    try { message = JSON.parse(raw) } catch (_) { return }
    if (message.panel) return this._panelMessage(message.panel)

    // A response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)
      if (message.error) {
        const error = new Error(message.error.message || 'The agent returned an error')
        error.code = message.error.code
        error.data = message.error.data
        waiting.reject(error)
      } else {
        waiting.resolve(message.result)
      }
      return
    }

    // A notification from the agent: the conversation as it happens.
    if (message.id === undefined && message.method === 'session/update') {
      this.onUpdate(message.params?.update, message.params?.sessionId)
      return
    }

    // A request from the agent to us.
    if (message.id !== undefined && message.method) {
      if (message.method === 'session/request_permission') {
        let optionId = null
        try { optionId = await this.onPermission(message.params) } catch (_) { optionId = null }
        this._send({
          id: message.id,
          result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }
        })
        return
      }
      // fs/* and terminal/* are not offered in our capabilities; anything
      // else this client does not know.
      this._send({ id: message.id, error: { code: -32601, message: `Method not supported by the AgentHotel chat: ${message.method}` } })
    }
  }

  _panelMessage(panel) {
    // The bridge's own notes, e.g. that the agent's process ended.
    if (panel.type === 'error' || panel.type === 'exit') {
      this.onUpdate({ sessionUpdate: 'panel_notice', level: panel.type, text: panel.message }, null)
    }
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agenthotel-chat', title: 'AgentHotel', version: '1' }
    }, { timeoutMs: 60000 })
    this.agentInfo = result?.agentInfo || null
    this.authMethods = result?.authMethods || []
    this.agentCapabilities = result?.agentCapabilities || {}
    return result
  }

  // A new conversation. An agent that wants to be told how it is authenticated
  // says so on session/new; the panel already gave it its keys, so the method
  // that uses what is configured is the one to pick.
  async newSession(cwd) {
    const params = { cwd, mcpServers: [] }
    try {
      return await this.request('session/new', params, { timeoutMs: 120000 })
    } catch (error) {
      const method = this.authMethods.find(m => m.type !== 'terminal') || null
      const needsAuth = error.code === -32000 || /auth/i.test(error.message || '')
      if (!needsAuth || !method) throw error
      await this.request('authenticate', { methodId: method.id }, { timeoutMs: 60000 })
      return await this.request('session/new', params, { timeoutMs: 120000 })
    }
  }

  prompt(sessionId, text) {
    return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  }

  cancel(sessionId) {
    this.notify('session/cancel', { sessionId })
  }

  close() {
    try { this.socket.close() } catch (_) {}
  }
}

// Folds a stream of session/update notifications into a list of chat entries:
// { kind: 'user' | 'agent' | 'thought' | 'tool' | 'plan' | 'notice', ... }.
// Consecutive chunks of the same kind are joined; tool calls are updated in
// place by id.
export function applyUpdate(entries, update) {
  if (!update) return entries
  const next = entries.slice()
  const last = next[next.length - 1]
  const textOf = (content) => {
    if (!content) return ''
    if (Array.isArray(content)) return content.map(textOf).join('')
    if (content.type === 'text') return content.text || ''
    if (content.type === 'content') return textOf(content.content)
    return ''
  }
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const kind = update.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought'
      const text = textOf(update.content)
      if (!text) return entries
      if (last && last.kind === kind && !last.closed) next[next.length - 1] = { ...last, text: last.text + text }
      else next.push({ kind, text })
      return next
    }
    case 'user_message_chunk': {
      const text = textOf(update.content)
      if (!text) return entries
      if (last && last.kind === 'user' && !last.closed) next[next.length - 1] = { ...last, text: last.text + text }
      else next.push({ kind: 'user', text })
      return next
    }
    case 'tool_call': {
      next.push({
        kind: 'tool', id: update.toolCallId, title: update.title || 'Tool',
        toolKind: update.kind || 'other', status: update.status || 'pending',
        detail: textOf(update.content)
      })
      return next
    }
    case 'tool_call_update': {
      const index = next.findIndex(e => e.kind === 'tool' && e.id === update.toolCallId)
      if (index < 0) return entries
      const current = next[index]
      next[index] = {
        ...current,
        status: update.status || current.status,
        title: update.title || current.title,
        detail: textOf(update.content) || current.detail
      }
      return next
    }
    case 'plan': {
      const plan = { kind: 'plan', items: (update.entries || []).map(e => ({ text: e.content, status: e.status })) }
      const index = next.findIndex(e => e.kind === 'plan' && !e.closed)
      if (index >= 0) next[index] = plan
      else next.push(plan)
      return next
    }
    case 'panel_notice':
      next.push({ kind: 'notice', level: update.level, text: update.text })
      return next
    default:
      return entries
  }
}
