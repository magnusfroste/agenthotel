# Renders frontend/public/{favicon-32,apple-touch-icon,icon-192,icon-512,og}.png
# from the dashboard bot mark (Lucide "bot", same paths as favicon.svg).
# Needs Python Playwright with Chromium (the reel-studio image has both);
# writes to /tmp/icons — copy the PNGs into frontend/public/.
from playwright.sync_api import sync_playwright

BOT = '''<g fill="none" stroke="#ffffff" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round">
<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/>
<path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></g>'''

def mark(size, rounded, glyph_ratio, stroke=2.25):
    # Glyph spans 24 units; scale so it covers glyph_ratio of the tile.
    scale = size * glyph_ratio / 24
    off = (size - 24 * scale) / 2
    rx = size * 7 / 32 if rounded else 0
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
<rect width="{size}" height="{size}" rx="{rx}" fill="#141414"/>
<g transform="translate({off} {off}) scale({scale})">{BOT.format(w=stroke)}</g></svg>'''

OG = '''<html><head><link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&display=block" rel="stylesheet">
<style>
body{margin:0;width:1200px;height:630px;background:#0a0a0a;font-family:Inter,sans-serif;color:#fff;
 display:flex;align-items:center;padding:0 96px;box-sizing:border-box;gap:56px;
 background-image:radial-gradient(circle at 85% 20%, rgba(59,130,246,.18), transparent 45%)}
h1{font-size:92px;font-weight:700;margin:0;letter-spacing:-2px}
p{font-size:36px;font-weight:500;margin:18px 0 0;color:#a3a3a3;line-height:1.3}
.tile{flex-shrink:0;border-radius:52px;box-shadow:0 0 0 1px #262626}
</style></head><body>
<div class="tile">MARK</div>
<div><h1>AgentHotel</h1><p>Any agent, any model, always on<br>— on your own server.</p></div>
</body></html>'''

with sync_playwright() as p:
    b = p.chromium.launch()
    def shot(html, w, h, path, transparent=False):
        pg = b.new_page(viewport={'width': w, 'height': h})
        pg.set_content(html, wait_until='networkidle')
        pg.screenshot(path=path, omit_background=transparent)
        pg.close()
    body = '<body style="margin:0">{}</body>'
    # Browser tab fallback for browsers without SVG favicons: rounded, transparent corners.
    shot(body.format(mark(32, True, .75)), 32, 32, '/tmp/icons/favicon-32.png', True)
    # iOS rounds the corners itself and wants no transparency: full-bleed square.
    shot(body.format(mark(180, False, .62, 2.0)), 180, 180, '/tmp/icons/apple-touch-icon.png')
    # Android / PWA: full-bleed, glyph inside the maskable safe zone (centre 80%).
    shot(body.format(mark(192, False, .58, 2.0)), 192, 192, '/tmp/icons/icon-192.png')
    shot(body.format(mark(512, False, .58, 2.0)), 512, 512, '/tmp/icons/icon-512.png')
    shot(OG.replace('MARK', mark(260, True, .72, 2.0)), 1200, 630, '/tmp/icons/og.png')
    b.close()
