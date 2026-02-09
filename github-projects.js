const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

/**
 * Make a GraphQL request to GitHub API
 */
async function graphqlRequest(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query, variables });

    const options = {
      hostname: 'api.github.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'User-Agent': 'GitRep-App',
        'Authorization': GITHUB_TOKEN ? `Bearer ${GITHUB_TOKEN}` : undefined
      }
    };

    const req = https.request(options, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub GraphQL API returned ${res.statusCode}: ${body}`));
            return;
          }
          const response = JSON.parse(body);
          if (response.errors) {
            console.error('GraphQL errors:', response.errors);
            reject(new Error(response.errors[0].message));
          } else {
            resolve(response.data);
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

/**
 * Fetch project data for a repository's issues (with pagination)
 */
async function fetchProjectDataForRepo(owner, repo) {
  if (!GITHUB_TOKEN) {
    console.log('No GitHub token provided, skipping project data fetch');
    return new Map();
  }

  try {
    const query = `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          issues(first: 100, states: [OPEN], after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              number
              assignees(first: 10) {
                nodes {
                  login
                }
              }
              projectItems(first: 10) {
                nodes {
                  project {
                    title
                  }
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2SingleSelectField {
                            name
                          }
                        }
                      }
                      ... on ProjectV2ItemFieldTextValue {
                        text
                        field {
                          ... on ProjectV2Field {
                            name
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    // Build a map of issue number -> project data
    const projectDataMap = new Map();
    let issuesWithProjectItems = 0;
    const allFieldNames = new Set();
    let totalIssuesFetched = 0;
    let cursor = null;
    let pageCount = 0;

    // Paginate through all open issues
    while (true) {
      pageCount++;
      const data = await graphqlRequest(query, { owner, repo, cursor });

      if (!data || !data.repository || !data.repository.issues) {
        if (pageCount === 1) {
          console.warn('GraphQL returned no project data — token may lack project read permissions');
        }
        break;
      }

      const issueNodes = data.repository.issues.nodes;
      totalIssuesFetched += issueNodes.length;

      for (const issue of issueNodes) {
        const projectData = {
          status: null,
          sprint: null,
          assignees: null
        };

        // Extract assignees from GraphQL
        if (issue.assignees && issue.assignees.nodes.length > 0) {
          projectData.assignees = JSON.stringify(issue.assignees.nodes.map(a => a.login));
        }

        // Get first project item (most repos have one primary project)
        if (issue.projectItems && issue.projectItems.nodes.length > 0) {
          issuesWithProjectItems++;
          const projectItem = issue.projectItems.nodes[0];

          // Extract field values
          if (projectItem.fieldValues && projectItem.fieldValues.nodes) {
            for (const fieldValue of projectItem.fieldValues.nodes) {
              if (!fieldValue.field) continue;

              const fieldName = fieldValue.field.name.toLowerCase();
              allFieldNames.add(fieldValue.field.name);

              // Look for Status field
              if (fieldName === 'status' && fieldValue.name) {
                projectData.status = fieldValue.name;
              }

              // Look for Sprint field
              if (fieldName === 'sprint' && fieldValue.text) {
                projectData.sprint = fieldValue.text;
              } else if (fieldName === 'sprint' && fieldValue.name) {
                projectData.sprint = fieldValue.name;
              }
            }
          }
        }

        if (projectData.status || projectData.sprint || projectData.assignees) {
          projectDataMap.set(issue.number, projectData);
        }
      }

      // Check for next page
      const pageInfo = data.repository.issues.pageInfo;
      if (pageInfo.hasNextPage && pageInfo.endCursor) {
        cursor = pageInfo.endCursor;
        console.log(`GraphQL page ${pageCount}: ${issueNodes.length} issues (total: ${totalIssuesFetched})`);
      } else {
        break;
      }
    }

    // Diagnostic logging
    console.log(`Project data: ${totalIssuesFetched} issues from GraphQL (${pageCount} pages), ${issuesWithProjectItems} linked to projects, ${projectDataMap.size} with status/sprint/assignees`);
    if (allFieldNames.size > 0) {
      console.log(`Project field names found: ${Array.from(allFieldNames).join(', ')}`);
    }
    if (totalIssuesFetched > 0 && issuesWithProjectItems === 0) {
      console.warn('No issues are linked to a GitHub Project. Add issues to a Project board to enable WIP tracking.');
    } else if (issuesWithProjectItems > 0 && projectDataMap.size === 0) {
      console.warn(`Issues are linked to projects but no "Status" or "Sprint" fields were found. Fields present: ${Array.from(allFieldNames).join(', ')}`);
    }

    return projectDataMap;
  } catch (error) {
    console.error('Error fetching project data:', error.message);
    // Return empty map on error - we can still sync without project data
    return new Map();
  }
}

/**
 * Get unique statuses from the project data
 */
function getUniqueStatuses(projectDataMap) {
  const statuses = new Set();
  for (const data of projectDataMap.values()) {
    if (data.status) {
      statuses.add(data.status);
    }
  }
  return Array.from(statuses).sort();
}

/**
 * Get unique sprints from the project data
 */
function getUniqueSprints(projectDataMap) {
  const sprints = new Set();
  for (const data of projectDataMap.values()) {
    if (data.sprint) {
      sprints.add(data.sprint);
    }
  }
  return Array.from(sprints).sort();
}

module.exports = {
  fetchProjectDataForRepo,
  getUniqueStatuses,
  getUniqueSprints
};
