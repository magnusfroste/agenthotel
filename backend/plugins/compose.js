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
  description: 'Deploy from docker-compose.yml file',
  defaultImage: 'compose',
  defaultPort: 80,
  configFields: [
    { key: 'COMPOSE_FILE', label: 'Docker Compose YAML', type: 'textarea', required: true },
    { key: 'COMPOSE_ENV', label: 'Environment Variables', type: 'textarea', required: false },
    { key: 'COMPOSE_PROJECT', label: 'Project Name', type: 'text', required: true }
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
      fs.writeFileSync(envPath, config.COMPOSE_ENV);
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
