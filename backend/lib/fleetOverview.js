// The numbers on the dashboard's home page that are about time rather than
// the moment: what happened per day this week, and how often each guest
// answered at its domain (2026-11-24). The event log and the uptime probes
// already held all of it; nothing showed it except one guest at a time.

// Which event types fall in which column. A redeploy is the hotel working;
// unhealthy, down and error are the guest failing; a model error is the
// guest running but unable to think.
const DAY_COLUMNS = {
  deploys: ['agent.create', 'agent.redeploy', 'agent.import', 'agent.restore'],
  incidents: ['agent.unhealthy', 'agent.down', 'agent.error'],
  modelErrors: ['agent.model_error']
};

// "2026-11-24" in UTC, the zone SQLite's CURRENT_TIMESTAMP is written in.
function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Rows of { day: 'YYYY-MM-DD', type, n } to one entry per day for the last
// `days` days, oldest first, with every day present: a quiet day is a zero,
// not a gap the chart closes over.
function byDay(rows, now = Date.now(), days = 7) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push({ day: dayKey(now - i * 24 * 3600 * 1000), deploys: 0, incidents: 0, modelErrors: 0 });
  }
  const index = Object.fromEntries(out.map((d, i) => [d.day, i]));
  for (const r of rows) {
    const i = index[r.day];
    if (i === undefined) continue;
    for (const [col, types] of Object.entries(DAY_COLUMNS)) {
      if (types.includes(r.type)) out[i][col] += Number(r.n) || 0;
    }
  }
  return out;
}

// Rows of { agent_id, total, ok } to { agentId: percent }, one decimal; a
// guest with no probes (no domain) is left out rather than shown as 0 %.
function uptimeByAgent(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.total) continue;
    out[r.agent_id] = Math.round(((r.ok || 0) / r.total) * 1000) / 10;
  }
  return out;
}

module.exports = { byDay, uptimeByAgent, dayKey, DAY_COLUMNS };
