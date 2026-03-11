const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const severityConfig = require('./severity-config');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Two-tier model configuration
const MODELS = {
  indexing: 'claude-haiku-4-5-20251001',     // Fast & cheap for background processing
  query: 'claude-opus-4-5-20251101'          // Premium intelligence for user queries
};

// Tier 1: Haiku - Summarize individual issues (background processing)
async function summarizeIssue(issue) {
  // Build comment context if comments exist
  let commentsText = '';
  if (issue.comments && issue.comments.length > 0) {
    const recentComments = issue.comments.slice(-5); // Last 5 comments
    commentsText = '\n\nRecent Comments:\n' + recentComments.map(c =>
      `- ${c.author}: ${c.body.substring(0, 200)}${c.body.length > 200 ? '...' : ''}`
    ).join('\n');
  }

  const prompt = `Summarize this GitHub issue in 1-2 concise sentences. Focus on the problem and current status.

Title: ${issue.title}
State: ${issue.state}
Labels: ${issue.labels ? issue.labels.map(l => l.name).join(', ') : 'none'}
Created: ${new Date(issue.created_at).toLocaleDateString()}
Body: ${issue.body ? issue.body.substring(0, 500) : 'No description'}${commentsText}

Summary:`;

  try {
    const response = await anthropic.messages.create({
      model: MODELS.indexing,
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    return response.content[0].text.trim();
  } catch (error) {
    console.error(`Error summarizing issue ${issue.number}:`, error.message);
    return `${issue.title} - ${issue.state}`;
  }
}

// Tier 1: Haiku - Generate starter reports (cached)
async function generateStarterReport(repoId, reportType) {
  const repo = db.db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId);
  const issues = db.getIssuesWithSummaries(repoId);

  let prompt = '';
  let relevantIssues = [];

  if (reportType === 'quick-sitrep') {
    const openIssues = db.getIssuesWithSummaries(repoId, { state: 'open', limit: 100 });

    // Categorize issues by status/stage based on labels
    const inProgress = openIssues.filter(i =>
      i.labels.some(l => /in progress|wip|working|started/i.test(l))
    );
    const ready = openIssues.filter(i =>
      i.labels.some(l => /ready|to do|todo|backlog/i.test(l))
    );
    const blocked = openIssues.filter(i =>
      i.labels.some(l => /blocked|waiting|hold/i.test(l))
    );
    const review = openIssues.filter(i =>
      i.labels.some(l => /review|needs review|pr/i.test(l))
    );

    prompt = `Generate a concise Project Management Sitrep for ${repo.owner}/${repo.name}.

**Metrics:**
- Total Open: ${db.getIssueCount(repoId, { state: 'open' })}
- Open Bugs: ${db.getIssueCount(repoId, { state: 'open', is_bug: true })}
- Stale (90+ days): ${db.getIssueCount(repoId, { is_stale: true })}

**Issues by Stage:**
${inProgress.length > 0 ? `\nIn Progress (${inProgress.length}):\n${inProgress.slice(0, 8).map(i => `#${i.number}: ${i.title}`).join('\n')}` : ''}
${ready.length > 0 ? `\nReady/Backlog (${ready.length}):\n${ready.slice(0, 8).map(i => `#${i.number}: ${i.title}`).join('\n')}` : ''}
${blocked.length > 0 ? `\nBlocked (${blocked.length}):\n${blocked.slice(0, 8).map(i => `#${i.number}: ${i.title}`).join('\n')}` : ''}
${review.length > 0 ? `\nIn Review (${review.length}):\n${review.slice(0, 8).map(i => `#${i.number}: ${i.title}`).join('\n')}` : ''}

**Recent Activity (Last 20):**
${openIssues.slice(0, 20).map(i => `#${i.number}: ${i.title} - ${i.summary || ''}`).join('\n')}

**Instructions:**
Write a concise PM-style status report using markdown formatting. Include:

## Status Overview
Current state in 1-2 sentences

## In Progress
What's actively being worked on (highlight key items)

## Ready to Start
What's queued up next

## Blockers
Any issues that are blocked/waiting (with reasons if apparent)

## Priorities
Top 3-5 items that need attention

## Risks/Concerns
Any patterns or issues that could impact delivery

Use markdown formatting with headers, bold, bullet points, and issue links. Keep total response concise and actionable.`;

  } else if (reportType === 'recent-bugs') {
    relevantIssues = db.getIssuesWithSummaries(repoId, { is_bug: true, state: 'open', limit: 30 });
    prompt = `Analyze recent bugs for ${repo.owner}/${repo.name}.

Open Bugs (${relevantIssues.length}):
${relevantIssues.map(i => `#${i.number}: ${i.title} - ${i.summary || ''}`).join('\n')}

Provide a report using markdown formatting with headers and bullet points:

## Severity Overview
Overview of bug severity and themes

## Critical Bugs
Bugs that need immediate attention (reference issue numbers)

## Patterns & Root Causes
Common patterns or root causes

Keep it actionable and concise.`;

  } else if (reportType === 'zombie-tickets') {
    relevantIssues = db.getIssuesWithSummaries(repoId, { is_stale: true, state: 'open', limit: 30 });
    prompt = `Analyze zombie tickets (stale issues) for ${repo.owner}/${repo.name}.

Stale Issues (no activity for 90+ days):
${relevantIssues.map(i => `#${i.number}: ${i.title} - Last updated: ${new Date(i.updated_at).toLocaleDateString()} - ${i.summary || ''}`).join('\n')}

Provide a report using markdown formatting with headers and bullet points:

## Why They're Stale
Why these issues might be stale

## Close vs. Revive
Which should be closed vs. revived (reference issue numbers)

## Cleanup Recommendations
Actionable recommendations for cleanup

Keep it practical and concise.`;
  }

  try {
    const response = await anthropic.messages.create({
      model: MODELS.indexing,
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    return response.content[0].text.trim();
  } catch (error) {
    console.error(`Error generating ${reportType} report:`, error.message);
    throw error;
  }
}

// Tier 2: Opus - Answer user questions (premium intelligence)
async function answerQuestion(repoId, question) {
  const repo = db.db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId);

  // Smart filtering: get relevant issues based on question keywords
  let relevantIssues = [];
  const questionLower = question.toLowerCase();

  if (questionLower.includes('bug') || questionLower.includes('error') || questionLower.includes('fix')) {
    relevantIssues = db.getIssuesWithSummaries(repoId, { is_bug: true, limit: 40 });
  } else if (questionLower.includes('stale') || questionLower.includes('old') || questionLower.includes('zombie')) {
    relevantIssues = db.getIssuesWithSummaries(repoId, { is_stale: true, limit: 40 });
  } else if (questionLower.includes('recent') || questionLower.includes('latest') || questionLower.includes('new')) {
    relevantIssues = db.getIssuesWithSummaries(repoId, { limit: 40 });
  } else if (questionLower.includes('open')) {
    relevantIssues = db.getIssuesWithSummaries(repoId, { state: 'open', limit: 40 });
  } else if (questionLower.includes('closed')) {
    relevantIssues = db.getIssuesWithSummaries(repoId, { state: 'closed', limit: 40 });
  } else {
    // General question - get a mix of recent and important issues
    relevantIssues = db.getIssuesWithSummaries(repoId, { limit: 50 });
  }

  const stats = {
    total: db.getIssueCount(repoId),
    open: db.getIssueCount(repoId, { state: 'open' }),
    closed: db.getIssueCount(repoId, { state: 'closed' }),
    bugs: db.getIssueCount(repoId, { is_bug: true, state: 'open' }),
    stale: db.getIssueCount(repoId, { is_stale: true })
  };

  const prompt = `You are analyzing GitHub issues for the repository: ${repo.owner}/${repo.name}

Repository Statistics:
- Total Issues: ${stats.total}
- Open Issues: ${stats.open}
- Closed Issues: ${stats.closed}
- Open Bugs: ${stats.bugs}
- Stale Issues (90+ days): ${stats.stale}

Relevant Issues (with AI summaries):
${relevantIssues.map(i => `
#${i.number}: ${i.title}
State: ${i.state} | Labels: ${i.labels.join(', ') || 'none'}
Created: ${new Date(i.created_at).toLocaleDateString()} | Updated: ${new Date(i.updated_at).toLocaleDateString()}
Summary: ${i.summary || 'No summary available'}
URL: ${i.html_url}
`).join('\n---\n')}

User Question: ${question}

Provide a comprehensive, actionable answer using markdown formatting. Use headers, bullet points, bold text, and code blocks where appropriate. Include specific issue numbers when relevant (e.g., #123). Be direct and helpful.`;

  try {
    const response = await anthropic.messages.create({
      model: MODELS.query,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    return response.content[0].text.trim();
  } catch (error) {
    console.error('Error answering question:', error.message);
    throw error;
  }
}

// Batch summarize and triage multiple issues in one API call
async function summarizeAndTriageBatch(issues, repoId) {
  const severityScale = severityConfig.getSeverityScale(repoId);

  const issuesText = issues.map((issue, idx) => {
    let commentsText = '';
    if (issue.comments && issue.comments.length > 0) {
      const recentComments = issue.comments.slice(-3); // Last 3 comments for batch
      commentsText = '\nRecent Comments: ' + recentComments.map(c =>
        `${c.author}: ${c.body.substring(0, 150)}${c.body.length > 150 ? '...' : ''}`
      ).join('; ');
    }

    return `Issue ${idx + 1}:
#${issue.number} - ${issue.title}
State: ${issue.state} | Labels: ${issue.labels ? issue.labels.map(l => l.name).join(', ') : 'none'}
Body: ${issue.body ? issue.body.substring(0, 300) : 'No description'}${commentsText}`;
  }).join('\n\n---\n\n');

  const prompt = `For each GitHub issue below, provide:
1) A 1-2 sentence summary focusing on the problem and current status
2) A severity assessment using this scale:

${severityScale.scale_definition}

Return ONLY in this exact format (one issue per line):
Issue N | P# | Summary text

${issuesText}

Response:`;

  try {
    const response = await anthropic.messages.create({
      model: MODELS.indexing,
      max_tokens: 400 * issues.length, // Scale with number of issues
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = response.content[0].text.trim();
    const lines = responseText.split('\n').filter(line => line.trim());

    // Parse responses back to individual issues
    const results = [];
    for (let i = 0; i < issues.length; i++) {
      const line = lines[i] || '';
      // Parse: "Issue N | P# | Summary"
      const match = line.match(/Issue \d+\s*\|\s*(P\d+)\s*\|\s*(.+)$/);

      if (match) {
        results.push({
          summary: match[2].trim(),
          severity: match[1]
        });
      } else {
        // Fallback if parsing fails
        results.push({
          summary: `${issues[i].title} - ${issues[i].state}`,
          severity: 'P4'
        });
      }
    }

    return results;
  } catch (error) {
    console.error('Error summarizing and triaging batch:', error.message);
    // Fallback to basic summaries without severity
    return issues.map(issue => ({
      summary: `${issue.title} - ${issue.state}`,
      severity: 'P4'
    }));
  }
}

// Background job: Summarize open issues that don't have summaries (with batching and parallelization)
async function generateMissingSummaries(repoId, onProgress) {
  // Only get open issues
  const openIssues = db.getIssues(repoId, { state: 'open' });
  const totalIssues = openIssues.length;

  // Filter issues that need summaries and add comments
  const issuesToSummarize = [];
  for (const issue of openIssues) {
    const existing = db.getSummary(issue.id, 'quick');
    if (!existing) {
      const comments = db.getComments(issue.id);
      issuesToSummarize.push({
        ...issue,
        labels: JSON.parse(issue.labels),
        comments: comments
      });
    }
  }

  if (issuesToSummarize.length === 0) {
    console.log('No new summaries needed');
    if (onProgress) {
      onProgress({ current: totalIssues, total: totalIssues });
    }
    return { processed: totalIssues, created: 0 };
  }

  console.log(`Summarizing ${issuesToSummarize.length} issues with batching...`);

  // Batch configuration
  const BATCH_SIZE = 8; // Issues per API call
  const CONCURRENT_BATCHES = 3; // Parallel API calls

  let created = 0;

  // Create batches
  const batches = [];
  for (let i = 0; i < issuesToSummarize.length; i += BATCH_SIZE) {
    batches.push(issuesToSummarize.slice(i, i + BATCH_SIZE));
  }

  // Get repo from first issue to pass to summarizeAndTriageBatch
  const repo = db.db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId);

  // Process batches with concurrency limit
  for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
    const currentBatches = batches.slice(i, i + CONCURRENT_BATCHES);

    // Process these batches in parallel
    const results = await Promise.all(
      currentBatches.map(batch => summarizeAndTriageBatch(batch, repoId))
    );

    // Save all summaries and severities from this round
    for (let j = 0; j < results.length; j++) {
      const batch = currentBatches[j];
      const batchResults = results[j];

      for (let k = 0; k < batch.length; k++) {
        db.saveSummary(batch[k].id, 'quick', batchResults[k].summary);
        db.updateIssueSeverity(batch[k].id, batchResults[k].severity);
        created++;

        if (onProgress) {
          onProgress({ current: created, total: issuesToSummarize.length });
        }
      }
    }

    console.log(`Completed ${Math.min(i + CONCURRENT_BATCHES, batches.length)}/${batches.length} batches`);
  }

  // Final progress update
  if (onProgress) {
    onProgress({ current: totalIssues, total: totalIssues });
  }

  console.log(`Generated ${created} new summaries for ${totalIssues} open issues (${batches.length} batches, ${BATCH_SIZE} per batch, ${CONCURRENT_BATCHES} concurrent)`);
  return { processed: totalIssues, created };
}

// Background job: Generate all starter reports
async function generateAllStarterReports(repoId, onProgress) {
  const reports = ['quick-sitrep', 'recent-bugs', 'zombie-tickets'];
  const totalReports = reports.length;

  for (let i = 0; i < reports.length; i++) {
    const reportType = reports[i];
    console.log(`Generating ${reportType} report...`);

    if (onProgress) {
      onProgress({ current: i + 1, total: totalReports });
    }

    const content = await generateStarterReport(repoId, reportType);
    db.saveCachedReport(repoId, reportType, content);
  }

  // Final progress update
  if (onProgress) {
    onProgress({ current: totalReports, total: totalReports });
  }

  console.log('All starter reports generated');
}

// Simple chat helper used by WIP endpoint for summary generation
async function chat(prompt) {
  const response = await anthropic.messages.create({
    model: MODELS.indexing,
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  return response.content[0].text.trim();
}

// Chat helper with model selection (for multi-repo queries that need Opus)
async function chatWithModel(prompt, tier = 'indexing') {
  const model = tier === 'query' ? MODELS.query : MODELS.indexing;
  const response = await anthropic.messages.create({
    model,
    max_tokens: tier === 'query' ? 2000 : 1200,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  return response.content[0].text.trim();
}

module.exports = {
  summarizeIssue,
  generateStarterReport,
  answerQuestion,
  generateMissingSummaries,
  generateAllStarterReports,
  chat,
  chatWithModel
};
