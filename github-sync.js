const { Octokit } = require('@octokit/rest');
const db = require('./database');
const githubProjects = require('./github-projects');

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN || undefined
});

async function syncRepository(owner, name, onProgress) {
  console.log(`Syncing repository: ${owner}/${name}`);

  let repo = db.getRepo(owner, name);
  if (!repo) {
    repo = db.saveRepo(owner, name);
  }

  const allIssues = [];
  let page = 1;
  let hasMore = true;

  // Fetch all issues (both open and closed)
  while (hasMore) {
    try {
      const response = await octokit.issues.listForRepo({
        owner,
        repo: name,
        state: 'all',
        per_page: 100,
        page,
        sort: 'updated',
        direction: 'desc'
      });

      // Filter out pull requests (GitHub API includes them in issues)
      const issues = response.data.filter(issue => !issue.pull_request);

      allIssues.push(...issues);
      console.log(`Fetched page ${page}: ${issues.length} issues (total: ${allIssues.length})`);

      if (onProgress) {
        onProgress({ stage: 'issues', current: allIssues.length, total: allIssues.length });
      }

      hasMore = response.data.length === 100;
      page++;
    } catch (error) {
      console.error(`Error fetching issues: ${error.message}`);

      // Handle rate limit errors with helpful message
      if (error.status === 403 && error.message.includes('rate limit')) {
        const helpfulError = new Error(
          'GitHub API rate limit exceeded. Without authentication, you\'re limited to 60 requests/hour.\n\n' +
          '💡 Solution: Add a GitHub token to your .env file:\n' +
          '   1. Create a token at https://github.com/settings/tokens\n' +
          '   2. Select "public_repo" scope (read-only)\n' +
          '   3. Add to .env: GITHUB_TOKEN=your_token_here\n' +
          '   4. Restart the server\n\n' +
          'With a token, you get 5,000 requests/hour!'
        );
        helpfulError.isRateLimit = true;
        throw helpfulError;
      }

      throw error;
    }
  }

  console.log(`Total issues fetched: ${allIssues.length}`);

  // Fetch project data (status, sprint) for issues
  console.log('Fetching project data...');
  const projectDataMap = await githubProjects.fetchProjectDataForRepo(owner, name);
  console.log(`Project data fetched for ${projectDataMap.size} issues`);

  // Save issues to database
  const totalIssues = allIssues.length;

  for (let i = 0; i < allIssues.length; i++) {
    const issue = allIssues[i];
    const projectData = projectDataMap.get(issue.number);
    db.saveIssue(repo.id, issue, projectData);

    if (onProgress && (i % 25 === 0 || i === allIssues.length - 1)) {
      onProgress({ stage: 'saving', current: i + 1, total: totalIssues });
    }
  }

  // Fetch comments for open issues
  const openIssues = allIssues.filter(issue => issue.state === 'open');
  console.log(`Fetching comments for ${openIssues.length} open issues...`);

  for (let i = 0; i < openIssues.length; i++) {
    const issue = openIssues[i];

    if (issue.comments > 0) {
      try {
        const commentsResponse = await octokit.issues.listComments({
          owner,
          repo: name,
          issue_number: issue.number,
          per_page: 100
        });

        for (const comment of commentsResponse.data) {
          db.saveComment(issue.id, comment);
        }

        console.log(`Fetched ${commentsResponse.data.length} comments for issue #${issue.number}`);
      } catch (error) {
        console.error(`Error fetching comments for issue #${issue.number}:`, error.message);
        // Continue with other issues even if one fails
      }
    }

    if (onProgress && (i % 5 === 0 || i === openIssues.length - 1)) {
      onProgress({ stage: 'comments', current: i + 1, total: openIssues.length });
    }
  }

  // Update sync timestamp
  db.updateRepoSync(repo.id, null);

  console.log(`Sync complete: ${allIssues.length} issues saved, comments fetched for ${openIssues.length} open issues`);

  return {
    repo,
    issuesCount: allIssues.length,
    openIssuesCount: openIssues.length
  };
}

async function getRepoInfo(owner, name) {
  try {
    const response = await octokit.repos.get({ owner, repo: name });
    return {
      success: true,
      data: {
        name: response.data.name,
        fullName: response.data.full_name,
        description: response.data.description,
        stars: response.data.stargazers_count,
        openIssues: response.data.open_issues_count
      }
    };
  } catch (error) {
    // Handle rate limit errors with helpful message
    if (error.status === 403 && error.message.includes('rate limit')) {
      return {
        success: false,
        isRateLimit: true,
        error: 'GitHub API rate limit exceeded. Without authentication, you\'re limited to 60 requests/hour.\n\n' +
               '💡 Solution: Add a GitHub token to your .env file:\n' +
               '   1. Create a token at https://github.com/settings/tokens\n' +
               '   2. Select "public_repo" scope (read-only)\n' +
               '   3. Add to .env: GITHUB_TOKEN=your_token_here\n' +
               '   4. Restart the server\n\n' +
               'With a token, you get 5,000 requests/hour!'
      };
    }

    return {
      success: false,
      error: error.message
    };
  }
}

async function refreshRepository(owner, name, onProgress) {
  console.log(`Refreshing repository: ${owner}/${name}`);

  let repo = db.getRepo(owner, name);
  if (!repo) {
    throw new Error('Repository not found in database. Please do a full sync first.');
  }

  // Get the last updated timestamp from our database
  const lastUpdated = db.getLastUpdatedTimestamp(repo.id);
  if (!lastUpdated) {
    throw new Error('No previous sync found. Please do a full sync first.');
  }

  const since = new Date(lastUpdated).toISOString();
  console.log(`Fetching issues updated since: ${since}`);

  const updatedIssues = [];
  let page = 1;
  let hasMore = true;

  // Fetch only issues updated since last sync
  while (hasMore) {
    try {
      const response = await octokit.issues.listForRepo({
        owner,
        repo: name,
        state: 'all',
        per_page: 100,
        page,
        sort: 'updated',
        direction: 'desc',
        since: since
      });

      // Filter out pull requests
      const issues = response.data.filter(issue => !issue.pull_request);

      if (issues.length === 0) {
        hasMore = false;
        break;
      }

      updatedIssues.push(...issues);
      console.log(`Fetched page ${page}: ${issues.length} updated issues (total: ${updatedIssues.length})`);

      if (onProgress) {
        onProgress({ stage: 'issues', current: updatedIssues.length, total: updatedIssues.length });
      }

      hasMore = response.data.length === 100;
      page++;
    } catch (error) {
      console.error(`Error fetching issues: ${error.message}`);
      if (error.status === 403 && error.message.includes('rate limit')) {
        const helpfulError = new Error(
          'GitHub API rate limit exceeded. Without authentication, you\'re limited to 60 requests/hour.\n\n' +
          '💡 Solution: Add a GitHub token to your .env file:\n' +
          '   1. Create a token at https://github.com/settings/tokens\n' +
          '   2. Select "public_repo" scope (read-only)\n' +
          '   3. Add to .env: GITHUB_TOKEN=your_token_here\n' +
          '   4. Restart the server\n\n' +
          'With a token, you get 5,000 requests/hour!'
        );
        helpfulError.isRateLimit = true;
        throw helpfulError;
      }
      throw error;
    }
  }

  console.log(`Total updated issues fetched: ${updatedIssues.length}`);

  if (updatedIssues.length === 0) {
    console.log('No updates found');
    return {
      repo,
      issuesCount: 0,
      openIssuesCount: 0,
      updatedIssuesCount: 0
    };
  }

  // Fetch project data for updated issues
  console.log('Fetching project data for updated issues...');
  const projectDataMap = await githubProjects.fetchProjectDataForRepo(owner, name);
  console.log(`Project data fetched for ${projectDataMap.size} issues`);

  // Save updated issues to database
  for (let i = 0; i < updatedIssues.length; i++) {
    const issue = updatedIssues[i];
    const projectData = projectDataMap.get(issue.number);
    db.saveIssue(repo.id, issue, projectData);

    if (onProgress && (i % 10 === 0 || i === updatedIssues.length - 1)) {
      onProgress({ stage: 'saving', current: i + 1, total: updatedIssues.length });
    }
  }

  // Fetch comments only for updated open issues
  const openIssues = updatedIssues.filter(issue => issue.state === 'open');
  console.log(`Fetching comments for ${openIssues.length} updated open issues...`);

  for (let i = 0; i < openIssues.length; i++) {
    const issue = openIssues[i];

    if (issue.comments > 0) {
      try {
        const commentsResponse = await octokit.issues.listComments({
          owner,
          repo: name,
          issue_number: issue.number,
          per_page: 100
        });

        for (const comment of commentsResponse.data) {
          db.saveComment(issue.id, comment);
        }

        console.log(`Fetched ${commentsResponse.data.length} comments for issue #${issue.number}`);
      } catch (error) {
        console.error(`Error fetching comments for issue #${issue.number}:`, error.message);
      }
    }

    if (onProgress && (i % 5 === 0 || i === openIssues.length - 1)) {
      onProgress({ stage: 'comments', current: i + 1, total: openIssues.length });
    }
  }

  // Update sync timestamp
  db.updateRepoSync(repo.id, null);

  console.log(`Refresh complete: ${updatedIssues.length} issues updated, comments fetched for ${openIssues.length} open issues`);

  return {
    repo,
    issuesCount: updatedIssues.length,
    openIssuesCount: openIssues.length,
    updatedIssuesCount: updatedIssues.length
  };
}

module.exports = {
  syncRepository,
  refreshRepository,
  getRepoInfo
};
