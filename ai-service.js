const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Two-tier model configuration
const MODELS = {
  indexing: 'claude-3-5-haiku-20241022',    // Fast & cheap for background processing
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
    relevantIssues = issues.slice(0, 50); // Most recent 50
    prompt = `Generate a Quick Sitrep for the ${repo.owner}/${repo.name} repository.

Total Issues: ${db.getIssueCount(repoId)}
Open Issues: ${db.getIssueCount(repoId, { state: 'open' })}
Closed Issues: ${db.getIssueCount(repoId, { state: 'closed' })}
Open Bugs: ${db.getIssueCount(repoId, { state: 'open', is_bug: true })}
Stale Issues: ${db.getIssueCount(repoId, { is_stale: true })}

Recent Issues:
${relevantIssues.slice(0, 20).map(i => `#${i.number}: ${i.title} (${i.state}) - ${i.summary || ''}`).join('\n')}

Provide a brief status update covering:
1. Overall health and activity
2. Key trends or patterns
3. Top priorities or concerns

Keep it concise (3-4 paragraphs).`;

  } else if (reportType === 'recent-bugs') {
    relevantIssues = db.getIssuesWithSummaries(repoId, { is_bug: true, state: 'open', limit: 30 });
    prompt = `Analyze recent bugs for ${repo.owner}/${repo.name}.

Open Bugs (${relevantIssues.length}):
${relevantIssues.map(i => `#${i.number}: ${i.title} - ${i.summary || ''}`).join('\n')}

Provide:
1. Overview of bug severity and themes
2. Critical bugs that need immediate attention
3. Common patterns or root causes

Keep it actionable (3-4 paragraphs).`;

  } else if (reportType === 'zombie-tickets') {
    relevantIssues = db.getIssuesWithSummaries(repoId, { is_stale: true, state: 'open', limit: 30 });
    prompt = `Analyze zombie tickets (stale issues) for ${repo.owner}/${repo.name}.

Stale Issues (no activity for 90+ days):
${relevantIssues.map(i => `#${i.number}: ${i.title} - Last updated: ${new Date(i.updated_at).toLocaleDateString()} - ${i.summary || ''}`).join('\n')}

Provide:
1. Why these issues might be stale
2. Which should be closed vs. revived
3. Recommendations for cleanup

Keep it practical (3-4 paragraphs).`;
  }

  try {
    const response = await anthropic.messages.create({
      model: MODELS.indexing,
      max_tokens: 800,
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

Provide a comprehensive, actionable answer. Include specific issue numbers when relevant (e.g., #123). Be direct and helpful.`;

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

// Batch summarize multiple issues in one API call
async function summarizeBatch(issues) {
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

  const prompt = `Summarize each of these GitHub issues in 1-2 concise sentences. Focus on the problem and current status.
Return ONLY the summaries in order, one per line, starting with "Issue N: " where N is the issue number.

${issuesText}

Summaries:`;

  try {
    const response = await anthropic.messages.create({
      model: MODELS.indexing,
      max_tokens: 300 * issues.length, // Scale with number of issues
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const summariesText = response.content[0].text.trim();
    const summaries = summariesText.split('\n').filter(line => line.trim());

    // Parse summaries back to individual issues
    const results = [];
    for (let i = 0; i < issues.length; i++) {
      const summaryLine = summaries[i] || '';
      // Remove "Issue N: " prefix if present
      const summary = summaryLine.replace(/^Issue \d+:\s*/, '').trim() || `${issues[i].title} - ${issues[i].state}`;
      results.push(summary);
    }

    return results;
  } catch (error) {
    console.error('Error summarizing batch:', error.message);
    // Fallback to basic summaries
    return issues.map(issue => `${issue.title} - ${issue.state}`);
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

  // Process batches with concurrency limit
  for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
    const currentBatches = batches.slice(i, i + CONCURRENT_BATCHES);

    // Process these batches in parallel
    const results = await Promise.all(
      currentBatches.map(batch => summarizeBatch(batch))
    );

    // Save all summaries from this round
    for (let j = 0; j < results.length; j++) {
      const batch = currentBatches[j];
      const summaries = results[j];

      for (let k = 0; k < batch.length; k++) {
        db.saveSummary(batch[k].id, 'quick', summaries[k]);
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

module.exports = {
  summarizeIssue,
  generateStarterReport,
  answerQuestion,
  generateMissingSummaries,
  generateAllStarterReports
};
