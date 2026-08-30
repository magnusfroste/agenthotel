import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { authFetch, getToken } from '../lib/auth'
import { Bot, PawPrint, Landmark, Terminal, Zap, Rocket, PenTool, Plug, AlertTriangle } from 'lucide-react'

function Connect() {
  const [tools, setTools] = useState(null)
  const [mcpOn, setMcpOn] = useState(null)

  const [token, setToken] = useState('')
  const [panelDomain, setPanelDomain] = useState('')
  const [copied, setCopied] = useState('')

  useEffect(() => {
    fetchConfig()
  }, [])

  async function fetchConfig() {
    try {
      const settingsRes = await authFetch('/api/settings')
      const settings = await settingsRes.json()
      setPanelDomain(settings.panel_domain || window.location.hostname)
      
      const storedToken = getToken()
      if (storedToken) setToken(storedToken)
      // Ask the MCP endpoint what it serves rather than listing names by hand.
      // The hardcoded list had drifted to eight of eighteen tools, so the page
      // told operators the panel could do less than half of what it can — the
      // same second-source-of-truth problem as the schema blocks in meta.yaml.
      // Read the same flag that gates the endpoint, so this page cannot hand out
      // an endpoint and a token for something that will answer 403.
      authFetch('/api/system/mcp-status')
        .then(r => r.json())
        .then(st => {
          setMcpOn(Boolean(st.configured))
          if (st.configured && storedToken) fetchTools(storedToken)
          else setTools([])
        })
        .catch(() => { setMcpOn(false); setTools([]) })
    } catch (err) {
      console.error('Failed to fetch config:', err)
    }
  }

  function copyToClipboard(text, id) {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(''), 2000)
  }

  const mcpEndpoint = `https://${panelDomain}/mcp`

  const configs = {
    claude: {
      name: 'Claude Desktop',
      icon: Bot,
      description: 'Claude with MCP support via the desktop app',
      config: {
        mcpServers: {
          agenthotel: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-remote', mcpEndpoint],
            env: {
              MCP_REMOTE_TOKEN: token || '<YOUR_TOKEN>'
            }
          }
        }
      }
    },
    openclaw: {
      name: 'OpenClaw',
      icon: PawPrint,
      description: 'OpenClaw agent with MCP connection',
      config: {
        mcp: {
          servers: [
            {
              name: 'agenthotel',
              url: mcpEndpoint,
              auth: {
                type: 'bearer',
                token: token || '<YOUR_TOKEN>'
              }
            }
          ]
        }
      }
    },
    hermes: {
      name: 'Hermes',
      icon: Landmark,
      description: 'NousResearch Hermes with MCP tools',
      config: {
        mcp_servers: {
          agenthotel: {
            command: 'http',
            url: mcpEndpoint,
            headers: {
              Authorization: `Bearer ${token || '<YOUR_TOKEN>'}`
            }
          }
        }
      }
    },
    codex: {
      name: 'Codex',
      icon: Terminal,
      description: 'OpenAI Codex with MCP integration',
      config: {
        mcp: {
          servers: {
            agenthotel: {
              type: 'remote',
              url: mcpEndpoint,
              headers: {
                Authorization: `Bearer ${token || '<YOUR_TOKEN>'}`
              }
            }
          }
        }
      }
    },
    kilo: {
      name: 'Kilo',
      icon: Zap,
      description: 'Kilo CLI with MCP support',
      config: {
        mcp: {
          servers: [
            {
              name: 'agenthotel',
              type: 'remote',
              url: mcpEndpoint,
              headers: {
                Authorization: `Bearer ${token || '<YOUR_TOKEN>'}`
              }
            }
          ]
        }
      }
    },
    antigravity: {
      name: 'Antigravity',
      icon: Rocket,
      description: 'Antigravity agent with MCP connection',
      config: {
        mcp: {
          endpoints: [
            {
              name: 'agenthotel',
              url: mcpEndpoint,
              auth: {
                type: 'bearer',
                token: token || '<YOUR_TOKEN>'
              }
            }
          ]
        }
      }
    },
    cursor: {
      name: 'Cursor',
      icon: PenTool,
      description: 'Cursor IDE with MCP tools',
      config: {
        mcpServers: {
          agenthotel: {
            serverUrl: mcpEndpoint,
            headers: {
              Authorization: `Bearer ${token || '<YOUR_TOKEN>'}`
            }
          }
        }
      }
    }
  }

  async function fetchTools(bearer) {
    try {
      const res = await fetch('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      })
      const data = await res.json()
      // tools is an object keyed by name, not an array.
      const listed = (data && data.result && data.result.tools) || {}
      setTools(Object.entries(listed).map(([name, t]) => ({ name, description: t.description || '' })))
    } catch (err) {
      console.error('Failed to read MCP tools:', err)
      setTools([])
    }
  }

  if (mcpOn === false) {
    return (
      <div className="empty-state">
        <h2>MCP is turned off</h2>
        <p>
          The endpoint answers 403 while it is off, so there is nothing to connect to yet.
          Turn it on under <Link to="/system">System → MCP Server</Link>, then come back
          here for the configuration snippets.
        </p>
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>Connect Agents</h1>

      <div style={{
        background: 'var(--bg-secondary, #1e293b)',
        borderRadius: '0.5rem',
        padding: '1.5rem',
        marginBottom: '2rem'
      }}>
        <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plug size={20} color="white" />
          MCP Endpoint
        </h2>
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.5rem' }}>
            Endpoint URL
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: 'var(--bg-primary, #0f172a)',
            padding: '0.75rem',
            borderRadius: '0.25rem',
            fontFamily: 'monospace',
            fontSize: '0.875rem'
          }}>
            <span style={{ flex: 1 }}>{mcpEndpoint}</span>
            <button
              onClick={() => copyToClipboard(mcpEndpoint, 'endpoint')}
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.75rem', fontSize: '0.75rem' }}
            >
              {copied === 'endpoint' ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {token && (
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)', marginBottom: '0.5rem' }}>
              Auth Token
            </div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              background: 'var(--bg-primary, #0f172a)',
              padding: '0.75rem',
              borderRadius: '0.25rem',
              fontFamily: 'monospace',
              fontSize: '0.875rem'
            }}>
              <span style={{ flex: 1 }}>***{token.slice(-8)}</span>
              <button
                onClick={() => copyToClipboard(token, 'token')}
                className="btn btn-secondary"
                style={{ padding: '0.25rem 0.75rem', fontSize: '0.75rem' }}
              >
                {copied === 'token' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {!token && (
          <div style={{
            padding: '1rem',
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid #f59e0b',
            borderRadius: '0.25rem',
            color: '#f59e0b',
            fontSize: '0.875rem'
          }}>
            <AlertTriangle size={16} color="#f59e0b" /> Token not found. Please log in again or check your browser settings.
          </div>
        )}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
        gap: '1.5rem'
      }}>
        {Object.entries(configs).map(([key, config]) => {
          const Icon = config.icon
          return (
          <div
            key={key}
            style={{
              background: 'var(--bg-secondary, #1e293b)',
              borderRadius: '0.5rem',
              padding: '1.5rem',
              border: '1px solid var(--border, #334155)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '2rem', display: 'flex' }}><Icon size={32} /></span>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.125rem' }}>{config.name}</h3>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #94a3b8)' }}>
                  {config.description}
                </div>
              </div>
            </div>

            <div style={{
              background: 'var(--bg-primary, #0f172a)',
              borderRadius: '0.25rem',
              padding: '1rem',
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              overflow: 'auto',
              maxHeight: '300px',
              position: 'relative'
            }}>
              <button
                onClick={() => copyToClipboard(JSON.stringify(config.config, null, 2), key)}
                className="btn btn-secondary"
                style={{
                  position: 'absolute',
                  top: '0.5rem',
                  right: '0.5rem',
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.625rem'
                }}
              >
                {copied === key ? '✓' : 'Copy'}
              </button>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(config.config, null, 2)}
              </pre>
            </div>
          </div>
          )
        })}
      </div>

      <div style={{
        marginTop: '2rem',
        padding: '1.5rem',
        background: 'rgba(59, 130, 246, 0.1)',
        border: '1px solid #3b82f6',
        borderRadius: '0.5rem'
      }}>
        <h3 style={{ margin: '0 0 1rem 0', color: '#3b82f6' }}>Available MCP Tools</h3>
        <div style={{ fontSize: '0.875rem', lineHeight: '1.6' }}>
          {tools === null && <span style={{ color: 'var(--text-secondary)' }}>Loading…</span>}
          {tools && tools.length === 0 && (
            <span style={{ color: 'var(--text-secondary)' }}>
              Could not read the tool list — the MCP endpoint did not answer.
            </span>
          )}
          {tools && tools.map(t => (
            <div key={t.name} style={{ marginBottom: '0.35rem' }}>
              <strong>{t.name}</strong>
              {t.description ? <> — {t.description}</> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default Connect
