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
 * Fetch project data for a repository's issues
 */
async function fetchProjectDataForRepo(owner, repo) {
  if (!GITHUB_TOKEN) {
    console.log('No GitHub token provided, skipping project data fetch');
    return new Map();
  }

  try {
    const query = `
      query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          issues(first: 100, states: [OPEN]) {
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

    const data = await graphqlRequest(query, { owner, repo });

    // Build a map of issue number -> project data
    const projectDataMap = new Map();

    if (data && data.repository && data.repository.issues) {
      for (const issue of data.repository.issues.nodes) {
        const projectData = {
          status: null,
          sprint: null
        };

        // Get first project item (most repos have one primary project)
        if (issue.projectItems && issue.projectItems.nodes.length > 0) {
          const projectItem = issue.projectItems.nodes[0];

          // Extract field values
          if (projectItem.fieldValues && projectItem.fieldValues.nodes) {
            for (const fieldValue of projectItem.fieldValues.nodes) {
              if (!fieldValue.field) continue;

              const fieldName = fieldValue.field.name.toLowerCase();

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

        if (projectData.status || projectData.sprint) {
          projectDataMap.set(issue.number, projectData);
        }
      }
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
