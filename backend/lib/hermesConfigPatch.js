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

function buildPatchScript(modelBlock, mcpBlock, terminalCwd) {
  const b64 = Buffer.from(modelBlock || '').toString('base64');
  const mcpB64 = Buffer.from(mcpBlock || '').toString('base64');
  const cwdB64 = Buffer.from(terminalCwd || '').toString('base64');
  return `
import base64, sys
path = sys.argv[1] if len(sys.argv) > 1 else '/opt/data/config.yaml'
mb = base64.b64decode('${b64}').decode()
mcp = base64.b64decode('${mcpB64}').decode()
with open(path) as f: lines = f.readlines()

def inside(line):
    return line.startswith(' ') or line.startswith('\\t') or line.startswith('- ')

def filler(line):
    return line.strip() == '' or line.lstrip().startswith('#')

# mcp_servers is replaced only when the panel has one to put there. Stripping it
# unconditionally would delete servers the operator added inside hermes, which
# the panel knows nothing about and could not put back.
drop = ['model:', 'custom_providers:'] + (['mcp_servers:'] if mcp else [])
out, i = [], 0
while i < len(lines):
    if any(lines[i].startswith(d) for d in drop):
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
        continue
    out.append(lines[i]); i += 1
out = mb.splitlines(True) + out if mb else out
out = mcp.splitlines(True) + out if mcp else out

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

module.exports = { buildPatchScript };
