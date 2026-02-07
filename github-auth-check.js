const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

/**
 * Check if GitHub token has the required scopes
 * Returns object with: { hasRequiredScopes, scopes, warnings, errors }
 */
async function checkGitHubTokenPermissions() {
  if (!GITHUB_TOKEN) {
    return {
      hasRequiredScopes: false,
      scopes: [],
      warnings: [],
      errors: ['No GitHub token provided. Set GITHUB_TOKEN in your .env file.']
    };
  }

  try {
    const result = await makeAuthenticatedRequest('/user');

    // Extract scopes from response headers
    const scopesHeader = result.headers['x-oauth-scopes'] || '';
    const scopes = scopesHeader.split(',').map(s => s.trim()).filter(s => s);

    const warnings = [];
    const errors = [];

    // Check for repo access (public_repo or repo)
    const hasRepoAccess = scopes.includes('repo') || scopes.includes('public_repo');

    // Check for project access
    const hasProjectAccess = scopes.includes('read:project') || scopes.includes('project');

    if (!hasRepoAccess) {
      errors.push(
        '❌ Missing required scope: repo or public_repo\n' +
        '   This scope is needed to read repository issues.'
      );
    }

    if (!hasProjectAccess) {
      warnings.push(
        '⚠️  Missing recommended scope: read:project\n' +
        '   Without this scope, project data (status, sprint, assignees) will not be available.\n' +
        '   The WIP page and project filters will not work.'
      );
    }

    const hasRequiredScopes = hasRepoAccess; // Only repo is required, project is recommended

    return {
      hasRequiredScopes,
      scopes,
      warnings,
      errors
    };
  } catch (error) {
    return {
      hasRequiredScopes: false,
      scopes: [],
      warnings: [],
      errors: [`Failed to verify GitHub token: ${error.message}`]
    };
  }
}

/**
 * Make an authenticated request to GitHub API
 */
function makeAuthenticatedRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': 'GitRep-App',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({
            data: JSON.parse(body),
            headers: res.headers
          });
        } else {
          reject(new Error(`GitHub API returned ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

/**
 * Print helpful permission messages to console
 */
function printPermissionStatus(result) {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║          GitHub Token Permission Check                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  if (result.scopes.length > 0) {
    console.log('✓ Token found with scopes:', result.scopes.join(', '));
  }

  // Print errors
  if (result.errors.length > 0) {
    console.log('');
    result.errors.forEach(error => {
      console.error(error);
    });
  }

  // Print warnings
  if (result.warnings.length > 0) {
    console.log('');
    result.warnings.forEach(warning => {
      console.warn(warning);
    });
  }

  // Success message
  if (result.hasRequiredScopes && result.warnings.length === 0) {
    console.log('\n✓ All recommended scopes present! Full functionality enabled.\n');
  } else if (result.hasRequiredScopes && result.warnings.length > 0) {
    console.log('\n✓ Basic functionality enabled, but some features will be limited.\n');
  } else {
    console.log('');
    console.log('📝 To fix permission issues:');
    console.log('   1. Go to: https://github.com/settings/tokens');
    console.log('   2. Edit your token or create a new one');
    console.log('   3. Enable these scopes:');
    console.log('      • public_repo (or repo for private repos) - REQUIRED');
    console.log('      • read:project - RECOMMENDED for WIP tracking');
    console.log('   4. Update GITHUB_TOKEN in your .env file');
    console.log('   5. Restart the server\n');
  }

  console.log('════════════════════════════════════════════════════════════\n');
}

module.exports = {
  checkGitHubTokenPermissions,
  printPermissionStatus
};
