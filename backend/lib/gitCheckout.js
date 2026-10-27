// Clone a repository for a guest, and keep it fresh on redeploy.
//
// Shared by Git App (which builds the checkout) and Git Compose (which runs a
// compose file from it). The validation matters more than it looks: the repo
// URL and ref reach git as arguments, and a value starting with "-" would be
// read as a flag instead — `--upload-pack=...` is a remote-code-execution
// classic.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// AGENTHOTEL_BUILD_ROOT is the older name and still honoured; tests set it.
const CHECKOUT_ROOT = process.env.AGENTHOTEL_CHECKOUT_ROOT || process.env.AGENTHOTEL_BUILD_ROOT || '/data/builds';

// Where a checkout must live when the Docker daemon will read it too.
//
// A build context is streamed to the daemon as a tar, so /data is fine for Git
// App. A compose file's bind mounts are not: the daemon resolves those paths on
// the host. This directory is mounted into the panel at the same path it has
// outside, so both see the same files.
const SHARED_ROOT = process.env.AGENTHOTEL_COMPOSE_ROOT || '/var/lib/agenthotel/checkouts';

// The repo URL and ref reach git as arguments, never a shell string, but a
// value starting with "-" would still be read as a flag (`--upload-pack=...`
// is a remote-code-execution classic). Reject those, and keep refs to the
// characters a branch, tag or sha can actually contain.
function assertSafeRepo(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('GIT_REPO is required');
  const repo = url.trim();
  if (repo.startsWith('-')) throw new Error('Invalid GIT_REPO');
  if (!/^(https?:\/\/|git@)/.test(repo)) {
    throw new Error('GIT_REPO must be an http(s) or git@ URL');
  }
  return repo;
}

function assertSafeRef(ref) {
  const value = (ref || 'main').trim();
  if (!/^[A-Za-z0-9._\/-]+$/.test(value) || value.startsWith('-')) {
    throw new Error(`Invalid GIT_REF "${value}"`);
  }
  return value;
}

// A subdirectory must stay inside the checkout — "../.." would hand the
// builder an arbitrary directory on the panel's filesystem.
function resolveContext(repoDir, subdir) {
  if (!subdir || !subdir.trim()) return repoDir;
  const resolved = path.resolve(repoDir, subdir.trim());
  if (resolved !== repoDir && !resolved.startsWith(repoDir + path.sep)) {
    throw new Error('GIT_SUBDIR must stay inside the repository');
  }
  return resolved;
}
// Put before every git command run in a checkout. After a fetch git may start
// `gc --auto` (`maintenance run --auto` since 2.46), detached by default, which
// then packs and prunes loose objects while the deploy goes on. A Git App
// build packing its context at that moment failed with ENOENT on a
// .git/objects file that was gone a minute later (agent-take, deployment 54,
// 2026-10-27). Not detaching runs the cleanup inside the git call, before the
// next step starts; it still runs, so the checkout cannot grow without bound.
const NO_DETACHED_GC = ['-c', 'gc.autoDetach=false', '-c', 'maintenance.autoDetach=false'];

// Clone if absent, otherwise fetch the ref and reset to it. Returns where the
// checkout lives and which commit it now holds.
function checkout(id, config, { root = CHECKOUT_ROOT } = {}) {
  const repo = assertSafeRepo(config.GIT_REPO);
  const ref = assertSafeRef(config.GIT_REF);
  const repoDir = path.join(root, id);
  const git = (args, cwd) => execFileSync('git', [...NO_DETACHED_GC, ...args], { cwd, stdio: 'pipe', timeout: 300000 });

  // One path for a first checkout and a redeploy alike. `clone --branch`
  // takes a branch or a tag but not a commit, so a guest pinned to a sha
  // could be redeployed but never deployed fresh: "Remote branch <sha> not
  // found" (review, 2026-09-30). init + fetch <ref> + reset accepts all three.
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });
    git(['init', '-q'], repoDir);
    git(['remote', 'add', 'origin', repo], repoDir);
  }
  // The hard reset and clean discard anything a previous run left in the tree.
  git(['remote', 'set-url', 'origin', repo], repoDir);
  git(['fetch', '--depth', '1', 'origin', ref], repoDir);
  git(['reset', '--hard', 'FETCH_HEAD'], repoDir);
  git(['clean', '-fd'], repoDir);


  let commit = null, subject = null, committedAt = null;
  try {
    [commit, subject, committedAt] = git(['log', '-1', '--format=%h%x00%s%x00%cI'], repoDir)
      .toString().trim().split('\0');
  } catch (e) { /* a checkout mid-clone has no HEAD yet */ }

  return { repoDir, dir: resolveContext(repoDir, config.GIT_SUBDIR), ref, repo, commit, subject, committedAt };
}

module.exports = { checkout, NO_DETACHED_GC, assertSafeRepo, assertSafeRef, resolveContext, CHECKOUT_ROOT, SHARED_ROOT };
