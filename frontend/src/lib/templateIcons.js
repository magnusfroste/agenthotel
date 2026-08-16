import { Bot, PawPrint, Layers, Container, Zap, Boxes, Server, Database } from 'lucide-react'

// meta.yaml carries an icon *name* so templates stay data — the mapping to a
// component lives here, shared by the library grid and the detail page.
const ICONS = {
  zap: Zap,
  paw: PawPrint,
  bot: Bot,
  container: Container,
  layers: Layers,
  boxes: Boxes,
  server: Server,
  database: Database
}

export function templateIcon(name) {
  return ICONS[name] || Container
}
