const db = require('./database');

// Default severity scale
const DEFAULT_SEVERITY_SCALE = `P0: Urgent Risk. Reputation, security, or data integrity at risk.
P1: Critical Issue. Critical user journeys completely blocked.
P2: Major Issue. Critical user journeys broken but workarounds exist.
====NO-SHIP THRESHOLD====
P3: Significant Issue. Notable issues worth addressing soon.
P4: Minor Issue. Minor issues, edge cases, or nice-to-haves.`;

function getSeverityScale(repoId) {
  const result = db.db.prepare('SELECT * FROM severity_config WHERE repo_id = ?').get(repoId);

  if (!result) {
    // Return default scale if none configured
    return {
      scale_definition: DEFAULT_SEVERITY_SCALE,
      isDefault: true
    };
  }

  return {
    scale_definition: result.scale_definition,
    isDefault: false,
    updated_at: result.updated_at
  };
}

function setSeverityScale(repoId, scaleDefinition) {
  const now = Date.now();
  const stmt = db.db.prepare(`
    INSERT OR REPLACE INTO severity_config (repo_id, scale_definition, created_at, updated_at)
    VALUES (?, ?, COALESCE((SELECT created_at FROM severity_config WHERE repo_id = ?), ?), ?)
  `);
  stmt.run(repoId, scaleDefinition, repoId, now, now);
}

function resetSeverityScale(repoId) {
  db.db.prepare('DELETE FROM severity_config WHERE repo_id = ?').run(repoId);
}

function parseSeverityLevels(scaleDefinition) {
  const lines = scaleDefinition.split('\n');
  const levels = [];

  for (const line of lines) {
    const match = line.match(/^(P\d+):\s*(.+)$/);
    if (match) {
      levels.push({
        level: match[1],
        description: match[2]
      });
    }
  }

  return levels;
}

module.exports = {
  DEFAULT_SEVERITY_SCALE,
  getSeverityScale,
  setSeverityScale,
  resetSeverityScale,
  parseSeverityLevels
};
