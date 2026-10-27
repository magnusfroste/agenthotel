import { updateText } from '../lib/agentUpdates'

// A small marker beside an agent's name when a newer version is waiting
// (lib/agentUpdates.js). Nothing at all otherwise, so a fleet that is up to
// date looks exactly as it did.
export default function UpdateDot({ status }) {
  const text = updateText(status)
  if (!text) return null
  return <span className="update-dot" title={text} aria-label={text} role="img" />
}
