require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./database');
const githubSync = require('./github-sync');
const aiService = require('./ai-service');
const severityConfig = require('./severity-config');
const authCheck = require('./github-auth-check');

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

      let stageMessage = '';
      if (progress.stage === 'issues') {
        stageMessage = `Fetching all issues (${progress.current} fetched)`;
      } else if (progress.stage === 'saving') {
        stageMessage = `Saving issues (${progress.current}/${progress.total})`;
      } else if (progress.stage === 'comments') {
        stageMessage = `Fetching comments (${progress.current}/${progress.total} open issues)`;
      }

      syncJobs.set(jobId, {
        status: 'fetching',
        stage: stageMessage,
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

// Refresh repository (incremental sync)
app.post('/api/refresh', async (req, res) => {
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

    // Start refresh in background
    syncJobs.set(jobId, {
      status: 'fetching',
      stage: 'Checking for updates',
      progress: { current: 0, total: 0 },
      percentage: 0
    });

    res.json({ message: 'Refresh started', jobId });

    // Perform refresh (incremental sync)
    const result = await githubSync.refreshRepository(owner, name, (progress) => {
      const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

      let stageMessage = '';
      if (progress.stage === 'issues') {
        stageMessage = `Checking for updates (${progress.current} found)`;
      } else if (progress.stage === 'saving') {
        stageMessage = `Saving updates (${progress.current}/${progress.total})`;
      } else if (progress.stage === 'comments') {
        stageMessage = `Updating comments (${progress.current}/${progress.total} open issues)`;
      }

      syncJobs.set(jobId, {
        status: 'fetching',
        stage: stageMessage,
        progress,
        percentage
      });
    });

    if (result.updatedIssuesCount === 0) {
      // No updates found
      syncJobs.set(jobId, {
        status: 'complete',
        issuesCount: 0,
        message: 'No updates found',
        completedAt: Date.now()
      });
    } else {
      // Generate summaries for updated open issues only
      const totalOpenIssues = result.openIssuesCount;

      if (totalOpenIssues > 0) {
        syncJobs.set(jobId, {
          status: 'summarizing',
          stage: `Generating AI summaries for updated issues (0/${totalOpenIssues})`,
          progress: { current: 0, total: totalOpenIssues },
          percentage: 0
        });

        await aiService.generateMissingSummaries(result.repo.id, (progress) => {
          const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
          syncJobs.set(jobId, {
            status: 'summarizing',
            stage: `Generating AI summaries for updated issues (${progress.current}/${progress.total})`,
            progress,
            percentage
          });
        });
      }

      // Regenerate starter reports
      syncJobs.set(jobId, {
        status: 'generating-reports',
        stage: 'Updating starter reports (1/3)',
        progress: { current: 1, total: 3 },
        percentage: 33
      });
      await aiService.generateAllStarterReports(result.repo.id, (progress) => {
        const percentage = Math.round((progress.current / progress.total) * 100);
        syncJobs.set(jobId, {
          status: 'generating-reports',
          stage: `Updating starter reports (${progress.current}/${progress.total})`,
          progress,
          percentage
        });
      });

      // Complete
      syncJobs.set(jobId, {
        status: 'complete',
        issuesCount: result.updatedIssuesCount,
        message: `Updated ${result.updatedIssuesCount} issue(s)`,
        completedAt: Date.now()
      });
    }

    // Clean up after 5 minutes
    setTimeout(() => syncJobs.delete(jobId), 300000);

  } catch (error) {
    const jobId = `${req.body.owner}/${req.body.name}`;
    syncJobs.set(jobId, {
      status: 'error',
      error: error.message,
      isRateLimit: error.isRateLimit || false
    });
    console.error('Refresh error:', error);
  }
});

// Refresh cache - regenerate all summaries
app.post('/api/refresh-cache', async (req, res) => {
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

    // Get repo
    const repo = db.getRepo(owner, name);
    if (!repo) {
      return res.status(404).json({ error: 'Repository not found. Please sync it first.' });
    }

    // Start cache refresh in background
    syncJobs.set(jobId, {
      status: 'summarizing',
      stage: 'Clearing old summaries...',
      progress: { current: 0, total: 0 },
      percentage: 0
    });

    res.json({ message: 'Cache refresh started', jobId });

    // Clear all summaries and severity
    db.clearSummariesForRepo(repo.id);

    // Get count of open issues
    const openIssuesCount = db.getIssueCount(repo.id, { state: 'open' });

    // Regenerate all summaries
    if (openIssuesCount > 0) {
      syncJobs.set(jobId, {
        status: 'summarizing',
        stage: `Regenerating AI summaries (0/${openIssuesCount})`,
        progress: { current: 0, total: openIssuesCount },
        percentage: 0
      });

      await aiService.generateMissingSummaries(repo.id, (progress) => {
        const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
        syncJobs.set(jobId, {
          status: 'summarizing',
          stage: `Regenerating AI summaries (${progress.current}/${progress.total})`,
          progress,
          percentage
        });
      });
    }

    // Regenerate starter reports
    syncJobs.set(jobId, {
      status: 'generating-reports',
      stage: 'Regenerating starter reports (1/3)',
      progress: { current: 1, total: 3 },
      percentage: 33
    });

    await aiService.generateAllStarterReports(repo.id, (progress) => {
      const percentage = Math.round((progress.current / progress.total) * 100);
      syncJobs.set(jobId, {
        status: 'generating-reports',
        stage: `Regenerating starter reports (${progress.current}/${progress.total})`,
        progress,
        percentage
      });
    });

    // Complete
    syncJobs.set(jobId, {
      status: 'complete',
      issuesCount: openIssuesCount,
      message: `Regenerated summaries for ${openIssuesCount} issue(s)`,
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
    console.error('Refresh cache error:', error);
  }
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

// Get severity scale configuration
app.get('/api/severity-scale/:owner/:name', (req, res) => {
  try {
    const { owner, name } = req.params;
    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    const scale = severityConfig.getSeverityScale(repo.id);
    res.json(scale);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update severity scale configuration
app.post('/api/severity-scale/:owner/:name', (req, res) => {
  try {
    const { owner, name } = req.params;
    const { scale_definition } = req.body;

    if (!scale_definition) {
      return res.status(400).json({ error: 'scale_definition is required' });
    }

    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    severityConfig.setSeverityScale(repo.id, scale_definition);
    res.json({ success: true, message: 'Severity scale updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get issues list with filters
app.get('/api/issues/:owner/:name', (req, res) => {
  try {
    const { owner, name } = req.params;
    const { state, severity, search, limit } = req.query;

    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not synced yet' });
    }

    const filters = {};
    if (state) filters.state = state;
    if (severity) filters.severity = severity;
    if (search) filters.search = search;
    if (limit) filters.limit = parseInt(limit);

    const issues = db.getIssuesWithSummaries(repo.id, filters);

    // Diagnostic: log sample issue to verify project data flows to API
    if (issues.length > 0) {
      const sample = issues.find(i => i.project_status) || issues[0];
      console.log(`[API /issues] Returning ${issues.length} issues. Sample #${sample.number}: project_status=${sample.project_status}, sprint=${sample.sprint}, assignees=${sample.assignees}`);
    }

    res.json({ issues, total: issues.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get insights/statistics
app.get('/api/insights/:owner/:name', (req, res) => {
  try {
    const { owner, name } = req.params;
    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not synced yet' });
    }

    // Overall stats
    const stats = {
      total: db.getIssueCount(repo.id),
      open: db.getIssueCount(repo.id, { state: 'open' }),
      closed: db.getIssueCount(repo.id, { state: 'closed' }),
      bugs: db.getIssueCount(repo.id, { is_bug: true, state: 'open' }),
      stale: db.getIssueCount(repo.id, { is_stale: true })
    };

    // Severity breakdown (only open issues)
    const severityBreakdown = {};
    const severityLevels = ['P0', 'P1', 'P2', 'P3', 'P4'];
    for (const level of severityLevels) {
      severityBreakdown[level] = db.getIssueCount(repo.id, { state: 'open', severity: level });
    }

    // Recent activity (issues updated in last 7 days)
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const allIssues = db.getIssues(repo.id);
    const recentActivity = allIssues.filter(i => i.updated_at >= sevenDaysAgo).length;

    // Word cloud data from issue titles and labels
    const stopWords = new Set([
      'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'are', 'was',
      'were', 'been', 'has', 'have', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'not',
      'no', 'nor', 'so', 'if', 'then', 'than', 'that', 'this', 'these',
      'those', 'i', 'we', 'you', 'he', 'she', 'they', 'me', 'us', 'him',
      'her', 'them', 'my', 'our', 'your', 'his', 'its', 'their', 'what',
      'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each',
      'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
      'only', 'own', 'same', 'also', 'just', 'about', 'above', 'after',
      'again', 'any', 'because', 'before', 'being', 'below', 'between',
      'during', 'further', 'here', 'into', 'once', 'out', 'over', 'under',
      'until', 'up', 'very', 'while', 'there', 'through', 'too', 'don',
      'doesn', 'didn', 'won', 'shouldn', 'couldn', 'wouldn', 'isn', 'aren',
      'wasn', 'weren', 'hasn', 'haven', 'hadn', 'get', 'got', 'make',
      'new', 'use', 'using', 'used', 'need', 'needs', 'way', 'via', 'vs',
      'etc', 'eg', 'ie', 'de', 'le', 'la', 'el', 'en', 'es', 'et',
    ]);

    const wordCounts = {};
    const openIssues = allIssues.filter(i => i.state === 'open');

    for (const issue of openIssues) {
      // Extract words from title
      const words = issue.title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w) && !/^\d+$/.test(w));

      for (const word of words) {
        wordCounts[word] = (wordCounts[word] || 0) + 1;
      }

      // Extract labels
      try {
        const labels = JSON.parse(issue.labels || '[]');
        for (const label of labels) {
          const labelKey = label.toLowerCase();
          wordCounts[labelKey] = (wordCounts[labelKey] || 0) + 2; // Weight labels higher
        }
      } catch (e) {
        // skip malformed labels
      }
    }

    // Sort by count and take top 60 words
    const wordcloud = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([text, count]) => ({ text, count }));

    res.json({
      stats,
      severityBreakdown,
      recentActivity,
      lastSynced: repo.last_synced,
      wordcloud
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get WIP (Work In Progress) summary
app.get('/api/wip/:owner/:name', async (req, res) => {
  try {
    const { owner, name } = req.params;
    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not synced yet' });
    }

    // Get all open issues with summaries
    const issues = db.getIssuesWithSummaries(repo.id, { state: 'open' });

    // Filter to only issues with project status indicating active work
    // Common WIP statuses: "In Progress", "In Development", "Doing", "Active", etc.
    const wipStatuses = ['in progress', 'in development', 'doing', 'active', 'started', 'wip'];
    const wipIssues = issues.filter(issue => {
      if (!issue.project_status) return false;
      return wipStatuses.some(status => issue.project_status.toLowerCase().includes(status));
    });

    if (wipIssues.length === 0) {
      return res.json({
        summary: '',
        byEngineer: []
      });
    }

    // Group by assignee
    const byEngineer = {};
    wipIssues.forEach(issue => {
      let assignees = [];
      if (issue.assignees) {
        try {
          assignees = typeof issue.assignees === 'string' ? JSON.parse(issue.assignees) : issue.assignees;
        } catch (e) {
          assignees = [];
        }
      }

      if (assignees.length === 0) {
        // Unassigned issues
        if (!byEngineer['Unassigned']) {
          byEngineer['Unassigned'] = [];
        }
        byEngineer['Unassigned'].push(issue);
      } else {
        // Assigned issues
        assignees.forEach(assignee => {
          if (!byEngineer[assignee]) {
            byEngineer[assignee] = [];
          }
          byEngineer[assignee].push(issue);
        });
      }
    });

    // Generate AI summary
    const summaryPrompt = `You are a product manager reviewing what engineers are currently building. Based on the following open issues that are marked as "In Progress", create a concise bullet-point summary of what's being built.

Issues in progress:
${wipIssues.map((issue, i) => `${i + 1}. [#${issue.number}] ${issue.title}
   Summary: ${issue.summary || 'No summary'}
   Assignee: ${issue.assignees ? JSON.parse(issue.assignees).join(', ') : 'Unassigned'}
   Sprint: ${issue.sprint || 'N/A'}`).join('\n\n')}

Provide a brief overview in 3-5 bullet points of what's actively being developed using markdown formatting. Use bold text for emphasis and reference issue numbers. Focus on user-facing features and improvements. Start directly with bullet points, no preamble.`;

    const summary = await aiService.chat(summaryPrompt);

    // Format by engineer data
    const byEngineerArray = Object.keys(byEngineer).map(assignee => ({
      assignee,
      issues: byEngineer[assignee].map(issue => ({
        number: issue.number,
        title: issue.title,
        project_status: issue.project_status,
        html_url: issue.html_url
      }))
    })).sort((a, b) => {
      // Sort unassigned to the end
      if (a.assignee === 'Unassigned') return 1;
      if (b.assignee === 'Unassigned') return -1;
      return a.assignee.localeCompare(b.assignee);
    });

    res.json({
      summary,
      byEngineer: byEngineerArray
    });
  } catch (error) {
    console.error('WIP error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Epics - issues with task lists (subtasks)
app.get('/api/epics/:owner/:name', async (req, res) => {
  try {
    const { owner, name } = req.params;
    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not synced yet' });
    }

    // Get all open issues with summaries
    const issues = db.getIssuesWithSummaries(repo.id, { state: 'open' });

    // Find epics: issues labeled "epic"
    const epics = [];
    for (const issue of issues) {
      const hasEpicLabel = issue.labels.some(l =>
        /epic/i.test(l)
      );

      if (!hasEpicLabel) continue;

      // Parse task list items from body: - [ ] or - [x]
      const body = issue.body || '';
      const taskPattern = /- \[([ xX])\]/g;
      const tasks = [];
      let match;
      while ((match = taskPattern.exec(body)) !== null) {
        tasks.push({ completed: match[1] !== ' ' });
      }

      {
        const completedCount = tasks.filter(t => t.completed).length;
        const totalCount = tasks.length;

        epics.push({
          number: issue.number,
          title: issue.title,
          html_url: issue.html_url,
          state: issue.state,
          labels: issue.labels,
          summary: issue.summary,
          severity: issue.severity,
          assignees: issue.assignees,
          project_status: issue.project_status,
          updated_at: issue.updated_at,
          created_at: issue.created_at,
          last_activity_at: issue.last_activity_at || issue.updated_at,
          subtasks: {
            completed: completedCount,
            total: totalCount,
            percentage: totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
          }
        });
      }
    }

    // Sort by most recent activity (comments, updates, etc.)
    epics.sort((a, b) => b.last_activity_at - a.last_activity_at);

    // Generate LLM summary for what's left to do across all epics
    let aiSummary = null;
    if (epics.length > 0) {
      const epicsSummaryInput = epics.slice(0, 20).map((epic, i) => {
        const progress = epic.subtasks.total > 0
          ? `${epic.subtasks.completed}/${epic.subtasks.total} subtasks done (${epic.subtasks.percentage}%)`
          : 'No subtask checklist';
        return `${i + 1}. [#${epic.number}] ${epic.title}
   Progress: ${progress}
   Summary: ${epic.summary || 'No summary'}
   Status: ${epic.project_status || 'N/A'}`;
      }).join('\n\n');

      const prompt = `You are a project manager reviewing the status of epics (large initiatives) in a GitHub repository. Based on the following open epics and their subtask progress, provide a concise summary of the overall state of play.

Epics:
${epicsSummaryInput}

Provide:
1. A brief overall status (1-2 sentences)
2. Which epics are closest to completion
3. Which epics need the most attention
4. Key risks or blockers if apparent

Use markdown formatting with bold text and bullet points. Reference issue numbers. Be direct and concise. Start directly with the content, no preamble.`;

      try {
        aiSummary = await aiService.chat(prompt);
      } catch (err) {
        console.error('Error generating epics summary:', err.message);
      }
    }

    res.json({
      epics,
      total: epics.length,
      aiSummary
    });
  } catch (error) {
    console.error('Epics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint - verify project data pipeline
app.get('/api/debug/:owner/:name', (req, res) => {
  try {
    const { owner, name } = req.params;
    const repo = db.getRepo(owner, name);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not synced yet' });
    }

    // Direct DB queries to verify data
    const totalIssues = db.db.prepare('SELECT COUNT(*) as c FROM issues WHERE repo_id = ?').get(repo.id).c;
    const openIssues = db.db.prepare('SELECT COUNT(*) as c FROM issues WHERE repo_id = ? AND state = ?').get(repo.id, 'open').c;
    const withStatus = db.db.prepare('SELECT COUNT(*) as c FROM issues WHERE repo_id = ? AND project_status IS NOT NULL').get(repo.id).c;
    const withSprint = db.db.prepare('SELECT COUNT(*) as c FROM issues WHERE repo_id = ? AND sprint IS NOT NULL').get(repo.id).c;
    const withAssignees = db.db.prepare('SELECT COUNT(*) as c FROM issues WHERE repo_id = ? AND assignees IS NOT NULL').get(repo.id).c;

    // Sample issues with project data
    const samples = db.db.prepare(
      'SELECT number, project_status, sprint, assignees FROM issues WHERE repo_id = ? AND project_status IS NOT NULL LIMIT 5'
    ).all(repo.id);

    // Also test getIssuesWithSummaries (the actual API path)
    const apiIssues = db.getIssuesWithSummaries(repo.id, { state: 'open', limit: 5 });
    const apiSamples = apiIssues.map(i => ({
      number: i.number,
      project_status: i.project_status,
      sprint: i.sprint,
      assignees: i.assignees
    }));

    res.json({
      repo: { id: repo.id, owner: repo.owner, name: repo.name },
      counts: { totalIssues, openIssues, withStatus, withSprint, withAssignees },
      dbSamples: samples,
      apiPathSamples: apiSamples
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Multi-repo API endpoints
// ============================================

// List all synced repos (for the multi-select UI)
app.get('/api/repos', (req, res) => {
  try {
    const repos = db.getAllSyncedRepos();
    res.json({ repos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get multi-repo issues with filters
app.post('/api/multi/issues', (req, res) => {
  try {
    const { repos: repoList, state, severity, search, limit } = req.body;

    if (!repoList || !Array.isArray(repoList) || repoList.length === 0) {
      return res.status(400).json({ error: 'repos array is required' });
    }

    // Resolve repo IDs from owner/name pairs
    const repoIds = [];
    for (const r of repoList) {
      const repo = db.getRepo(r.owner, r.name);
      if (repo) repoIds.push(repo.id);
    }

    if (repoIds.length === 0) {
      return res.json({ issues: [], total: 0 });
    }

    const filters = {};
    if (state) filters.state = state;
    if (severity) filters.severity = severity;
    if (search) filters.search = search;
    if (limit) filters.limit = parseInt(limit);

    const issues = db.getMultiRepoIssuesWithSummaries(repoIds, filters);
    res.json({ issues, total: issues.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get multi-repo stats
app.post('/api/multi/stats', (req, res) => {
  try {
    const { repos: repoList } = req.body;

    if (!repoList || !Array.isArray(repoList) || repoList.length === 0) {
      return res.status(400).json({ error: 'repos array is required' });
    }

    const repoIds = [];
    for (const r of repoList) {
      const repo = db.getRepo(r.owner, r.name);
      if (repo) repoIds.push(repo.id);
    }

    if (repoIds.length === 0) {
      return res.json({ stats: { total: 0, open: 0, closed: 0, bugs: 0, stale: 0 } });
    }

    const stats = {
      total: db.getMultiRepoIssueCount(repoIds),
      open: db.getMultiRepoIssueCount(repoIds, { state: 'open' }),
      closed: db.getMultiRepoIssueCount(repoIds, { state: 'closed' }),
      bugs: db.getMultiRepoIssueCount(repoIds, { is_bug: true, state: 'open' }),
      stale: db.getMultiRepoIssueCount(repoIds, { is_stale: true })
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Multi-repo insights
app.post('/api/multi/insights', (req, res) => {
  try {
    const { repos: repoList } = req.body;

    if (!repoList || !Array.isArray(repoList) || repoList.length === 0) {
      return res.status(400).json({ error: 'repos array is required' });
    }

    const repoIds = [];
    const repoMetas = [];
    for (const r of repoList) {
      const repo = db.getRepo(r.owner, r.name);
      if (repo) {
        repoIds.push(repo.id);
        repoMetas.push(repo);
      }
    }

    if (repoIds.length === 0) {
      return res.json({ stats: { total: 0, open: 0, closed: 0, bugs: 0, stale: 0 }, severityBreakdown: {}, recentActivity: 0, wordcloud: [] });
    }

    const stats = {
      total: db.getMultiRepoIssueCount(repoIds),
      open: db.getMultiRepoIssueCount(repoIds, { state: 'open' }),
      closed: db.getMultiRepoIssueCount(repoIds, { state: 'closed' }),
      bugs: db.getMultiRepoIssueCount(repoIds, { is_bug: true, state: 'open' }),
      stale: db.getMultiRepoIssueCount(repoIds, { is_stale: true })
    };

    const severityBreakdown = {};
    const severityLevels = ['P0', 'P1', 'P2', 'P3', 'P4'];
    for (const level of severityLevels) {
      severityBreakdown[level] = db.getMultiRepoIssueCount(repoIds, { state: 'open', severity: level });
    }

    const allIssues = db.getMultiRepoIssues(repoIds);
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recentActivity = allIssues.filter(i => i.updated_at >= sevenDaysAgo).length;

    // Last synced = most recent sync across all repos
    const lastSynced = Math.max(...repoMetas.map(r => r.last_synced || 0));

    // Word cloud from open issues
    const stopWords = new Set([
      'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'are', 'was',
      'were', 'been', 'has', 'have', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'not',
      'no', 'nor', 'so', 'if', 'then', 'than', 'that', 'this', 'these',
      'those', 'i', 'we', 'you', 'he', 'she', 'they', 'me', 'us', 'him',
      'her', 'them', 'my', 'our', 'your', 'his', 'its', 'their', 'what',
      'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each',
      'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
      'only', 'own', 'same', 'also', 'just', 'about', 'above', 'after',
      'again', 'any', 'because', 'before', 'being', 'below', 'between',
      'during', 'further', 'here', 'into', 'once', 'out', 'over', 'under',
      'until', 'up', 'very', 'while', 'there', 'through', 'too', 'don',
      'doesn', 'didn', 'won', 'shouldn', 'couldn', 'wouldn', 'isn', 'aren',
      'wasn', 'weren', 'hasn', 'haven', 'hadn', 'get', 'got', 'make',
      'new', 'use', 'using', 'used', 'need', 'needs', 'way', 'via', 'vs',
      'etc', 'eg', 'ie', 'de', 'le', 'la', 'el', 'en', 'es', 'et',
    ]);

    const wordCounts = {};
    const openIssues = allIssues.filter(i => i.state === 'open');

    for (const issue of openIssues) {
      const words = issue.title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w) && !/^\d+$/.test(w));

      for (const word of words) {
        wordCounts[word] = (wordCounts[word] || 0) + 1;
      }

      try {
        const labels = JSON.parse(issue.labels || '[]');
        for (const label of labels) {
          const labelKey = label.toLowerCase();
          wordCounts[labelKey] = (wordCounts[labelKey] || 0) + 2;
        }
      } catch (e) { /* skip */ }
    }

    const wordcloud = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([text, count]) => ({ text, count }));

    res.json({
      stats,
      severityBreakdown,
      recentActivity,
      lastSynced,
      wordcloud
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Multi-repo WIP
app.post('/api/multi/wip', async (req, res) => {
  try {
    const { repos: repoList } = req.body;

    if (!repoList || !Array.isArray(repoList) || repoList.length === 0) {
      return res.status(400).json({ error: 'repos array is required' });
    }

    const repoIds = [];
    for (const r of repoList) {
      const repo = db.getRepo(r.owner, r.name);
      if (repo) repoIds.push(repo.id);
    }

    if (repoIds.length === 0) {
      return res.json({ summary: '', byEngineer: [] });
    }

    const issues = db.getMultiRepoIssuesWithSummaries(repoIds, { state: 'open' });

    const wipStatuses = ['in progress', 'in development', 'doing', 'active', 'started', 'wip'];
    const wipIssues = issues.filter(issue => {
      if (!issue.project_status) return false;
      return wipStatuses.some(status => issue.project_status.toLowerCase().includes(status));
    });

    if (wipIssues.length === 0) {
      return res.json({ summary: '', byEngineer: [] });
    }

    const byEngineer = {};
    wipIssues.forEach(issue => {
      let assignees = [];
      if (issue.assignees) {
        try {
          assignees = typeof issue.assignees === 'string' ? JSON.parse(issue.assignees) : issue.assignees;
        } catch (e) { assignees = []; }
      }
      if (assignees.length === 0) {
        if (!byEngineer['Unassigned']) byEngineer['Unassigned'] = [];
        byEngineer['Unassigned'].push(issue);
      } else {
        assignees.forEach(assignee => {
          if (!byEngineer[assignee]) byEngineer[assignee] = [];
          byEngineer[assignee].push(issue);
        });
      }
    });

    const summaryPrompt = `You are a product manager reviewing what engineers are currently building across multiple repositories. Based on the following open issues that are marked as "In Progress", create a concise bullet-point summary of what's being built.

Issues in progress:
${wipIssues.map((issue, i) => `${i + 1}. [${issue.repo_owner}/${issue.repo_name}#${issue.number}] ${issue.title}
   Summary: ${issue.summary || 'No summary'}
   Assignee: ${issue.assignees ? JSON.parse(issue.assignees).join(', ') : 'Unassigned'}
   Sprint: ${issue.sprint || 'N/A'}`).join('\n\n')}

Provide a brief overview in 3-5 bullet points of what's actively being developed using markdown formatting. Use bold text for emphasis and reference issue numbers with their repo. Focus on user-facing features and improvements. Start directly with bullet points, no preamble.`;

    const summary = await aiService.chat(summaryPrompt);

    const byEngineerArray = Object.keys(byEngineer).map(assignee => ({
      assignee,
      issues: byEngineer[assignee].map(issue => ({
        number: issue.number,
        title: issue.title,
        project_status: issue.project_status,
        html_url: issue.html_url,
        repo_owner: issue.repo_owner,
        repo_name: issue.repo_name
      }))
    })).sort((a, b) => {
      if (a.assignee === 'Unassigned') return 1;
      if (b.assignee === 'Unassigned') return -1;
      return a.assignee.localeCompare(b.assignee);
    });

    res.json({ summary, byEngineer: byEngineerArray });
  } catch (error) {
    console.error('Multi WIP error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Multi-repo epics
app.post('/api/multi/epics', async (req, res) => {
  try {
    const { repos: repoList } = req.body;

    if (!repoList || !Array.isArray(repoList) || repoList.length === 0) {
      return res.status(400).json({ error: 'repos array is required' });
    }

    const repoIds = [];
    for (const r of repoList) {
      const repo = db.getRepo(r.owner, r.name);
      if (repo) repoIds.push(repo.id);
    }

    if (repoIds.length === 0) {
      return res.json({ epics: [], total: 0, aiSummary: null });
    }

    const issues = db.getMultiRepoIssuesWithSummaries(repoIds, { state: 'open' });

    const epics = [];
    for (const issue of issues) {
      const hasEpicLabel = issue.labels.some(l => /epic/i.test(l));
      if (!hasEpicLabel) continue;

      const body = issue.body || '';
      const taskPattern = /- \[([ xX])\]/g;
      const tasks = [];
      let match;
      while ((match = taskPattern.exec(body)) !== null) {
        tasks.push({ completed: match[1] !== ' ' });
      }

      const completedCount = tasks.filter(t => t.completed).length;
      const totalCount = tasks.length;

      epics.push({
        number: issue.number,
        title: issue.title,
        html_url: issue.html_url,
        state: issue.state,
        labels: issue.labels,
        summary: issue.summary,
        severity: issue.severity,
        assignees: issue.assignees,
        project_status: issue.project_status,
        updated_at: issue.updated_at,
        created_at: issue.created_at,
        last_activity_at: issue.last_activity_at || issue.updated_at,
        repo_owner: issue.repo_owner,
        repo_name: issue.repo_name,
        subtasks: {
          completed: completedCount,
          total: totalCount,
          percentage: totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
        }
      });
    }

    epics.sort((a, b) => b.last_activity_at - a.last_activity_at);

    let aiSummary = null;
    if (epics.length > 0) {
      const epicsSummaryInput = epics.slice(0, 20).map((epic, i) => {
        const progress = epic.subtasks.total > 0
          ? `${epic.subtasks.completed}/${epic.subtasks.total} subtasks done (${epic.subtasks.percentage}%)`
          : 'No subtask checklist';
        return `${i + 1}. [${epic.repo_owner}/${epic.repo_name}#${epic.number}] ${epic.title}
   Progress: ${progress}
   Summary: ${epic.summary || 'No summary'}
   Status: ${epic.project_status || 'N/A'}`;
      }).join('\n\n');

      const prompt = `You are a project manager reviewing the status of epics across multiple repositories. Based on the following open epics and their subtask progress, provide a concise summary of the overall state of play.

Epics:
${epicsSummaryInput}

Provide:
1. A brief overall status (1-2 sentences)
2. Which epics are closest to completion
3. Which epics need the most attention
4. Key risks or blockers if apparent

Use markdown formatting with bold text and bullet points. Reference issue numbers with their repo. Be direct and concise. Start directly with the content, no preamble.`;

      try {
        aiSummary = await aiService.chat(prompt);
      } catch (err) {
        console.error('Error generating multi epics summary:', err.message);
      }
    }

    res.json({ epics, total: epics.length, aiSummary });
  } catch (error) {
    console.error('Multi Epics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Multi-repo ask (chat)
app.post('/api/multi/ask', async (req, res) => {
  try {
    const { repos: repoList, question } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }
    if (!repoList || !Array.isArray(repoList) || repoList.length === 0) {
      return res.status(400).json({ error: 'repos array is required' });
    }

    const repoIds = [];
    const repoNames = [];
    for (const r of repoList) {
      const repo = db.getRepo(r.owner, r.name);
      if (repo) {
        repoIds.push(repo.id);
        repoNames.push(`${r.owner}/${r.name}`);
      }
    }

    if (repoIds.length === 0) {
      return res.status(404).json({ error: 'No synced repositories found' });
    }

    const questionLower = question.toLowerCase();
    let filters = { limit: 50 };
    if (questionLower.includes('bug') || questionLower.includes('error') || questionLower.includes('fix')) {
      filters = { is_bug: true, limit: 40 };
    } else if (questionLower.includes('stale') || questionLower.includes('old') || questionLower.includes('zombie')) {
      filters = { is_stale: true, limit: 40 };
    } else if (questionLower.includes('open')) {
      filters = { state: 'open', limit: 40 };
    } else if (questionLower.includes('closed')) {
      filters = { state: 'closed', limit: 40 };
    }

    const relevantIssues = db.getMultiRepoIssuesWithSummaries(repoIds, filters);

    const stats = {
      total: db.getMultiRepoIssueCount(repoIds),
      open: db.getMultiRepoIssueCount(repoIds, { state: 'open' }),
      closed: db.getMultiRepoIssueCount(repoIds, { state: 'closed' }),
      bugs: db.getMultiRepoIssueCount(repoIds, { is_bug: true, state: 'open' }),
      stale: db.getMultiRepoIssueCount(repoIds, { is_stale: true })
    };

    const prompt = `You are analyzing GitHub issues across multiple repositories: ${repoNames.join(', ')}

Repository Statistics (combined):
- Total Issues: ${stats.total}
- Open Issues: ${stats.open}
- Closed Issues: ${stats.closed}
- Open Bugs: ${stats.bugs}
- Stale Issues (90+ days): ${stats.stale}

Relevant Issues (with AI summaries):
${relevantIssues.map(i => `
[${i.repo_owner}/${i.repo_name}] #${i.number}: ${i.title}
State: ${i.state} | Labels: ${i.labels.join(', ') || 'none'}
Created: ${new Date(i.created_at).toLocaleDateString()} | Updated: ${new Date(i.updated_at).toLocaleDateString()}
Summary: ${i.summary || 'No summary available'}
URL: ${i.html_url}
`).join('\n---\n')}

User Question: ${question}

Provide a comprehensive, actionable answer using markdown formatting. Use headers, bullet points, bold text, and code blocks where appropriate. Include specific issue numbers with their repo (e.g., owner/repo#123) when relevant. Be direct and helpful.`;

    const response = await aiService.chatWithModel(prompt, 'query');
    res.json({ answer: response });
  } catch (error) {
    console.error('Multi ask error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Multi-repo starter reports
app.post('/api/multi/report/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { repos: repoList } = req.body;

    if (!repoList || !Array.isArray(repoList) || repoList.length === 0) {
      return res.status(400).json({ error: 'repos array is required' });
    }

    const repoIds = [];
    const repoNames = [];
    for (const r of repoList) {
      const repo = db.getRepo(r.owner, r.name);
      if (repo) {
        repoIds.push(repo.id);
        repoNames.push(`${r.owner}/${r.name}`);
      }
    }

    if (repoIds.length === 0) {
      return res.status(404).json({ error: 'No synced repositories found' });
    }

    let prompt = '';

    if (type === 'quick-sitrep') {
      const openIssues = db.getMultiRepoIssuesWithSummaries(repoIds, { state: 'open', limit: 100 });
      const stats = {
        open: db.getMultiRepoIssueCount(repoIds, { state: 'open' }),
        bugs: db.getMultiRepoIssueCount(repoIds, { state: 'open', is_bug: true }),
        stale: db.getMultiRepoIssueCount(repoIds, { is_stale: true })
      };

      prompt = `Generate a concise Project Management Sitrep across repositories: ${repoNames.join(', ')}.

**Metrics:**
- Total Open: ${stats.open}
- Open Bugs: ${stats.bugs}
- Stale (90+ days): ${stats.stale}

**Recent Open Issues (Last 20):**
${openIssues.slice(0, 20).map(i => `[${i.repo_owner}/${i.repo_name}] #${i.number}: ${i.title} - ${i.summary || ''}`).join('\n')}

Write a concise PM-style status report using markdown formatting. Group by repository where it makes sense. Include issue numbers with their repo prefix.`;
    } else if (type === 'recent-bugs') {
      const bugIssues = db.getMultiRepoIssuesWithSummaries(repoIds, { is_bug: true, state: 'open' });
      prompt = `Analyze recent bugs across repositories: ${repoNames.join(', ')}.

Open Bugs (${bugIssues.length}):
${bugIssues.slice(0, 30).map(i => `[${i.repo_owner}/${i.repo_name}] #${i.number}: ${i.title} - ${i.summary || ''}`).join('\n')}

Provide a report using markdown. Group by repo where helpful.`;
    } else if (type === 'zombie-tickets') {
      const staleIssues = db.getMultiRepoIssuesWithSummaries(repoIds, { is_stale: true, state: 'open' });
      prompt = `Analyze zombie tickets across repositories: ${repoNames.join(', ')}.

Stale Issues (${staleIssues.length}):
${staleIssues.slice(0, 30).map(i => `[${i.repo_owner}/${i.repo_name}] #${i.number}: ${i.title} - Last updated: ${new Date(i.updated_at).toLocaleDateString()} - ${i.summary || ''}`).join('\n')}

Provide a report using markdown. Group by repo where helpful.`;
    }

    const content = await aiService.chat(prompt);
    res.json({ content });
  } catch (error) {
    console.error('Multi report error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync status for multiple repos
app.post('/api/multi/sync-status', (req, res) => {
  try {
    const { repos: repoList } = req.body;

    if (!repoList || !Array.isArray(repoList)) {
      return res.status(400).json({ error: 'repos array is required' });
    }

    const statuses = {};
    for (const r of repoList) {
      const jobId = `${r.owner}/${r.name}`;
      const job = syncJobs.get(jobId);
      const repo = db.getRepo(r.owner, r.name);
      statuses[jobId] = {
        syncJob: job || null,
        hasLocalData: !!(repo && repo.last_synced),
        lastSynced: repo?.last_synced || null
      };
    }

    res.json(statuses);
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
app.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║             🚀 GitRep is running!                        ║
║                                                           ║
║  Open: http://localhost:${PORT}                            ║
║                                                           ║
║  Anthropic API: ${process.env.ANTHROPIC_API_KEY ? '✓ Configured' : '✗ Not configured'}                  ║
║  GitHub Token:  ${process.env.GITHUB_TOKEN ? '✓ Configured' : '✗ Optional (rate limits)'}            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Check GitHub token permissions on startup
  if (process.env.GITHUB_TOKEN) {
    const permissionCheck = await authCheck.checkGitHubTokenPermissions();
    authCheck.printPermissionStatus(permissionCheck);
  }
});
