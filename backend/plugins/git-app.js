const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Where clones live. Inside the backend's own data volume, so a checkout
// survives a panel restart and a redeploy is a fetch rather than a fresh
// clone of the whole history.
const BUILD_ROOT = process.env.AGENTHOTEL_BUILD_ROOT || '/data/builds';

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

module.exports = {
  name: 'Git App',
  description: 'Build and run any Dockerised app straight from a Git repository',
  defaultImage: '',
  defaultPort: 8000,
  configFields: [
    { key: 'GIT_REPO', label: 'Repository URL', type: 'text', required: true },
    { key: 'GIT_REF', label: 'Branch, tag or commit', type: 'text', default: 'main' },
    { key: 'GIT_SUBDIR', label: 'Build context subdirectory', type: 'text', required: false },
    { key: 'PORT', label: 'Container Port', type: 'number', default: 8000 },
    { key: 'CUSTOM_ENV', label: 'Extra Env (KEY=VALUE per line)', type: 'textarea', required: false },
    { key: 'HEALTHCHECK_PATH', label: 'Health check path (e.g. /)', type: 'text', required: false }
  ],

  buildConfig({ config }) {
    return { ...config };
  },

  buildEnv(config) {
    const env = [];
    if (config.CUSTOM_ENV) {
      for (const line of config.CUSTOM_ENV.split('\n').map(l => l.trim()).filter(Boolean)) {
        env.push(line);
      }
    }
    // The rest of the config is environment as well — injected provider
    // credentials, and whatever set_agent_env hands the guest later.
    require('../lib/envPassthrough')
      .appendUnknownEnv(env, config, ['GIT_REPO', 'GIT_REF', 'GIT_SUBDIR', 'PORT']);
    return env;
  },

  // Called by deployAgent before the image build. Returns the directory to
  // build and the tag to build it as. The tag is per agent, not per runtime:
  // two Git App guests are two different repositories and cannot share an
  // image the way agents of one runtime share their template's.
  prepareBuild(id, config) {
    const repo = assertSafeRepo(config.GIT_REPO);
    const ref = assertSafeRef(config.GIT_REF);
    const repoDir = path.join(BUILD_ROOT, id);
    const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe', timeout: 300000 });

    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.mkdirSync(BUILD_ROOT, { recursive: true });
      git(['clone', '--depth', '1', '--branch', ref, '--', repo, repoDir]);
    } else {
      // Redeploy picks up new commits. Fetching the ref explicitly (rather
      // than pulling) keeps this working for a tag or a bare sha too, and
      // the hard reset discards anything a build left in the tree.
      git(['remote', 'set-url', 'origin', repo], repoDir);
      git(['fetch', '--depth', '1', 'origin', ref], repoDir);
      git(['reset', '--hard', 'FETCH_HEAD'], repoDir);
      git(['clean', '-fd'], repoDir);
    }

    const contextDir = resolveContext(repoDir, config.GIT_SUBDIR);
    if (!fs.existsSync(path.join(contextDir, 'Dockerfile'))) {
      throw new Error(`No Dockerfile in ${config.GIT_SUBDIR ? `${config.GIT_SUBDIR} of ` : ''}${repo} at ${ref}`);
    }

    const commit = git(['rev-parse', '--short', 'HEAD'], repoDir).toString().trim();
    return {
      contextDir,
      // The id already carries the runtime, so `agenthotel-${id}` reads as
      // agenthotel-git-app-<name>-<stamp> without repeating "git".
      imageTag: `agenthotel-${id}:latest`,
      // Always rebuild: a redeploy exists to pick up the repository's new
      // commits. Docker's layer cache makes this cheap when nothing changed.
      rebuild: true,
      commit
    };
  }
};
