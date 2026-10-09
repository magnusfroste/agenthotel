// Light, dark, or whatever the operating system says.
//
// The choice is stored as 'light' | 'dark' | 'system' and resolved onto
// <html data-theme>, which index.css keys its colours on. 'system' follows
// prefers-color-scheme live, so a laptop switching to dark at sunset takes the
// panel with it. Applied from main.jsx before the first render, so the login
// page gets it too and nothing flashes the wrong colour.
//
// The old toggle stored a boolean under 'darkMode'; it is read once as the
// starting choice.

const KEY = 'theme'
const media = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

export function getThemeChoice() {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
    const legacy = localStorage.getItem('darkMode')
    if (legacy === 'false') return 'light'
    if (legacy === 'true') return 'dark'
  } catch (e) { /* storage blocked: fall through to the default */ }
  return 'dark'
}

function resolve(choice) {
  if (choice === 'system') return media && !media.matches ? 'light' : 'dark'
  return choice
}

export function applyTheme(choice = getThemeChoice()) {
  document.documentElement.setAttribute('data-theme', resolve(choice))
}

export function setThemeChoice(choice) {
  try { localStorage.setItem(KEY, choice) } catch (e) { /* not remembered, still applied */ }
  applyTheme(choice)
}

// Re-resolve when the OS flips, while 'system' is the choice.
if (media) {
  const follow = () => { if (getThemeChoice() === 'system') applyTheme('system') }
  if (media.addEventListener) media.addEventListener('change', follow)
  else if (media.addListener) media.addListener(follow)
}
