require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./database');
const githubSync = require('./github-sync');
const aiService = require('./ai-service');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Initialize database
db.initDatabase();

// Track sync jobs
const syncJobs = new Map();

// API Routes

// Get repository info (validate it exists on GitHub)
app.get('/api/repo/:owner/:name', async (req, res) => {
  try {
    const { owner, name } = req.params;
    const info = await githubSync.getRepoInfo(owner, name);

    if (!info.success) {
      // Return appropriate status code and include isRateLimit flag
      const statusCode = info.isRateLimit ? 429 : 404;
      return res.status(statusCode).json({
        error: info.error,
        isRateLimit: info.isRateLimit || false
      });
    }

    // Check if we have local data
    const localRepo = db.getRepo(owner, name);
    const hasLocalData = localRepo && localRepo.last_synced;

    res.json({
      ...info.data,
      hasLocalData,
      lastSynced: localRepo?.last_synced
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sync repository (fetch all issues)
app.post('/api/sync', async (req, res) => {
  try {
    const { owner, name } = req.body;

    if (!owner || !name) {
      return res.status(400).json({ error: 'Owner and name are required' });
    }

    const jobId = `${owner}/${name}`;

    // Check if already syncing
    if (syncJobs.has(jobId)) {
      return res.json({ message: 'Sync already in progress', jobId });
    }

    // Start sync in background
    syncJobs.set(jobId, {
      status: 'fetching',
      stage: 'Fetching issues from GitHub',
      progress: { current: 0, total: 0 },
      percentage: 0
    });

    res.json({ message: 'Sync started', jobId });

    // Perform sync (includes fetching comments for open issues)
    const result = await githubSync.syncRepository(owner, name, (progress) => {
      const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
      syncJobs.set(jobId, {
        status: 'fetching',
        stage: `Fetching issues and comments (${progress.current}/${progress.total})`,
        progress,
        percentage
      });
    });

    // Generate summaries for open issues only
    const totalOpenIssues = result.openIssuesCount;
    syncJobs.set(jobId, {
      status: 'summarizing',
      stage: `Generating AI summaries for open issues (0/${totalOpenIssues})`,
      progress: { current: 0, total: totalOpenIssues },
      percentage: 0
    });

    await aiService.generateMissingSummaries(result.repo.id, (progress) => {
      const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
      syncJobs.set(jobId, {
        status: 'summarizing',
        stage: `Generating AI summaries for open issues (${progress.current}/${progress.total})`,
        progress,
        percentage
      });
    });

    // Generate starter reports
    syncJobs.set(jobId, {
      status: 'generating-reports',
      stage: 'Generating starter reports (1/3)',
      progress: { current: 1, total: 3 },
      percentage: 33
    });
    await aiService.generateAllStarterReports(result.repo.id, (progress) => {
      const percentage = Math.round((progress.current / progress.total) * 100);
      syncJobs.set(jobId, {
        status: 'generating-reports',
        stage: `Generating starter reports (${progress.current}/${progress.total})`,
        progress,
        percentage
      });
    });

    // Complete
    syncJobs.set(jobId, {
      status: 'complete',
      issuesCount: result.issuesCount,
      completedAt: Date.now()
    });

    // Clean up after 5 minutes
    setTimeout(() => syncJobs.delete(jobId), 300000);

  } catch (error) {
    const jobId = `${req.body.owner}/${req.body.name}`;
    syncJobs.set(jobId, {
      status: 'error',
      error: error.message,
      isRateLimit: error.isRateLimit || false
    });
    console.error('Sync error:', error);
  }
});

// Check sync status
app.get('/api/sync/:owner/:name', (req, res) => {
  const jobId = `${req.params.owner}/${req.params.name}`;
  const job = syncJobs.get(jobId);

  if (!job) {
    return res.json({ status: 'not-found' });
  }

  res.json(job);
});

// Get starter report (cached)
app.get('/api/report/:owner/:name/:type', async (req, res) => {
  try {
    const { owner, name, type } = req.params;
    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not synced yet' });
    }

    // Check cache
    let report = db.getCachedReport(repo.id, type);

    if (!report) {
      // Generate on-demand if not cached
      const content = await aiService.generateStarterReport(repo.id, type);
      db.saveCachedReport(repo.id, type, content);
      report = { content };
    }

    res.json({ content: report.content });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ask a question (uses Opus)
app.post('/api/ask', async (req, res) => {
  try {
    const { owner, name, question } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not synced yet' });
    }

    const answer = await aiService.answerQuestion(repo.id, question);

    res.json({ answer });
  } catch (error) {
    console.error('Ask error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get repository stats
app.get('/api/stats/:owner/:name', (req, res) => {
  try {
    const { owner, name } = req.params;
    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not synced yet' });
    }

    const stats = {
      total: db.getIssueCount(repo.id),
      open: db.getIssueCount(repo.id, { state: 'open' }),
      closed: db.getIssueCount(repo.id, { state: 'closed' }),
      bugs: db.getIssueCount(repo.id, { is_bug: true, state: 'open' }),
      stale: db.getIssueCount(repo.id, { is_stale: true })
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasGitHubToken = !!process.env.GITHUB_TOKEN;

  res.json({
    status: 'ok',
    anthropicConfigured: hasAnthropicKey,
    githubConfigured: hasGitHubToken
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║             🚀 GitHub Sitrep is running!                 ║
║                                                           ║
║  Open: http://localhost:${PORT}                            ║
║                                                           ║
║  Anthropic API: ${process.env.ANTHROPIC_API_KEY ? '✓ Configured' : '✗ Not configured'}                  ║
║  GitHub Token:  ${process.env.GITHUB_TOKEN ? '✓ Configured' : '✗ Optional (rate limits)'}            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
