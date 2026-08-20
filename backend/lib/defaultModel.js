const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/agenthotel.db');

// Runtimes ship a hardcoded default model, which is a guess about someone
// else's provider account. OpenClaw defaults to openai/gpt-5.3 and Hermes to
// openai/gpt-5.4; on an account holding neither, a freshly created agent comes
// up healthy and then fails every turn with
// "model_not_found: The requested model does not exist".
//
// The panel already knows which models the operator configured per provider,
// so use the first one they listed. Their list, their order — an operator who
// wants a specific model either reorders it there or sets the field on the
// agent, which always wins over this.
function firstConfiguredModel(providerName) {
  try {
    const row = db.prepare('SELECT models FROM providers WHERE LOWER(name) = LOWER(?)').get(providerName);
    const list = JSON.parse((row && row.models) || '[]');
    return Array.isArray(list) && list.length && typeof list[0] === 'string' ? list[0] : null;
  } catch (_) {
    return null;
  }
}

module.exports = { firstConfiguredModel };
