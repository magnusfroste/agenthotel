// The Python that splices the panel's blocks into hermes's /opt/data/config.yaml.
//
// It runs inside the agent's container, so it is plain Python with no
// dependencies, and edits the file as text: hermes owns the file too, and a
// YAML round trip would reorder and reformat everything it wrote.
//
// A block the panel owns (model:, custom_providers:, and mcp_servers: when the
// panel has servers to write) is removed and written fresh. Removal used to
// stop at the first line that was not indented — and a comment is such a line.
// Hermes rewrites its own config with comment blocks in the middle of a
// section: after a redeploy it appended api_mode and models to the panel's
// custom_providers entry *below* the file's header comments. The next patch
// then removed the entry but left those indented lines behind, orphaned under
// the new block, and the file no longer parsed (caught in testing, 2026-10-07).
// Now comments and blank lines inside a block go with it; comments in front of
// the next top-level key stay, because they belong to that key.
//
// One entry is handled on its own: the reception (lib/reception.js), which
// every guest gets whether or not the panel has other servers for it. It is
// written into whatever mcp_servers: block is there, replacing only the entry
// of the same name, so the servers an operator added inside hermes stay. `hotel`
// is { name, entry, mark }: `entry` is the entry's text, or empty to take the
// entry out, which is done only when its body holds `mark` (the reception's
// address), so a server someone else gave that name is not removed by mistake.

function buildPatchScript(modelBlock, mcpBlock, terminalCwd, webappBlock, hotel) {
  // Goes into the script as it is, so it is held to what a server name can be.
  const hotelName = hotel && /^[A-Za-z0-9_-]+$/.test(hotel.name || '') ? hotel.name : '';
  const hotelB64 = Buffer.from((hotel && hotel.entry) || '').toString('base64');
  const hotelMarkB64 = Buffer.from((hotel && hotel.mark) || '').toString('base64');
  const b64 = Buffer.from(modelBlock || '').toString('base64');
  const mcpB64 = Buffer.from(mcpBlock || '').toString('base64');
  const cwdB64 = Buffer.from(terminalCwd || '').toString('base64');
  const webappB64 = Buffer.from(webappBlock || '').toString('base64');
  return `
import base64, sys
path = sys.argv[1] if len(sys.argv) > 1 else '/opt/data/config.yaml'
mb = base64.b64decode('${b64}').decode()
mcp = base64.b64decode('${mcpB64}').decode()
webapp = base64.b64decode('${webappB64}').decode()
with open(path) as f: lines = f.readlines()

def inside(line):
    return line.startswith(' ') or line.startswith('\\t') or line.startswith('- ')

def filler(line):
    return line.strip() == '' or line.lstrip().startswith('#')

# Where the block whose key is on line i ends: the first line after it that is
# not part of it. Comments and blank lines in the middle belong to the block.
def block_end(lines, i):
    i += 1
    while i < len(lines):
        if inside(lines[i]):
            i += 1
            continue
        if filler(lines[i]):
            j = i
            while j < len(lines) and filler(lines[j]): j += 1
            if j < len(lines) and inside(lines[j]):
                i = j
                continue
        break
    return i

# mcp_servers is replaced only when the panel has one to put there. Stripping it
# unconditionally would delete servers the operator added inside hermes, which
# the panel knows nothing about and could not put back.
# The same goes for the model: a patch that brings no model block (none does
# today, a deploy always has one) must not leave the guest without a model.
drop = (['model:', 'custom_providers:'] if mb else []) + (['mcp_servers:'] if mcp else []) + (['webapp:'] if webapp else [])
out, i = [], 0
while i < len(lines):
    if any(lines[i].startswith(d) for d in drop):
        i = block_end(lines, i)
        continue
    out.append(lines[i]); i += 1
out = mb.splitlines(True) + out if mb else out
out = mcp.splitlines(True) + out if mcp else out
out = webapp.splitlines(True) + out if webapp else out

# The reception's entry, into the block as it now stands.
hotel_name = '${hotelName}'
hotel = base64.b64decode('${hotelB64}').decode()
hotel_mark = base64.b64decode('${hotelMarkB64}').decode()

def indent_of(line):
    return len(line) - len(line.lstrip(' '))

def place_hotel(out):
    start = next((n for n, l in enumerate(out) if l.startswith('mcp_servers:')), None)
    if start is None:
        return (['mcp_servers:\\n'] + hotel.splitlines(True) + out) if hotel else out
    value = out[start][len('mcp_servers:'):].split('#')[0].strip()
    if value in ('{}', 'null', '~'):
        out[start] = 'mcp_servers:\\n'
    elif value:
        # Written on one line by hand. Not ours to take apart.
        print('mcp_servers is written inline; the %s entry was left as it is' % hotel_name)
        return out
    end = block_end(out, start)
    body = out[start + 1:end]
    entries = [l for l in body if not filler(l)]
    step = indent_of(entries[0]) if entries else 2
    # The entry of this name, if there is one: its key and everything deeper.
    a = next((n for n, l in enumerate(body) if not filler(l) and indent_of(l) == step and l.strip().split('#')[0].strip() == hotel_name + ':'), None)
    if a is not None:
        b = a + 1
        while b < len(body) and (filler(body[b]) or indent_of(body[b]) > step): b += 1
        while b > a + 1 and filler(body[b - 1]): b -= 1
        if hotel or (hotel_mark and hotel_mark in ''.join(body[a:b])):
            body = body[:a] + body[b:]
    if hotel:
        pad = ' ' * (step - 2) if step > 2 else ''
        body = [pad + l for l in hotel.splitlines(True)] + body
    if not any(not filler(l) for l in body):
        # Nothing left in it. No key at all is how hermes ships the file.
        return out[:start] + out[end:]
    return out[:start + 1] + body + out[end:]

if hotel_name and (hotel or hotel_mark):
    out = place_hotel(out)

# terminal.cwd is edited in place: replace the cwd line inside the existing
# terminal: block, or add one if the block has none. Rewriting the whole block
# would drop backend and timeout, which are set there too.
cwd = base64.b64decode('${cwdB64}').decode()
if cwd:
    res, i, done = [], 0, False
    while i < len(out):
        res.append(out[i])
        if out[i].startswith('terminal:') and not done:
            i += 1
            wrote = False
            while i < len(out) and out[i].startswith('  '):
                if out[i].lstrip().startswith('cwd:'):
                    res.append('  cwd: %s\\n' % cwd); wrote = True
                else:
                    res.append(out[i])
                i += 1
            if not wrote:
                res.append('  cwd: %s\\n' % cwd)
            done = True
            continue
        i += 1
    out = res

open(path, 'w').write(''.join(out))
`;
}

// Restart the gateway so it reads the patched file. Hermes v0.23 supervises it
// as a service of its own. The old command, `kill -HUP $(pgrep -f "hermes
// gateway run")`, stopped working without a sound: the gateway's command line is
// `python … main()) gateway run --replace`, so the pattern matched only the sh
// running it, which then signalled itself (found in testing, 2026-11-09). The
// bracket keeps the fallback for older images from matching its own shell.
// gateway-default reads /opt/data even when a profile is active: Hermes ignores
// active_profile for a gateway under s6. Until the service exists the gateway
// has not started, and it reads the patched file when it does.
function gatewayRestartCommand() {
  return 'if [ -d /run/hermes-service/gateway-default ]; then '
    + '/package/admin/s6/command/s6-svc -r /run/hermes-service/gateway-default; '
    + 'else kill -HUP $(pgrep -f "[h]ermes gateway run" | head -1) 2>/dev/null; fi; sleep 1';
}

module.exports = { buildPatchScript, gatewayRestartCommand };
