// Just enough Markdown for agent replies: paragraphs, headings, lists, code
// blocks, inline code, bold, italic and links. It builds React elements and
// never sets HTML, so nothing an agent writes can inject markup into the panel.
import { Fragment } from 'react'

function inline(text, keyBase) {
  const out = []
  // Order matters: code first, so ** inside backticks stays literal.
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)/g
  let last = 0
  let match
  let i = 0
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const key = `${keyBase}-${i++}`
    if (match[1]) out.push(<code key={key} className="md-code">{match[1].slice(1, -1)}</code>)
    else if (match[2]) out.push(<strong key={key}>{match[2].slice(2, -2)}</strong>)
    else if (match[3]) out.push(<em key={key}>{match[3].slice(1, -1)}</em>)
    else if (match[4]) {
      const label = match[4].slice(1, match[4].indexOf(']'))
      out.push(<a key={key} href={match[5]} target="_blank" rel="noopener noreferrer">{label}</a>)
    } else if (match[6]) out.push(<a key={key} href={match[6]} target="_blank" rel="noopener noreferrer">{match[6]}</a>)
    last = pattern.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function MiniMarkdown({ text }) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\S*)/)
    if (fence) {
      const code = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      i++
      blocks.push(<pre key={blocks.length} className="md-pre"><code>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/)
    if (heading) {
      blocks.push(<div key={blocks.length} className={`md-h md-h${heading[1].length}`}>{inline(heading[2], blocks.length)}</div>)
      i++
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
        i++
      }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={blocks.length} className="md-list">{items.map((item, n) => <li key={n}>{inline(item, `${blocks.length}-${n}`)}</li>)}</List>)
      continue
    }
    if (!line.trim()) { i++; continue }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++])
    blocks.push(
      <p key={blocks.length} className="md-p">
        {para.map((p, n) => <Fragment key={n}>{n > 0 && <br />}{inline(p, `${blocks.length}-${n}`)}</Fragment>)}
      </p>
    )
  }
  return <div className="md">{blocks}</div>
}
