// State management
let selectedRepos = []; // Array of { owner, name } objects
let syncedRepos = []; // All repos that have been synced previously (from server)
let isSyncing = false;
let isProcessing = false;
let currentPage = 'chat';
let allIssues = [];
let filteredIssues = [];
let sortColumn = 'number';
let sortDirection = 'desc';
let pendingRepos = []; // Repos being added in config section before connecting

// DOM elements
const configSection = document.getElementById('config-section');
const appSection = document.getElementById('app-section');
const repoInput = document.getElementById('repo-input');
const addRepoBtn = document.getElementById('add-repo-btn');
const setRepoBtn = document.getElementById('set-repo-btn');
const configError = document.getElementById('config-error');
const changeRepoBtn = document.getElementById('change-repo-btn');
const refreshBtn = document.getElementById('refresh-btn');
const syncStatus = document.getElementById('sync-status');
const progressSection = document.getElementById('progress-section');
const progressStage = document.getElementById('progress-stage');
const progressPercentage = document.getElementById('progress-percentage');
const progressFill = document.getElementById('progress-fill');
const chatMessages = document.getElementById('chat-messages');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const starterButtons = document.querySelectorAll('.starter-btn');
const exampleButtons = document.querySelectorAll('.example-btn');
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSavedRepos();
  setupEventListeners();
  checkHealth();
  loadSyncedReposList();
});

function setupEventListeners() {
  // Multi-repo add button
  addRepoBtn.addEventListener('click', handleAddRepo);
  repoInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAddRepo();
  });

  // Connect button (was set-repo-btn)
  setRepoBtn.addEventListener('click', handleConnect);

  // Show suggestions as user types
  repoInput.addEventListener('input', handleRepoInputChange);
  repoInput.addEventListener('focus', handleRepoInputChange);

  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.repo-search-container')) {
      const suggestions = document.getElementById('repo-suggestions');
      if (suggestions) suggestions.classList.remove('show');
    }
  });

  changeRepoBtn.addEventListener('click', () => {
    // Go back to config with current repos pre-loaded
    pendingRepos = [...selectedRepos];
    showConfigSection();
    renderConfigTags();
    updateConnectButton();
  });

  // Refresh button and dropdown
  refreshBtn.addEventListener('click', handleRefresh);

  const refreshDropdownToggle = document.getElementById('refresh-dropdown-toggle');
  const refreshDropdownMenu = document.getElementById('refresh-dropdown-menu');

  refreshDropdownToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshDropdownMenu.classList.toggle('show');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.refresh-dropdown')) {
      refreshDropdownMenu.classList.remove('show');
    }
  });

  document.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      refreshDropdownMenu.classList.remove('show');
      const action = item.dataset.action;

      if (action === 'refresh') {
        await handleRefresh();
      } else if (action === 'refresh-cache') {
        await handleRefreshCache();
      }
    });
  });

  sendBtn.addEventListener('click', handleSendMessage);
  userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = userInput.scrollHeight + 'px';
  });

  starterButtons.forEach(btn => {
    btn.addEventListener('click', () => handleStarterButton(btn.dataset.type));
  });

  exampleButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const repoStr = btn.dataset.repo;
      const [owner, name] = repoStr.split('/');
      addPendingRepo(owner, name);
    });
  });

  // Navigation
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const page = item.dataset.page;
      switchPage(page);
    });
  });

  // Issues page filters
  const issuesSearch = document.getElementById('issues-search');
  const stateFilter = document.getElementById('state-filter');
  const severityFilter = document.getElementById('severity-filter');
  const statusFilter = document.getElementById('status-filter');
  const sprintFilter = document.getElementById('sprint-filter');
  const assigneeFilter = document.getElementById('assignee-filter');

  if (issuesSearch) {
    issuesSearch.addEventListener('input', () => filterIssues());
  }
  if (stateFilter) {
    stateFilter.addEventListener('change', () => loadIssues());
  }
  if (severityFilter) {
    severityFilter.addEventListener('change', () => filterIssues());
  }
  if (statusFilter) {
    statusFilter.addEventListener('change', () => filterIssues());
  }
  if (sprintFilter) {
    sprintFilter.addEventListener('change', () => filterIssues());
  }
  if (assigneeFilter) {
    assigneeFilter.addEventListener('change', () => filterIssues());
  }

  // Sortable table headers
  document.querySelectorAll('.issues-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const column = th.dataset.sort;
      if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = column;
        sortDirection = 'asc';
      }
      updateSortIndicators();
      sortAndRenderIssues();
    });
  });
}

// ============================================
// Multi-repo config UI
// ============================================

async function loadSyncedReposList() {
  try {
    const response = await fetch('/api/repos');
    const data = await response.json();
    syncedRepos = data.repos || [];
  } catch (error) {
    console.error('Error loading synced repos:', error);
    syncedRepos = [];
  }
}

function handleRepoInputChange() {
  const input = repoInput.value.trim().toLowerCase();
  const suggestions = document.getElementById('repo-suggestions');

  if (!input || input.length < 2) {
    suggestions.classList.remove('show');
    return;
  }

  // Filter synced repos that match the input and aren't already pending
  const matches = syncedRepos.filter(repo => {
    const fullName = `${repo.owner}/${repo.name}`.toLowerCase();
    const alreadyAdded = pendingRepos.some(p => p.owner === repo.owner && p.name === repo.name);
    return !alreadyAdded && fullName.includes(input);
  });

  if (matches.length === 0) {
    suggestions.classList.remove('show');
    return;
  }

  suggestions.innerHTML = matches.map(repo => `
    <div class="repo-suggestion" data-owner="${escapeHtml(repo.owner)}" data-name="${escapeHtml(repo.name)}">
      <span>${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</span>
      <span class="synced-indicator">cached</span>
    </div>
  `).join('');

  suggestions.querySelectorAll('.repo-suggestion').forEach(el => {
    el.addEventListener('click', () => {
      addPendingRepo(el.dataset.owner, el.dataset.name);
      suggestions.classList.remove('show');
      repoInput.value = '';
    });
  });

  suggestions.classList.add('show');
}

function addPendingRepo(owner, name) {
  // Check if already added
  if (pendingRepos.some(r => r.owner === owner && r.name === name)) {
    return;
  }

  const isSynced = syncedRepos.some(r => r.owner === owner && r.name === name);
  pendingRepos.push({ owner, name, isSynced });
  renderConfigTags();
  updateConnectButton();
  repoInput.value = '';
  hideError();
}

function removePendingRepo(owner, name) {
  pendingRepos = pendingRepos.filter(r => !(r.owner === owner && r.name === name));
  renderConfigTags();
  updateConnectButton();
}

function renderConfigTags() {
  const tagsContainer = document.getElementById('repo-tags');
  if (pendingRepos.length === 0) {
    tagsContainer.innerHTML = '';
    return;
  }

  tagsContainer.innerHTML = pendingRepos.map(repo => {
    const syncedClass = repo.isSynced ? ' synced' : '';
    return `
      <span class="repo-tag${syncedClass}" data-owner="${escapeHtml(repo.owner)}" data-name="${escapeHtml(repo.name)}">
        ${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}
        <button class="remove-tag" title="Remove">&times;</button>
      </span>
    `;
  }).join('');

  tagsContainer.querySelectorAll('.remove-tag').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tag = e.target.closest('.repo-tag');
      removePendingRepo(tag.dataset.owner, tag.dataset.name);
    });
  });
}

function updateConnectButton() {
  setRepoBtn.disabled = pendingRepos.length === 0;
  const count = pendingRepos.length;
  setRepoBtn.textContent = count === 0 ? 'Connect' :
    count === 1 ? 'Connect 1 Repository' :
    `Connect ${count} Repositories`;
}

async function handleAddRepo() {
  const input = repoInput.value.trim();
  if (!input) return;

  const match = input.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    showError('Invalid format. Use: owner/repository');
    return;
  }

  const [, owner, name] = match;

  // Check if it already exists locally
  const isSynced = syncedRepos.some(r => r.owner === owner && r.name === name);

  if (isSynced) {
    addPendingRepo(owner, name);
    return;
  }

  // Validate it exists on GitHub
  addRepoBtn.disabled = true;
  hideError();

  try {
    const response = await fetch(`/api/repo/${owner}/${name}`);
    const data = await response.json();

    if (!response.ok) {
      if (data.isRateLimit) {
        showError(data.error);
      } else {
        showError(data.error || 'Repository not found');
      }
      addRepoBtn.disabled = false;
      return;
    }

    addPendingRepo(owner, name);
    addRepoBtn.disabled = false;
  } catch (error) {
    showError(error.message);
    addRepoBtn.disabled = false;
  }
}

async function handleConnect() {
  if (pendingRepos.length === 0) return;

  selectedRepos = [...pendingRepos];
  localStorage.setItem('github_sitrep_repos', JSON.stringify(selectedRepos));

  showAppSection();

  // Determine which repos need syncing
  const needsSync = selectedRepos.filter(r =>
    !syncedRepos.some(s => s.owner === r.owner && s.name === r.name)
  );

  if (needsSync.length > 0) {
    // Sync repos that don't have local data yet (one at a time)
    for (const repo of needsSync) {
      await startSync(repo.owner, repo.name);
    }
  } else {
    setSyncStatus('complete', `${selectedRepos.length} repositories loaded from cache`);
  }
}

// ============================================
// Sync management
// ============================================

async function startSync(owner, name) {
  if (isSyncing) return;

  isSyncing = true;
  setSyncStatus('syncing', `Syncing ${owner}/${name}...`);
  showProgress(`Syncing ${owner}/${name}...`, 0);
  disableStarterButtons(true);

  try {
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, name })
    });

    await response.json();
    await pollSyncStatusForRepo(owner, name);

  } catch (error) {
    console.error('Sync error:', error);
    setSyncStatus('error', 'Sync failed');
    hideProgress();
    isSyncing = false;
    disableStarterButtons(false);
  }
}

function pollSyncStatusForRepo(owner, name) {
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/sync/${owner}/${name}`);
        const data = await response.json();

        if (data.status === 'fetching' || data.status === 'summarizing' || data.status === 'generating-reports') {
          const stage = data.stage || 'Processing...';
          const percentage = data.percentage || 0;
          setSyncStatus('syncing', `${owner}/${name}: ${stage}`);
          updateProgress(`${owner}/${name}: ${stage}`, percentage);
        } else if (data.status === 'complete') {
          clearInterval(interval);
          hideProgress();
          isSyncing = false;
          refreshBtn.disabled = false;
          document.getElementById('refresh-dropdown-toggle').disabled = false;
          refreshBtn.classList.remove('spinning');
          disableStarterButtons(false);

          // Refresh local cached repos list
          await loadSyncedReposList();

          const statusMessage = data.message || `${owner}/${name}: ${data.issuesCount} issues synced`;
          setSyncStatus('complete', statusMessage);

          if (currentPage === 'issues') loadIssues();
          else if (currentPage === 'insights') loadInsights();
          else if (currentPage === 'wip') loadWIP();
          else if (currentPage === 'epics') loadEpics();

          resolve();
        } else if (data.status === 'error') {
          clearInterval(interval);
          showSyncError(data);
          hideProgress();
          isSyncing = false;
          refreshBtn.disabled = false;
          document.getElementById('refresh-dropdown-toggle').disabled = false;
          refreshBtn.classList.remove('spinning');
          disableStarterButtons(false);
          resolve();
        }
      } catch (error) {
        console.error('Poll error:', error);
      }
    }, 1000);
  });
}

async function handleRefresh() {
  if (isSyncing || selectedRepos.length === 0) return;

  isSyncing = true;
  refreshBtn.disabled = true;
  document.getElementById('refresh-dropdown-toggle').disabled = true;
  refreshBtn.classList.add('spinning');
  disableStarterButtons(true);

  for (const repo of selectedRepos) {
    setSyncStatus('syncing', `Refreshing ${repo.owner}/${repo.name}...`);
    showProgress(`Refreshing ${repo.owner}/${repo.name}...`, 0);

    try {
      await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: repo.owner, name: repo.name })
      });

      await pollSyncStatusForRepo(repo.owner, repo.name);
    } catch (error) {
      console.error(`Refresh error for ${repo.owner}/${repo.name}:`, error);
    }
  }

  setSyncStatus('complete', 'All repositories refreshed');
  hideProgress();
  isSyncing = false;
  refreshBtn.disabled = false;
  document.getElementById('refresh-dropdown-toggle').disabled = false;
  refreshBtn.classList.remove('spinning');
  disableStarterButtons(false);
}

async function handleRefreshCache() {
  if (isSyncing || selectedRepos.length === 0) return;

  const repoNames = selectedRepos.map(r => `${r.owner}/${r.name}`).join(', ');
  const confirmed = confirm(`This will recompute all AI summaries for: ${repoNames}. This may take several minutes and consume API credits. Continue?`);
  if (!confirmed) return;

  isSyncing = true;
  refreshBtn.disabled = true;
  document.getElementById('refresh-dropdown-toggle').disabled = true;
  refreshBtn.classList.add('spinning');
  disableStarterButtons(true);

  for (const repo of selectedRepos) {
    setSyncStatus('syncing', `Regenerating summaries for ${repo.owner}/${repo.name}...`);
    showProgress(`Regenerating summaries for ${repo.owner}/${repo.name}...`, 0);

    try {
      const response = await fetch('/api/refresh-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: repo.owner, name: repo.name })
      });

      if (response.ok) {
        await pollSyncStatusForRepo(repo.owner, repo.name);
      }
    } catch (error) {
      console.error(`Refresh cache error for ${repo.owner}/${repo.name}:`, error);
    }
  }

  setSyncStatus('complete', 'Cache refreshed for all repositories');
  hideProgress();
  isSyncing = false;
  refreshBtn.disabled = false;
  document.getElementById('refresh-dropdown-toggle').disabled = false;
  refreshBtn.classList.remove('spinning');
  disableStarterButtons(false);
}

// ============================================
// Navigation and page management
// ============================================

function switchPage(page) {
  currentPage = page;

  navItems.forEach(item => {
    if (item.dataset.page === page) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  pages.forEach(pageEl => {
    if (pageEl.id === `${page}-page`) {
      pageEl.classList.add('active');
    } else {
      pageEl.classList.remove('active');
    }
  });

  if (page === 'issues') loadIssues();
  else if (page === 'insights') loadInsights();
  else if (page === 'wip') loadWIP();
  else if (page === 'epics') loadEpics();
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (!data.anthropicConfigured) {
      showError('Anthropic API key not configured. Please check the README for setup instructions.');
    }
  } catch (error) {
    console.error('Health check failed:', error);
  }
}

async function loadSavedRepos() {
  const saved = localStorage.getItem('github_sitrep_repos');
  if (saved) {
    try {
      selectedRepos = JSON.parse(saved);
      if (selectedRepos.length > 0) {
        showAppSection();

        // Check which repos have local data
        let allHaveData = true;
        for (const repo of selectedRepos) {
          try {
            const response = await fetch(`/api/repo/${repo.owner}/${repo.name}`);
            const data = await response.json();
            if (!response.ok || !data.hasLocalData) {
              allHaveData = false;
              await startSync(repo.owner, repo.name);
            }
          } catch (error) {
            console.error(`Error checking repo ${repo.owner}/${repo.name}:`, error);
          }
        }

        if (allHaveData) {
          setSyncStatus('complete', `${selectedRepos.length} repositories loaded`);
        }
        return;
      }
    } catch (e) {
      // Invalid JSON, fall through
    }
  }

  // Also check legacy single-repo format
  const legacySaved = localStorage.getItem('github_sitrep_repo');
  if (legacySaved) {
    try {
      const repo = JSON.parse(legacySaved);
      selectedRepos = [{ owner: repo.owner, name: repo.name }];
      localStorage.setItem('github_sitrep_repos', JSON.stringify(selectedRepos));
      localStorage.removeItem('github_sitrep_repo');
      showAppSection();
      setSyncStatus('complete', 'Repository loaded');
      return;
    } catch (e) {
      // Invalid JSON
    }
  }
}

// ============================================
// Chat & Reports (multi-repo aware)
// ============================================

async function handleStarterButton(type) {
  if (isProcessing || isSyncing) return;

  const labels = {
    'quick-sitrep': 'Quick Sitrep',
    'recent-bugs': 'Recent Bugs',
    'zombie-tickets': 'Zombie Tickets'
  };

  addMessage('user', labels[type]);
  addLoadingMessage();

  isProcessing = true;
  disableStarterButtons(true);
  sendBtn.disabled = true;

  try {
    let response;
    if (selectedRepos.length === 1) {
      // Single repo: use original endpoint
      const repo = selectedRepos[0];
      response = await fetch(`/api/report/${repo.owner}/${repo.name}/${type}`);
    } else {
      // Multi repo: use new endpoint
      response = await fetch(`/api/multi/report/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: selectedRepos })
      });
    }

    const data = await response.json();
    removeLoadingMessage();

    if (response.ok) {
      addMessage('assistant', data.content);
    } else {
      addMessage('assistant', 'Error: ' + data.error);
    }
  } catch (error) {
    removeLoadingMessage();
    addMessage('assistant', 'Sorry, something went wrong. Please try again.');
    console.error('Starter button error:', error);
  } finally {
    isProcessing = false;
    disableStarterButtons(false);
    sendBtn.disabled = false;
  }
}

async function handleSendMessage() {
  const question = userInput.value.trim();
  if (!question || isProcessing || isSyncing) return;

  addMessage('user', question);
  userInput.value = '';
  userInput.style.height = 'auto';

  addLoadingMessage();

  isProcessing = true;
  disableStarterButtons(true);
  sendBtn.disabled = true;

  try {
    let response;
    if (selectedRepos.length === 1) {
      const repo = selectedRepos[0];
      response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: repo.owner, name: repo.name, question })
      });
    } else {
      response = await fetch('/api/multi/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: selectedRepos, question })
      });
    }

    const data = await response.json();
    removeLoadingMessage();

    if (response.ok) {
      addMessage('assistant', data.answer);
    } else {
      addMessage('assistant', 'Error: ' + data.error);
    }
  } catch (error) {
    removeLoadingMessage();
    addMessage('assistant', 'Sorry, something went wrong. Please try again.');
    console.error('Ask error:', error);
  } finally {
    isProcessing = false;
    disableStarterButtons(false);
    sendBtn.disabled = false;
  }
}

function addMessage(role, content) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? '👤' : '🤖';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  if (role === 'assistant') {
    // Convert issue numbers to markdown links
    let linkedContent = content;
    if (selectedRepos.length === 1) {
      const repo = selectedRepos[0];
      linkedContent = content.replace(/#(\d+)/g, (match, number) => {
        const url = `https://github.com/${repo.owner}/${repo.name}/issues/${number}`;
        return `[${match}](${url})`;
      });
    }
    // For multi-repo, the AI should already include full repo/issue references

    const rawHtml = marked.parse(linkedContent);
    contentDiv.innerHTML = DOMPurify.sanitize(rawHtml);

    contentDiv.querySelectorAll('a').forEach(a => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
  } else {
    contentDiv.textContent = content;
  }

  messageDiv.appendChild(avatar);
  messageDiv.appendChild(contentDiv);

  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addLoadingMessage() {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant loading';
  messageDiv.id = 'loading-message';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = '🤖';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.innerHTML = '<div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div>';

  messageDiv.appendChild(avatar);
  messageDiv.appendChild(contentDiv);

  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeLoadingMessage() {
  const loading = document.getElementById('loading-message');
  if (loading) loading.remove();
}

// ============================================
// Issues page (multi-repo aware)
// ============================================

async function loadIssues() {
  const tbody = document.getElementById('issues-tbody');
  const colCount = selectedRepos.length > 1 ? 10 : 9;
  tbody.innerHTML = `<tr><td colspan="${colCount}" class="loading-cell"><div class="loading-spinner"></div>Loading issues...</td></tr>`;

  // Toggle repo column visibility
  const table = document.querySelector('.issues-table');
  if (selectedRepos.length <= 1) {
    table.classList.add('single-repo');
  } else {
    table.classList.remove('single-repo');
  }

  try {
    const stateFilter = document.getElementById('state-filter').value || 'open';
    let response;

    if (selectedRepos.length === 1) {
      const repo = selectedRepos[0];
      response = await fetch(`/api/issues/${repo.owner}/${repo.name}?state=${stateFilter}&limit=500`);
    } else {
      response = await fetch('/api/multi/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: selectedRepos, state: stateFilter, limit: 500 })
      });
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load issues');
    }

    allIssues = data.issues;
    populateFilterDropdowns();
    filterIssues();
  } catch (error) {
    console.error('Error loading issues:', error);
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="loading-cell">Error loading issues: ${error.message}</td></tr>`;
  }
}

function populateFilterDropdowns() {
  const statuses = new Set();
  const sprints = new Set();
  const assignees = new Set();

  allIssues.forEach(issue => {
    if (issue.project_status) statuses.add(issue.project_status);
    if (issue.sprint) sprints.add(issue.sprint);
    if (issue.assignees) {
      try {
        const assigneesArray = typeof issue.assignees === 'string' ? JSON.parse(issue.assignees) : issue.assignees;
        assigneesArray.forEach(a => assignees.add(a));
      } catch (e) { /* skip */ }
    }
  });

  const statusFilter = document.getElementById('status-filter');
  const currentStatus = statusFilter.value;
  statusFilter.innerHTML = '<option value="">All Statuses</option>';
  Array.from(statuses).sort().forEach(status => {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = status;
    if (status === currentStatus) option.selected = true;
    statusFilter.appendChild(option);
  });

  const sprintFilter = document.getElementById('sprint-filter');
  const currentSprint = sprintFilter.value;
  sprintFilter.innerHTML = '<option value="">All Sprints</option>';
  Array.from(sprints).sort().forEach(sprint => {
    const option = document.createElement('option');
    option.value = sprint;
    option.textContent = sprint;
    if (sprint === currentSprint) option.selected = true;
    sprintFilter.appendChild(option);
  });

  const assigneeFilter = document.getElementById('assignee-filter');
  const currentAssignee = assigneeFilter.value;
  assigneeFilter.innerHTML = '<option value="">All Assignees</option>';
  Array.from(assignees).sort().forEach(assignee => {
    const option = document.createElement('option');
    option.value = assignee;
    option.textContent = assignee;
    if (assignee === currentAssignee) option.selected = true;
    assigneeFilter.appendChild(option);
  });
}

function filterIssues() {
  const searchTerm = document.getElementById('issues-search').value.toLowerCase();
  const severityFilter = document.getElementById('severity-filter').value;
  const statusFilter = document.getElementById('status-filter').value;
  const sprintFilter = document.getElementById('sprint-filter').value;
  const assigneeFilter = document.getElementById('assignee-filter').value;

  filteredIssues = allIssues.filter(issue => {
    const matchesSearch = !searchTerm ||
      issue.title.toLowerCase().includes(searchTerm) ||
      (issue.summary && issue.summary.toLowerCase().includes(searchTerm));

    const matchesSeverity = !severityFilter || issue.severity === severityFilter;
    const matchesStatus = !statusFilter || issue.project_status === statusFilter;
    const matchesSprint = !sprintFilter || issue.sprint === sprintFilter;
    const matchesAssignee = !assigneeFilter || (issue.assignees && issue.assignees.includes(assigneeFilter));

    return matchesSearch && matchesSeverity && matchesStatus && matchesSprint && matchesAssignee;
  });

  sortAndRenderIssues();
}

function updateSortIndicators() {
  document.querySelectorAll('.issues-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sortColumn) {
      th.classList.add(sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function sortAndRenderIssues() {
  const severityOrder = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

  filteredIssues.sort((a, b) => {
    let valA, valB;

    switch (sortColumn) {
      case 'number':
        valA = a.number;
        valB = b.number;
        break;
      case 'severity':
        valA = severityOrder[a.severity] !== undefined ? severityOrder[a.severity] : 999;
        valB = severityOrder[b.severity] !== undefined ? severityOrder[b.severity] : 999;
        break;
      case 'last_activity_at':
        valA = a.last_activity_at || a.updated_at;
        valB = b.last_activity_at || b.updated_at;
        break;
      case 'repo_name':
        valA = `${a.repo_owner || ''}/${a.repo_name || ''}`.toLowerCase();
        valB = `${b.repo_owner || ''}/${b.repo_name || ''}`.toLowerCase();
        break;
      case 'assignees':
        try {
          const aArr = typeof a.assignees === 'string' ? JSON.parse(a.assignees) : (a.assignees || []);
          valA = aArr.length > 0 ? aArr[0].toLowerCase() : '\uffff';
        } catch (e) { valA = '\uffff'; }
        try {
          const bArr = typeof b.assignees === 'string' ? JSON.parse(b.assignees) : (b.assignees || []);
          valB = bArr.length > 0 ? bArr[0].toLowerCase() : '\uffff';
        } catch (e) { valB = '\uffff'; }
        break;
      default:
        valA = (a[sortColumn] || '').toString().toLowerCase();
        valB = (b[sortColumn] || '').toString().toLowerCase();
        break;
    }

    let result;
    if (typeof valA === 'number' && typeof valB === 'number') {
      result = valA - valB;
    } else {
      result = valA < valB ? -1 : valA > valB ? 1 : 0;
    }

    return sortDirection === 'asc' ? result : -result;
  });

  updateSortIndicators();
  renderIssues();
}

function renderIssues() {
  const tbody = document.getElementById('issues-tbody');
  const isMulti = selectedRepos.length > 1;
  const colCount = isMulti ? 10 : 9;

  if (filteredIssues.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty-state">No issues found</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredIssues.map(issue => {
    const repoOwner = issue.repo_owner || (selectedRepos.length === 1 ? selectedRepos[0].owner : '');
    const repoName = issue.repo_name || (selectedRepos.length === 1 ? selectedRepos[0].name : '');
    const issueUrl = `https://github.com/${repoOwner}/${repoName}/issues/${issue.number}`;
    const severityClass = issue.severity ? `severity-${issue.severity}` : '';
    const stateClass = `state-${issue.state}`;
    const lastActivityDate = new Date(issue.last_activity_at || issue.updated_at).toLocaleDateString();

    let assigneeList = '\u2014';
    if (issue.assignees) {
      try {
        const assigneesArray = typeof issue.assignees === 'string' ? JSON.parse(issue.assignees) : issue.assignees;
        assigneeList = assigneesArray.length > 0 ? assigneesArray.join(', ') : '\u2014';
      } catch (e) {
        assigneeList = '\u2014';
      }
    }

    const repoCell = isMulti ? `<td class="repo-cell"><span class="repo-badge" title="${escapeHtml(repoOwner)}/${escapeHtml(repoName)}">${escapeHtml(repoName)}</span></td>` : '';

    return `
      <tr>
        <td><span class="issue-number">#${issue.number}</span></td>
        ${repoCell}
        <td>${issue.severity ? `<span class="severity-badge ${severityClass}">${issue.severity}</span>` : '<span class="severity-badge">\u2014</span>'}</td>
        <td><span class="status-badge">${escapeHtml(issue.project_status || '\u2014')}</span></td>
        <td><a href="${issueUrl}" target="_blank" class="issue-title">${escapeHtml(issue.title)}</a></td>
        <td><div class="issue-summary">${escapeHtml(issue.summary || 'No summary available')}</div></td>
        <td><span class="sprint-badge">${escapeHtml(issue.sprint || '\u2014')}</span></td>
        <td><span class="assignee-badge">${assigneeList}</span></td>
        <td><span class="state-badge ${stateClass}">${issue.state}</span></td>
        <td><span class="issue-date">${lastActivityDate}</span></td>
      </tr>
    `;
  }).join('');
}

// ============================================
// Insights page (multi-repo aware)
// ============================================

async function loadInsights() {
  const insightsContent = document.getElementById('insights-content');
  insightsContent.innerHTML = '<div class="loading-cell"><div class="loading-spinner"></div>Loading insights...</div>';

  try {
    let response;
    if (selectedRepos.length === 1) {
      const repo = selectedRepos[0];
      response = await fetch(`/api/insights/${repo.owner}/${repo.name}`);
    } else {
      response = await fetch('/api/multi/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: selectedRepos })
      });
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load insights');
    }

    renderInsights(data);
  } catch (error) {
    console.error('Error loading insights:', error);
    insightsContent.innerHTML = `<div class="loading-cell">Error loading insights: ${error.message}</div>`;
  }
}

function renderInsights(data) {
  const { stats, severityBreakdown, recentActivity, lastSynced, wordcloud } = data;
  const insightsContent = document.getElementById('insights-content');

  const lastSyncedDate = new Date(lastSynced).toLocaleString();
  const maxCount = Math.max(...Object.values(severityBreakdown), 1);
  const criticalIssues = (severityBreakdown.P0 || 0) + (severityBreakdown.P1 || 0) + (severityBreakdown.P2 || 0);

  const repoLabel = selectedRepos.length > 1
    ? `${selectedRepos.length} repositories`
    : `${selectedRepos[0].owner}/${selectedRepos[0].name}`;

  insightsContent.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Issues</div>
        <div class="stat-value">${stats.total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Open Issues</div>
        <div class="stat-value">${stats.open}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Closed Issues</div>
        <div class="stat-value">${stats.closed}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Open Bugs</div>
        <div class="stat-value">${stats.bugs}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Stale Issues</div>
        <div class="stat-value">${stats.stale}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Recent Activity</div>
        <div class="stat-value">${recentActivity}</div>
        <div class="stat-label" style="margin-top: 0.5rem;">Last 7 days</div>
      </div>
    </div>

    <div class="insights-section">
      <h3>Severity Breakdown (Open Issues)</h3>
      <p class="info-text">Issues are automatically classified by AI based on severity. P0-P2 are above the no-ship threshold. Across ${repoLabel}.</p>

      <div class="severity-bars">
        ${renderSeverityBar('P0', severityBreakdown.P0 || 0, maxCount, '#ef4444')}
        ${renderSeverityBar('P1', severityBreakdown.P1 || 0, maxCount, '#f59e0b')}
        ${renderSeverityBar('P2', severityBreakdown.P2 || 0, maxCount, '#fbbf24')}

        <div class="no-ship-line">No-Ship Threshold</div>

        ${renderSeverityBar('P3', severityBreakdown.P3 || 0, maxCount, '#3b82f6')}
        ${renderSeverityBar('P4', severityBreakdown.P4 || 0, maxCount, '#9ca3af')}
      </div>

      ${criticalIssues > 0 ? `
        <p class="info-text" style="margin-top: 1.5rem; color: var(--error);">
          <strong>${criticalIssues} critical issue(s)</strong> are above the no-ship threshold and should be addressed before release.
        </p>
      ` : `
        <p class="info-text" style="margin-top: 1.5rem; color: var(--success);">
          No critical issues above the no-ship threshold. All P0-P2 issues have been resolved.
        </p>
      `}
    </div>

    <div class="insights-section">
      <h3>Repository Health</h3>
      <p class="info-text">
        <strong>Last synced:</strong> ${lastSyncedDate}<br>
        <strong>Open rate:</strong> ${stats.total > 0 ? Math.round((stats.open / stats.total) * 100) : 0}% of all issues are open<br>
        <strong>Bug rate:</strong> ${stats.open > 0 ? Math.round((stats.bugs / stats.open) * 100) : 0}% of open issues are bugs<br>
        <strong>Stale rate:</strong> ${stats.open > 0 ? Math.round((stats.stale / stats.open) * 100) : 0}% of issues haven't been updated in 90+ days
      </p>
    </div>

    <div class="insights-section">
      <h3>Topic Word Cloud</h3>
      <p class="info-text">Most frequent terms from open issue titles and labels.</p>
      <div class="wordcloud-container">
        ${wordcloud && wordcloud.length > 0
          ? '<canvas id="wordcloud-canvas"></canvas>'
          : '<p class="info-text">No issue data available to generate a word cloud.</p>'}
      </div>
    </div>
  `;

  if (wordcloud && wordcloud.length > 0 && typeof WordCloud !== 'undefined') {
    requestAnimationFrame(() => renderWordCloud(wordcloud));
  }
}

function renderWordCloud(words) {
  const canvas = document.getElementById('wordcloud-canvas');
  if (!canvas) return;

  const container = canvas.parentElement;
  const width = container.clientWidth;
  const height = 350;
  canvas.width = width;
  canvas.height = height;

  const maxCount = Math.max(...words.map(w => w.count));
  const minCount = Math.min(...words.map(w => w.count));
  const range = maxCount - minCount || 1;

  const colors = ['#2563eb', '#3b82f6', '#60a5fa', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

  const list = words.map(w => {
    const normalized = (w.count - minCount) / range;
    const size = Math.round(14 + normalized * 42);
    return [w.text, size];
  });

  WordCloud(canvas, {
    list: list,
    gridSize: 8,
    weightFactor: 1,
    fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
    color: function () {
      return colors[Math.floor(Math.random() * colors.length)];
    },
    backgroundColor: 'transparent',
    rotateRatio: 0.3,
    rotationSteps: 2,
    shuffle: true,
    drawOutOfBound: false,
    shrinkToFit: true
  });
}

function renderSeverityBar(level, count, maxCount, color) {
  const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;

  return `
    <div class="severity-bar-item">
      <div class="severity-bar-label severity-${level}">${level}</div>
      <div class="severity-bar-track">
        <div class="severity-bar-fill severity-${level}" style="width: ${percentage}%; background: ${color};">
          ${count > 0 ? count : ''}
        </div>
      </div>
      <div class="severity-bar-count">${count}</div>
    </div>
  `;
}

// ============================================
// WIP page (multi-repo aware)
// ============================================

async function loadWIP() {
  const wipContent = document.getElementById('wip-content');
  wipContent.innerHTML = '<div class="loading-cell"><div class="loading-spinner"></div>Loading WIP summary...</div>';

  try {
    let response;
    if (selectedRepos.length === 1) {
      const repo = selectedRepos[0];
      response = await fetch(`/api/wip/${repo.owner}/${repo.name}`);
    } else {
      response = await fetch('/api/multi/wip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: selectedRepos })
      });
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load WIP data');
    }

    renderWIP(data);
  } catch (error) {
    console.error('Error loading WIP:', error);
    wipContent.innerHTML = `<div class="loading-cell">Error loading WIP: ${error.message}</div>`;
  }
}

function renderWIP(data) {
  const wipContent = document.getElementById('wip-content');

  if (!data.summary || data.summary.trim() === '') {
    wipContent.innerHTML = `
      <div class="empty-state">
        <p>No work in progress found.</p>
        <p class="info-text">Make sure your GitHub token has <code>read:project</code> scope and issues are added to a project board with Status fields.</p>
      </div>
    `;
    return;
  }

  wipContent.innerHTML = `
    <div class="wip-summary">
      <div class="wip-section">
        <h3>What Engineers Are Building</h3>
        <div class="wip-text">${DOMPurify.sanitize(marked.parse(data.summary))}</div>
      </div>

      ${data.byEngineer && data.byEngineer.length > 0 ? `
        <div class="wip-section">
          <h3>By Engineer</h3>
          <div class="engineer-list">
            ${data.byEngineer.map(eng => `
              <div class="engineer-item">
                <div class="engineer-name">${escapeHtml(eng.assignee)}</div>
                <ul class="engineer-tasks">
                  ${eng.issues.map(issue => {
                    const repoPrefix = issue.repo_owner && issue.repo_name && selectedRepos.length > 1
                      ? `<span class="repo-badge">${escapeHtml(issue.repo_name)}</span> `
                      : '';
                    return `
                    <li>
                      ${repoPrefix}
                      <a href="${issue.html_url}" target="_blank" class="issue-link">
                        #${issue.number}
                      </a>
                      ${escapeHtml(issue.title)}
                      ${issue.project_status ? `<span class="status-badge-inline">${escapeHtml(issue.project_status)}</span>` : ''}
                    </li>
                  `;}).join('')}
                </ul>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <div class="wip-footer">
        <p class="info-text">Last updated: ${new Date().toLocaleString()}</p>
      </div>
    </div>
  `;
}

// ============================================
// Epics page (multi-repo aware)
// ============================================

async function loadEpics() {
  const epicsContent = document.getElementById('epics-content');
  epicsContent.innerHTML = '<div class="loading-cell"><div class="loading-spinner"></div>Loading epics...</div>';

  try {
    let response;
    if (selectedRepos.length === 1) {
      const repo = selectedRepos[0];
      response = await fetch(`/api/epics/${repo.owner}/${repo.name}`);
    } else {
      response = await fetch('/api/multi/epics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repos: selectedRepos })
      });
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load epics');
    }

    renderEpics(data);
  } catch (error) {
    console.error('Error loading epics:', error);
    epicsContent.innerHTML = `<div class="loading-cell">Error loading epics: ${error.message}</div>`;
  }
}

function renderEpics(data) {
  const epicsContent = document.getElementById('epics-content');
  const isMulti = selectedRepos.length > 1;

  if (!data.epics || data.epics.length === 0) {
    epicsContent.innerHTML = `
      <div class="empty-state">
        <p>No epics found.</p>
        <p class="info-text">Epics are detected from issues labeled with "epic".</p>
      </div>
    `;
    return;
  }

  const epicCards = data.epics.map(epic => {
    const progressPercent = epic.subtasks.percentage;
    const progressColor = progressPercent === 100 ? 'var(--success)' :
                          progressPercent >= 75 ? '#10b981' :
                          progressPercent >= 50 ? 'var(--warning)' :
                          progressPercent >= 25 ? '#f59e0b' :
                          'var(--primary)';

    const repoOwner = epic.repo_owner || (selectedRepos.length === 1 ? selectedRepos[0].owner : '');
    const repoName = epic.repo_name || (selectedRepos.length === 1 ? selectedRepos[0].name : '');
    const epicUrl = `https://github.com/${repoOwner}/${repoName}/issues/${epic.number}`;
    const lastActivityDate = new Date(epic.last_activity_at || epic.updated_at).toLocaleDateString();

    let assigneeList = '';
    if (epic.assignees) {
      try {
        const assigneesArray = typeof epic.assignees === 'string' ? JSON.parse(epic.assignees) : epic.assignees;
        assigneeList = assigneesArray.length > 0 ? assigneesArray.join(', ') : '';
      } catch (e) {
        assigneeList = '';
      }
    }

    const repoBadge = isMulti && repoName ? `<span class="repo-badge">${escapeHtml(repoName)}</span>` : '';

    return `
      <div class="epic-card">
        <div class="epic-card-header">
          <div class="epic-card-title-row">
            ${repoBadge}
            <a href="${epicUrl}" target="_blank" class="epic-number">#${epic.number}</a>
            <a href="${epicUrl}" target="_blank" class="epic-title">${escapeHtml(epic.title)}</a>
          </div>
          <div class="epic-card-meta">
            ${epic.severity ? `<span class="severity-badge severity-${epic.severity}">${epic.severity}</span>` : ''}
            ${epic.project_status ? `<span class="status-badge-inline">${escapeHtml(epic.project_status)}</span>` : ''}
            ${assigneeList ? `<span class="epic-assignees">${escapeHtml(assigneeList)}</span>` : ''}
            <span class="epic-date">Last activity ${lastActivityDate}</span>
          </div>
        </div>

        <div class="epic-progress-section">
          <div class="epic-progress-header">
            <span class="epic-progress-label">Subtasks</span>
            <span class="epic-progress-count">${epic.subtasks.completed}/${epic.subtasks.total}${epic.subtasks.total > 0 ? ` (${progressPercent}%)` : ''}</span>
          </div>
          ${epic.subtasks.total > 0 ? `
            <div class="epic-progress-bar">
              <div class="epic-progress-fill" style="width: ${progressPercent}%; background: ${progressColor};"></div>
            </div>
          ` : `
            <div class="epic-no-subtasks">No subtask checklist found</div>
          `}
        </div>

        ${epic.summary ? `
          <div class="epic-summary">
            ${escapeHtml(epic.summary)}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  const aiSummaryHtml = data.aiSummary ? `
    <div class="epics-ai-summary">
      <h3>State of Play</h3>
      <div class="epics-ai-text">${DOMPurify.sanitize(marked.parse(data.aiSummary))}</div>
    </div>
  ` : '';

  epicsContent.innerHTML = `
    <div class="epics-layout">
      ${aiSummaryHtml}
      <div class="epics-stats-row">
        <div class="stat-card">
          <div class="stat-label">Open Epics</div>
          <div class="stat-value">${data.total}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Fully Complete</div>
          <div class="stat-value">${data.epics.filter(e => e.subtasks.total > 0 && e.subtasks.percentage === 100).length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">In Progress</div>
          <div class="stat-value">${data.epics.filter(e => e.subtasks.total > 0 && e.subtasks.percentage > 0 && e.subtasks.percentage < 100).length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Not Started</div>
          <div class="stat-value">${data.epics.filter(e => e.subtasks.total > 0 && e.subtasks.percentage === 0).length}</div>
        </div>
      </div>
      <div class="epics-list">
        ${epicCards}
      </div>
    </div>
  `;
}

// ============================================
// View helpers
// ============================================

function showConfigSection() {
  configSection.style.display = 'flex';
  appSection.style.display = 'none';
  repoInput.value = '';
  setRepoBtn.disabled = pendingRepos.length === 0;
  hideError();
}

function showAppSection() {
  configSection.style.display = 'none';
  appSection.style.display = 'flex';
  renderNavRepos();
}

function renderNavRepos() {
  const navReposList = document.getElementById('nav-repos-list');
  navReposList.innerHTML = selectedRepos.map(repo => `
    <div class="nav-repo-item">
      <span class="repo-owner">${escapeHtml(repo.owner)}/</span><span class="repo-short">${escapeHtml(repo.name)}</span>
    </div>
  `).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showError(message) {
  configError.textContent = message;
  configError.classList.add('show');
}

function hideError() {
  configError.classList.remove('show');
}

function setSyncStatus(status, message) {
  syncStatus.textContent = message;
  syncStatus.className = `sync-status ${status}`;
}

function showSyncError(errorData) {
  if (errorData.isRateLimit) {
    const errorMessage = `GitHub API Rate Limit Exceeded\n\n${errorData.error}`;
    addMessage('assistant', errorMessage);
    setSyncStatus('error', 'Sync failed: Rate limit exceeded');
  } else {
    setSyncStatus('error', 'Sync failed: ' + errorData.error);
  }
}

function showProgress(stage, percentage) {
  progressSection.style.display = 'block';
  updateProgress(stage, percentage);
}

function updateProgress(stage, percentage) {
  progressStage.textContent = stage;
  progressPercentage.textContent = `${percentage}%`;
  progressFill.style.width = `${percentage}%`;
}

function hideProgress() {
  progressSection.style.display = 'none';
  updateProgress('', 0);
}

function disableStarterButtons(disabled) {
  starterButtons.forEach(btn => {
    btn.disabled = disabled;
  });
}
