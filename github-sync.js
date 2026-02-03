const { Octokit } = require('@octokit/rest');
const db = require('./database');

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
    if (onProgress) {
      onProgress({ stage: 'fetching', page, total: allIssues.length });
    }

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
      console.log(`Fetched page ${page}: ${issues.length} issues`);

      hasMore = response.data.length === 100;
      page++;
    } catch (error) {
      console.error(`Error fetching issues: ${error.message}`);
      throw error;
    }
  }

  console.log(`Total issues fetched: ${allIssues.length}`);

  // Save issues to database
  if (onProgress) {
    onProgress({ stage: 'saving', total: allIssues.length });
  }

  for (let i = 0; i < allIssues.length; i++) {
    db.saveIssue(repo.id, allIssues[i]);

    if (onProgress && i % 50 === 0) {
      onProgress({ stage: 'saving', current: i, total: allIssues.length });
    }
  }

  // Update sync timestamp
  db.updateRepoSync(repo.id, null);

  console.log(`Sync complete: ${allIssues.length} issues saved`);

  return {
    repo,
    issuesCount: allIssues.length
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
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  syncRepository,
  getRepoInfo
};
