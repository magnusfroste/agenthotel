import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { authFetch, getToken } from '../lib/auth'
import { AcpClient, applyUpdate } from '../lib/acpClient'
import MiniMarkdown from '../lib/miniMarkdown'
import {
  Send, Square, X, RotateCcw, Plus, Bot, Brain, Wrench, FileText, Search, Pencil, Terminal,
  Globe, CheckCircle2, XCircle, Loader2, ShieldQuestion, ListChecks, Columns2, Grid2x2, Square as Single, Radio
} from 'lucide-react'

// Chat with up to four agents at once, each in its own pane, over the Agent
// Client Protocol (lib/acpClient.js ↔ backend/lib/acpBridge.js). A pane is a
// live process in the agent's container for as long as it is open.

const LAYOUTS = [
  { panes: 1, label: 'One agent', Icon: Single },
  { panes: 2, label: 'Two side by side', Icon: Columns2 },
  { panes: 4, label: 'Four at once', Icon: Grid2x2 },
]

const remembered = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback } catch (_) { return fallback }
}
const remember = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch (_) {} }

const TOOL_ICON = { read: FileText, search: Search, edit: Pencil, execute: Terminal, fetch: Globe, think: Brain }

function ToolRow({ entry }) {
  const Icon = TOOL_ICON[entry.toolKind] || Wrench
  const state = entry.status === 'completed' ? 'done' : entry.status === 'failed' ? 'failed' : 'running'
  return (
    <details className={`chat-tool chat-tool-${state}`}>
      <summary>
        <Icon size={13} />
        <span className="chat-tool-title">{entry.title}</span>
        {state === 'running' && <Loader2 size={13} className="chat-spin" />}
        {state === 'done' && <CheckCircle2 size={13} />}
        {state === 'failed' && <XCircle size={13} />}
      </summary>
      {entry.detail && <pre className="chat-tool-detail">{entry.detail.slice(0, 4000)}</pre>}
    </details>
  )
}

function Entry({ entry }) {
  switch (entry.kind) {
    case 'user':
      return <div className="chat-msg chat-msg-user">{entry.text}</div>
    case 'agent':
      return <div className="chat-msg chat-msg-agent"><MiniMarkdown text={entry.text} /></div>
    case 'thought':
      return (
        <details className="chat-thought">
          <summary><Brain size={12} /> Thinking</summary>
          <div>{entry.text}</div>
        </details>
      )
    case 'tool':
      return <ToolRow entry={entry} />
    case 'plan':
      return (
        <div className="chat-plan">
          <div className="chat-plan-title"><ListChecks size={13} /> Plan</div>
          {entry.items.map((item, i) => (
            <div key={i} className={`chat-plan-item chat-plan-${item.status}`}>
              {item.status === 'completed' ? <CheckCircle2 size={12} /> : item.status === 'in_progress' ? <Loader2 size={12} className="chat-spin" /> : <span className="chat-plan-dot" />}
              {item.text}
            </div>
          ))}
        </div>
      )
    case 'notice':
      return <div className={`chat-notice chat-notice-${entry.level}`}>{entry.text}</div>
    default:
      return null
  }
}

function AgentPicker({ agents, taken, onPick }) {
  return (
    <div className="chat-picker">
      <div className="chat-picker-title"><Bot size={18} /> Pick an agent</div>
      {agents.length === 0 && (
        <div className="chat-picker-empty">
          None of your agents can chat here yet — Hermes and OpenClaw can. <Link to="/templates">Check one in</Link>
        </div>
      )}
      <div className="chat-picker-list">
        {agents.map(agent => (
          <button key={agent.id} type="button" className="chat-picker-agent" onClick={() => onPick(agent.id)}
            disabled={agent.status !== 'running'}>
            <span className={`chat-dot chat-dot-${agent.status === 'running' ? 'ok' : 'off'}`} />
            <span className="chat-picker-name">{agent.name}</span>
            <span className="chat-picker-runtime">{agent.runtime}</span>
            {taken.includes(agent.id) && <span className="chat-picker-open">open</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

function ChatPane({ paneKey, agent, cwd, onClose, registerSender, compact }) {
  const [status, setStatus] = useState('connecting') // connecting | ready | working | closed | error
  const [entries, setEntries] = useState([])
  const [input, setInput] = useState('')
  const [permission, setPermission] = useState(null)
  const [model, setModel] = useState('')
  const [attempt, setAttempt] = useState(0)
  const clientRef = useRef(null)
  const sessionRef = useRef(null)
  const scrollRef = useRef(null)
  const stickRef = useRef(true)

  // One connection per agent and attempt; "New chat" bumps the attempt.
  useEffect(() => {
    let cancelled = false
    setStatus('connecting')
    setEntries([])
    setPermission(null)
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${proto}//${window.location.host}/api/agents/${agent.id}/acp?token=${encodeURIComponent(getToken() || '')}`)
    const client = new AcpClient(socket, {
      onUpdate: (update) => { if (!cancelled) setEntries(prev => applyUpdate(prev, update)) },
      onPermission: (request) => new Promise(resolve => {
        if (cancelled) return resolve(null)
        setPermission({ request, resolve: (optionId) => { setPermission(null); resolve(optionId) } })
      }),
      onClose: () => { if (!cancelled) setStatus(s => (s === 'error' ? s : 'closed')) }
    })
    clientRef.current = client
    socket.onopen = async () => {
      try {
        await client.initialize()
        const session = await client.newSession(cwd || '/')
        if (cancelled) return
        sessionRef.current = session.sessionId
        setModel(session?.models?.currentModelId || '')
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        setEntries(prev => [...prev, { kind: 'notice', level: 'error', text: `Could not start the chat: ${err.message}` }])
        setStatus('error')
      }
    }
    socket.onerror = () => { if (!cancelled) setStatus('error') }
    return () => {
      cancelled = true
      client.close()
    }
  }, [agent.id, attempt])

  const send = useCallback(async (text) => {
    const message = (text ?? '').trim()
    const client = clientRef.current
    if (!message || !client || !sessionRef.current) return false
    stickRef.current = true
    setEntries(prev => [...prev.map(e => ({ ...e, closed: true })), { kind: 'user', text: message, closed: true }])
    setStatus('working')
    try {
      const result = await client.prompt(sessionRef.current, message)
      setEntries(prev => {
        const done = prev.map(e => ({ ...e, closed: true }))
        if (result?.stopReason && result.stopReason !== 'end_turn') {
          done.push({ kind: 'notice', level: 'info', text: result.stopReason === 'cancelled' ? 'Stopped.' : `Stopped: ${result.stopReason.replace(/_/g, ' ')}` })
        }
        return done
      })
      setStatus('ready')
    } catch (err) {
      setEntries(prev => [...prev, { kind: 'notice', level: 'error', text: err.message }])
      setStatus(clientRef.current ? 'ready' : 'error')
    }
    return true
  }, [])

  // Registered while the pane has a live session, with whether it can take a
  // message now — so "Send to all" counts the panes that are open, not just
  // the ones idle this second (it read "Send to all 0" while both answered).
  useEffect(() => registerSender(paneKey, (status === 'ready' || status === 'working') ? { send, ready: status === 'ready' } : null), [status, send, paneKey])
  useEffect(() => () => registerSender(paneKey, null), [paneKey])

  // Follow the conversation unless the reader has scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [entries, permission])

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  const submit = async (e) => {
    e?.preventDefault()
    if (status !== 'ready' || !input.trim()) return
    const text = input
    setInput('')
    await send(text)
  }

  const statusLabel = { connecting: 'Connecting…', ready: 'Ready', working: 'Working…', closed: 'Disconnected', error: 'Error' }[status]

  return (
    <section className={`chat-pane ${compact ? 'chat-pane-compact' : ''}`}>
      <header className="chat-pane-header">
        <span className={`chat-dot chat-dot-${status}`} title={statusLabel} />
        <Link to={`/agent/${agent.id}`} className="chat-pane-name">{agent.name}</Link>
        <span className="chat-pane-meta">{model || agent.runtime}</span>
        <span className="chat-pane-status">{statusLabel}</span>
        <span className="chat-pane-actions">
          <button type="button" title="New chat" aria-label="New chat" onClick={() => setAttempt(a => a + 1)}><RotateCcw size={14} /></button>
          <button type="button" title="Close" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </span>
      </header>

      <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
        {entries.length === 0 && status !== 'error' && (
          <div className="chat-empty">
            {status === 'connecting'
              ? <><Loader2 size={18} className="chat-spin" /> Starting a session with {agent.name}…</>
              : <>Ask {agent.name} anything. It works in its own container, with its own tools and model.</>}
          </div>
        )}
        {entries.map((entry, i) => <Entry key={i} entry={entry} />)}
        {status === 'working' && !entries.some(e => !e.closed && (e.kind === 'agent' || e.kind === 'tool')) && (
          <div className="chat-typing"><span /><span /><span /></div>
        )}
        {permission && (
          <div className="chat-permission">
            <div className="chat-permission-title"><ShieldQuestion size={15} /> {agent.name} asks for permission</div>
            <div className="chat-permission-what">{permission.request?.toolCall?.title || 'An action'}</div>
            <div className="chat-permission-options">
              {(permission.request?.options || []).map(option => (
                <button key={option.optionId} type="button"
                  className={`btn ${option.kind?.startsWith('allow') ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => permission.resolve(option.optionId)}>{option.name}</button>
              ))}
              <button type="button" className="btn btn-secondary" onClick={() => permission.resolve(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <form className="chat-input" onSubmit={submit}>
        <textarea
          value={input}
          rows={1}
          placeholder={status === 'ready' ? `Message ${agent.name}…` : statusLabel}
          disabled={status !== 'ready'}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
        />
        {status === 'working'
          ? <button type="button" className="chat-send chat-stop" title="Stop" aria-label="Stop"
              onClick={() => sessionRef.current && clientRef.current?.cancel(sessionRef.current)}><Square size={14} /></button>
          : <button type="submit" className="chat-send" title="Send" aria-label="Send" disabled={status !== 'ready' || !input.trim()}><Send size={15} /></button>}
      </form>
    </section>
  )
}

function Chat() {
  const [searchParams] = useSearchParams()
  const [agents, setAgents] = useState([])
  const [runtimes, setRuntimes] = useState({})
  const [layout, setLayout] = useState(() => remembered('chat.layout', 1))
  const [panes, setPanes] = useState(() => remembered('chat.panes', [null, null, null, null]))
  const [broadcast, setBroadcast] = useState('')
  const sendersRef = useRef({})
  const [paneCounts, setPaneCounts] = useState({ open: 0, ready: 0 })

  useEffect(() => {
    Promise.all([
      authFetch('/api/agents').then(r => r.json()),
      authFetch('/api/runtimes').then(r => r.json())
    ]).then(([agentList, runtimeList]) => {
      const byId = Object.fromEntries(runtimeList.map(r => [r.id, r]))
      setRuntimes(byId)
      setAgents(agentList.filter(a => byId[a.runtime]?.acp))
    }).catch(() => {})
  }, [])

  // ?agent=<id> opens that agent in the first free pane.
  useEffect(() => {
    const wanted = searchParams.get('agent')
    if (!wanted) return
    setPanes(prev => {
      if (prev.slice(0, layout).includes(wanted)) return prev
      const next = prev.slice()
      const free = next.slice(0, layout).indexOf(null)
      next[free >= 0 ? free : 0] = wanted
      return next
    })
  }, [searchParams])

  useEffect(() => remember('chat.layout', layout), [layout])
  useEffect(() => remember('chat.panes', panes), [panes])

  const registerSender = useCallback((paneKey, sender) => {
    if (sender) sendersRef.current[paneKey] = sender
    else delete sendersRef.current[paneKey]
    const all = Object.values(sendersRef.current)
    setPaneCounts({ open: all.length, ready: all.filter(p => p.ready).length })
  }, [])

  const visible = panes.slice(0, layout)
  const setPane = (index, agentId) => setPanes(prev => { const next = prev.slice(); next[index] = agentId; return next })

  const sendToAll = async (e) => {
    e?.preventDefault()
    const text = broadcast.trim()
    if (!text) return
    setBroadcast('')
    await Promise.all(Object.values(sendersRef.current).filter(p => p.ready).map(p => p.send(text)))
  }

  const agentById = Object.fromEntries(agents.map(a => [a.id, a]))

  return (
    <div className="chat-page">
      <div className="chat-header">
        <div>
          <h1 className="page-title">Chat</h1>
          <p className="page-subtitle">Talk to your agents — one at a time, or four at once on four models.</p>
        </div>
        <div className="chat-layouts" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map(({ panes: n, label, Icon }) => (
            <button key={n} type="button" role="radio" aria-checked={layout === n} title={label}
              className={layout === n ? 'active' : ''} onClick={() => setLayout(n)}>
              <Icon size={15} /> <span>{n}</span>
            </button>
          ))}
        </div>
      </div>

      {layout > 1 && (
        <form className="chat-broadcast" onSubmit={sendToAll}>
          <Radio size={16} />
          <input value={broadcast} onChange={e => setBroadcast(e.target.value)}
            placeholder={paneCounts.open > 1 ? 'Ask every open agent the same thing…' : 'Open two or more agents to ask them all at once'} />
          <button type="submit" className="btn btn-primary"
            disabled={paneCounts.open < 1 || paneCounts.ready < paneCounts.open || !broadcast.trim()}
            title={paneCounts.ready < paneCounts.open ? 'Waiting for every agent to finish' : undefined}>
            Send to {paneCounts.open === 1 ? '1 agent' : `all ${paneCounts.open}`}
          </button>
        </form>
      )}

      <div className={`chat-grid chat-grid-${layout}`}>
        {visible.map((agentId, index) => {
          const agent = agentId && agentById[agentId]
          return agent ? (
            <ChatPane key={`${index}-${agent.id}`} paneKey={`pane-${index}`} agent={agent} cwd={runtimes[agent.runtime]?.acp?.cwd}
              compact={layout === 4} registerSender={registerSender} onClose={() => setPane(index, null)} />
          ) : (
            <section key={`${index}-empty`} className="chat-pane chat-pane-empty">
              <AgentPicker agents={agents} taken={visible.filter(Boolean)} onPick={id => setPane(index, id)} />
            </section>
          )
        })}
      </div>
    </div>
  )
}

export default Chat
