const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// COMPOSE_PROJECT is interpolated into shell commands — restrict it to a safe
// character set to prevent shell injection.
function resolveProjectName(id, config) {
  const name = config?.COMPOSE_PROJECT || `agenthotel-${id}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid COMPOSE_PROJECT "${name}": only letters, digits, underscores and hyphens are allowed`);
  }
  return name;
}

module.exports = {
  name: 'Docker Compose',
  // The stack runs its own containers; the panel neither creates nor
  // inspects one container for this guest.
  composeManaged: true,
  description: 'Deploy from docker-compose.yml file',
  defaultImage: 'compose',
  // Hosts arbitrary images, so it is not handed provider credentials
  // unless the guest opts in with INJECT_PROVIDER_ENV.
  providerCredentials: 'optional',
  defaultPort: 80,
  configFields: [
    { key: 'COMPOSE_FILE', label: 'Docker Compose YAML', type: 'textarea', required: true, group: 'source' },
    { key: 'COMPOSE_ENV', label: 'Environment Variables', type: 'textarea', required: false },
    { key: 'COMPOSE_PROJECT', label: 'Project Name', type: 'text', required: true, group: 'source' },
    { key: 'INJECT_PROVIDER_ENV', label: 'Inject provider API keys (true/false)', type: 'text', required: false }
  ],

  buildConfig({ name, domain, image, port, config }) {
    return { ...config };
  },

  buildEnv(config) {
    return [];
  },

  async deploy(id, name, config, plugin) {
    const projectDir = `/data/compose/${id}`;
    const composePath = path.join(projectDir, 'docker-compose.yml');
    const envPath = path.join(projectDir, '.env');

    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }

    fs.writeFileSync(composePath, config.COMPOSE_FILE);

    if (config.COMPOSE_ENV) {
      // Read-only to the owner: this file is the stack's API keys and passwords,
      // and mode on writeFileSync applies only when the file is created — so it
      // is enforced on overwrite too.
      fs.writeFileSync(envPath, config.COMPOSE_ENV, { mode: 0o600 });
      fs.chmodSync(envPath, 0o600);
    }

    const projectName = resolveProjectName(id, config);

    try {
      // Try docker compose first, fallback to docker-compose
      try {
        execSync(`docker compose -p ${projectName} -f ${composePath} up -d`, {
          cwd: projectDir,
          stdio: 'pipe'
        });
      } catch (e) {
        // Fallback to docker-compose (standalone)
        execSync(`docker-compose -p ${projectName} -f ${composePath} up -d`, {
          cwd: projectDir,
          stdio: 'pipe'
        });
      }
      return { success: true };
    } catch (err) {
      throw new Error(`Compose deploy failed: ${err.stderr || err.message}`);
    }
  },

  async stop(id, config) {
    const projectDir = `/data/compose/${id}`;
    const composePath = path.join(projectDir, 'docker-compose.yml');
    let projectName;
    try {
      projectName = resolveProjectName(id, config);
    } catch (err) {
      return { success: false, error: err.message };
    }

    try {
      execSync(`docker compose -p ${projectName} -f ${composePath} down`, {
        cwd: projectDir,
        stdio: 'pipe'
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  async remove(id, config) {
    const projectDir = `/data/compose/${id}`;
    let projectName = null;
    try {
      projectName = resolveProjectName(id, config);
    } catch (err) {
      // Invalid project name — skip the compose teardown, still clean up files.
    }

    try {
      const composePath = path.join(projectDir, 'docker-compose.yml');
      if (projectName && fs.existsSync(composePath)) {
        execSync(`docker compose -p ${projectName} -f ${composePath} down --volumes --remove-orphans`, {
          cwd: projectDir,
          stdio: 'pipe'
        });
      }

      if (fs.existsSync(projectDir)) {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};
