const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'sitrep.db'));

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Initialize database schema
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      last_synced INTEGER,
      etag TEXT,
      UNIQUE(owner, name)
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      labels TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      author TEXT,
      body TEXT,
      comments_count INTEGER DEFAULT 0,
      is_bug INTEGER DEFAULT 0,
      is_stale INTEGER DEFAULT 0,
      html_url TEXT,
      FOREIGN KEY (repo_id) REFERENCES repos(id),
      UNIQUE(repo_id, number)
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      summary_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id),
      UNIQUE(issue_id, summary_type)
    );

    CREATE TABLE IF NOT EXISTS cached_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      report_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (repo_id) REFERENCES repos(id),
      UNIQUE(repo_id, report_type)
    );

    CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);
    CREATE INDEX IF NOT EXISTS idx_issues_is_bug ON issues(is_bug);
    CREATE INDEX IF NOT EXISTS idx_issues_is_stale ON issues(is_stale);
    CREATE INDEX IF NOT EXISTS idx_issues_updated_at ON issues(updated_at);
    CREATE INDEX IF NOT EXISTS idx_issues_created_at ON issues(created_at);
  `);
}

// Repository operations
function saveRepo(owner, name) {
  const stmt = db.prepare('INSERT OR REPLACE INTO repos (owner, name) VALUES (?, ?)');
  const result = stmt.run(owner, name);
  return db.prepare('SELECT * FROM repos WHERE owner = ? AND name = ?').get(owner, name);
}

function getRepo(owner, name) {
  return db.prepare('SELECT * FROM repos WHERE owner = ? AND name = ?').get(owner, name);
}

function updateRepoSync(repoId, etag) {
  const stmt = db.prepare('UPDATE repos SET last_synced = ?, etag = ? WHERE id = ?');
  stmt.run(Date.now(), etag, repoId);
}

// Issue operations
function saveIssue(repoId, issue) {
  const isBug = detectBug(issue);
  const isStale = detectStale(issue);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO issues
    (id, repo_id, number, title, state, labels, created_at, updated_at, author, body, comments_count, is_bug, is_stale, html_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    issue.id,
    repoId,
    issue.number,
    issue.title,
    issue.state,
    JSON.stringify(issue.labels.map(l => l.name)),
    new Date(issue.created_at).getTime(),
    new Date(issue.updated_at).getTime(),
    issue.user.login,
    issue.body || '',
    issue.comments,
    isBug ? 1 : 0,
    isStale ? 1 : 0,
    issue.html_url
  );
}

function detectBug(issue) {
  const labels = issue.labels.map(l => l.name.toLowerCase());
  const titleLower = issue.title.toLowerCase();

  return labels.some(l => l.includes('bug') || l.includes('error') || l.includes('fix')) ||
         titleLower.includes('bug') ||
         titleLower.includes('error') ||
         titleLower.includes('crash');
}

function detectStale(issue) {
  const daysSinceUpdate = (Date.now() - new Date(issue.updated_at).getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceUpdate > 90 && issue.state === 'open';
}

function getIssues(repoId, filters = {}) {
  let query = 'SELECT * FROM issues WHERE repo_id = ?';
  const params = [repoId];

  if (filters.state) {
    query += ' AND state = ?';
    params.push(filters.state);
  }

  if (filters.is_bug !== undefined) {
    query += ' AND is_bug = ?';
    params.push(filters.is_bug ? 1 : 0);
  }

  if (filters.is_stale !== undefined) {
    query += ' AND is_stale = ?';
    params.push(filters.is_stale ? 1 : 0);
  }

  if (filters.limit) {
    query += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(filters.limit);
  } else {
    query += ' ORDER BY updated_at DESC';
  }

  return db.prepare(query).all(...params);
}

function getIssueCount(repoId, filters = {}) {
  let query = 'SELECT COUNT(*) as count FROM issues WHERE repo_id = ?';
  const params = [repoId];

  if (filters.state) {
    query += ' AND state = ?';
    params.push(filters.state);
  }

  if (filters.is_bug !== undefined) {
    query += ' AND is_bug = ?';
    params.push(filters.is_bug ? 1 : 0);
  }

  if (filters.is_stale !== undefined) {
    query += ' AND is_stale = ?';
    params.push(filters.is_stale ? 1 : 0);
  }

  return db.prepare(query).get(...params).count;
}

// Summary operations
function saveSummary(issueId, summaryType, content) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO summaries (issue_id, summary_type, content, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(issueId, summaryType, content, Date.now());
}

function getSummary(issueId, summaryType) {
  return db.prepare('SELECT * FROM summaries WHERE issue_id = ? AND summary_type = ?')
    .get(issueId, summaryType);
}

function getIssuesWithSummaries(repoId, filters = {}) {
  const issues = getIssues(repoId, filters);
  return issues.map(issue => {
    const summary = getSummary(issue.id, 'quick');
    return {
      ...issue,
      labels: JSON.parse(issue.labels),
      summary: summary ? summary.content : null
    };
  });
}

// Cached report operations
function saveCachedReport(repoId, reportType, content) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO cached_reports (repo_id, report_type, content, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(repoId, reportType, content, Date.now());
}

function getCachedReport(repoId, reportType) {
  const report = db.prepare('SELECT * FROM cached_reports WHERE repo_id = ? AND report_type = ?')
    .get(repoId, reportType);

  // Check if cache is older than 1 hour
  if (report && (Date.now() - report.created_at) > 3600000) {
    return null; // Invalidate old cache
  }

  return report;
}

module.exports = {
  db,
  initDatabase,
  saveRepo,
  getRepo,
  updateRepoSync,
  saveIssue,
  getIssues,
  getIssueCount,
  saveSummary,
  getSummary,
  getIssuesWithSummaries,
  saveCachedReport,
  getCachedReport
};
