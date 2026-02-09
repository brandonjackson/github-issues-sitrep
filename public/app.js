// State management
let currentRepo = null;
let isSyncing = false;
let isProcessing = false;
let currentPage = 'chat';
let allIssues = [];
let filteredIssues = [];
let sortColumn = 'number';
let sortDirection = 'desc';

// DOM elements
const configSection = document.getElementById('config-section');
const appSection = document.getElementById('app-section');
const repoInput = document.getElementById('repo-input');
const setRepoBtn = document.getElementById('set-repo-btn');
const configError = document.getElementById('config-error');
const repoNameDisplay = document.getElementById('repo-name');
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
  loadSavedRepo();
  setupEventListeners();
  checkHealth();
});

function setupEventListeners() {
  setRepoBtn.addEventListener('click', handleSetRepo);
  repoInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSetRepo();
  });

  changeRepoBtn.addEventListener('click', () => {
    currentRepo = null;
    localStorage.removeItem('github_sitrep_repo');
    showConfigSection();
  });

  // Refresh button and dropdown
  refreshBtn.addEventListener('click', handleRefresh);

  const refreshDropdownToggle = document.getElementById('refresh-dropdown-toggle');
  const refreshDropdownMenu = document.getElementById('refresh-dropdown-menu');

  refreshDropdownToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshDropdownMenu.classList.toggle('show');
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.refresh-dropdown')) {
      refreshDropdownMenu.classList.remove('show');
    }
  });

  // Handle dropdown items
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
      repoInput.value = btn.dataset.repo;
      handleSetRepo();
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
    stateFilter.addEventListener('change', () => loadIssues()); // Reload from API when state changes
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

function switchPage(page) {
  currentPage = page;

  // Update navigation
  navItems.forEach(item => {
    if (item.dataset.page === page) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update pages
  pages.forEach(pageEl => {
    if (pageEl.id === `${page}-page`) {
      pageEl.classList.add('active');
    } else {
      pageEl.classList.remove('active');
    }
  });

  // Load data for the page
  if (page === 'issues') {
    loadIssues();
  } else if (page === 'insights') {
    loadInsights();
  } else if (page === 'wip') {
    loadWIP();
  }
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

async function loadSavedRepo() {
  const saved = localStorage.getItem('github_sitrep_repo');
  if (saved) {
    const repo = JSON.parse(saved);

    // Check if the repo still has local data
    try {
      const response = await fetch(`/api/repo/${repo.owner}/${repo.name}`);
      const data = await response.json();

      if (response.ok) {
        currentRepo = { owner: repo.owner, name: repo.name, ...data };
        localStorage.setItem('github_sitrep_repo', JSON.stringify(currentRepo));
        showChatSection();

        // If no local data (e.g., after cache reset), trigger sync
        if (!data.hasLocalData) {
          setSyncStatus('syncing', 'No cached data found, syncing...');
          startSync();
        } else {
          // Check for active sync or show ready state
          checkSyncStatus();
        }
      } else {
        // Repo no longer exists or is inaccessible
        localStorage.removeItem('github_sitrep_repo');
        currentRepo = null;
      }
    } catch (error) {
      console.error('Error loading saved repo:', error);
      currentRepo = repo;
      showChatSection();
      checkSyncStatus();
    }
  }
}

async function handleSetRepo() {
  const input = repoInput.value.trim();
  if (!input) return;

  const match = input.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    showError('Invalid format. Use: owner/repository');
    return;
  }

  const [, owner, name] = match;
  setRepoBtn.disabled = true;
  setRepoBtn.textContent = 'Connecting...';
  hideError();

  try {
    // Validate repository exists
    const response = await fetch(`/api/repo/${owner}/${name}`);
    const data = await response.json();

    if (!response.ok) {
      // Handle rate limit errors specially
      if (data.isRateLimit) {
        const errorLines = data.error.split('\n');
        showError(errorLines.join('\n')); // Show full error message
      } else {
        showError(data.error || 'Repository not found');
      }
      setRepoBtn.disabled = false;
      setRepoBtn.textContent = 'Connect';
      return;
    }

    currentRepo = { owner, name, ...data };
    localStorage.setItem('github_sitrep_repo', JSON.stringify(currentRepo));

    showChatSection();

    // Start sync if no local data
    if (!data.hasLocalData) {
      startSync();
    } else {
      setSyncStatus('complete', 'Repository data loaded');
    }

  } catch (error) {
    showError(error.message);
    setRepoBtn.disabled = false;
    setRepoBtn.textContent = 'Connect';
  }
}

async function startSync() {
  if (isSyncing) return;

  isSyncing = true;
  setSyncStatus('syncing', 'Starting sync...');
  showProgress('Starting sync...', 0);
  disableStarterButtons(true);

  try {
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: currentRepo.owner,
        name: currentRepo.name
      })
    });

    const data = await response.json();

    // Poll for sync status
    pollSyncStatus();

  } catch (error) {
    console.error('Sync error:', error);
    setSyncStatus('error', 'Sync failed');
    hideProgress();
    isSyncing = false;
    disableStarterButtons(false);
  }
}

async function handleRefresh() {
  if (isSyncing || !currentRepo) return;

  isSyncing = true;
  refreshBtn.disabled = true;
  document.getElementById('refresh-dropdown-toggle').disabled = true;
  refreshBtn.classList.add('spinning');
  setSyncStatus('syncing', 'Checking for updates...');
  showProgress('Checking for updates...', 0);
  disableStarterButtons(true);

  try {
    const response = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: currentRepo.owner,
        name: currentRepo.name
      })
    });

    const data = await response.json();

    // Poll for sync status (reuse existing polling)
    pollSyncStatus();

  } catch (error) {
    console.error('Refresh error:', error);
    setSyncStatus('error', 'Refresh failed');
    hideProgress();
    isSyncing = false;
    refreshBtn.disabled = false;
    document.getElementById('refresh-dropdown-toggle').disabled = false;
    refreshBtn.classList.remove('spinning');
    disableStarterButtons(false);
  }
}

async function handleRefreshCache() {
  if (isSyncing || !currentRepo) return;

  const confirmed = confirm('This will recompute all AI summaries for this repository. This may take several minutes and consume API credits. Continue?');
  if (!confirmed) return;

  isSyncing = true;
  refreshBtn.disabled = true;
  document.getElementById('refresh-dropdown-toggle').disabled = true;
  refreshBtn.classList.add('spinning');
  setSyncStatus('syncing', 'Regenerating summaries...');
  showProgress('Regenerating summaries...', 0);
  disableStarterButtons(true);

  try {
    const response = await fetch('/api/refresh-cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: currentRepo.owner,
        name: currentRepo.name
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to refresh cache');
    }

    // Poll for sync status
    pollSyncStatus();

  } catch (error) {
    console.error('Refresh cache error:', error);
    setSyncStatus('error', 'Failed to refresh cache: ' + error.message);
    hideProgress();
    isSyncing = false;
    refreshBtn.disabled = false;
    document.getElementById('refresh-dropdown-toggle').disabled = false;
    refreshBtn.classList.remove('spinning');
    disableStarterButtons(false);
  }
}

async function pollSyncStatus() {
  const interval = setInterval(async () => {
    try {
      const response = await fetch(`/api/sync/${currentRepo.owner}/${currentRepo.name}`);
      const data = await response.json();

      if (data.status === 'fetching' || data.status === 'summarizing' || data.status === 'generating-reports') {
        // Update progress bar with detailed information
        const stage = data.stage || 'Processing...';
        const percentage = data.percentage || 0;

        setSyncStatus('syncing', stage);
        updateProgress(stage, percentage);
      } else if (data.status === 'complete') {
        clearInterval(interval);
        const statusMessage = data.message || `Ready! ${data.issuesCount} issues synced`;
        setSyncStatus('complete', statusMessage);
        hideProgress();
        isSyncing = false;
        refreshBtn.disabled = false;
        document.getElementById('refresh-dropdown-toggle').disabled = false;
        refreshBtn.classList.remove('spinning');
        disableStarterButtons(false);

        // Reload current page data so user sees fresh results
        if (currentPage === 'issues') loadIssues();
        else if (currentPage === 'insights') loadInsights();
        else if (currentPage === 'wip') loadWIP();
      } else if (data.status === 'error') {
        clearInterval(interval);
        showSyncError(data);
        hideProgress();
        isSyncing = false;
        refreshBtn.disabled = false;
        document.getElementById('refresh-dropdown-toggle').disabled = false;
        refreshBtn.classList.remove('spinning');
        disableStarterButtons(false);
      }
    } catch (error) {
      console.error('Poll error:', error);
    }
  }, 1000); // Poll more frequently for smoother progress updates
}

async function checkSyncStatus() {
  try {
    const response = await fetch(`/api/sync/${currentRepo.owner}/${currentRepo.name}`);
    const data = await response.json();

    if (data.status === 'fetching' || data.status === 'summarizing' || data.status === 'generating-reports') {
      isSyncing = true;
      showProgress(data.stage || 'Syncing...', data.percentage || 0);
      pollSyncStatus();
    } else {
      setSyncStatus('complete', 'Repository data loaded');
      hideProgress();
    }
  } catch (error) {
    // No active sync
    setSyncStatus('complete', 'Repository data loaded');
    hideProgress();
  }
}

async function handleStarterButton(type) {
  if (isProcessing || isSyncing) return;

  const labels = {
    'quick-sitrep': '⚡️ Quick Sitrep',
    'recent-bugs': '🚨 Recent Bugs',
    'zombie-tickets': '🧟 Zombie Tickets'
  };

  addMessage('user', labels[type]);
  addLoadingMessage();

  isProcessing = true;
  disableStarterButtons(true);
  sendBtn.disabled = true;

  try {
    const response = await fetch(`/api/report/${currentRepo.owner}/${currentRepo.name}/${type}`);
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
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: currentRepo.owner,
        name: currentRepo.name,
        question
      })
    });

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
    // Convert issue numbers to markdown links before rendering
    const linkedContent = content.replace(/#(\d+)/g, (match, number) => {
      const url = `https://github.com/${currentRepo.owner}/${currentRepo.name}/issues/${number}`;
      return `[${match}](${url})`;
    });

    // Render markdown and sanitize
    const rawHtml = marked.parse(linkedContent);
    contentDiv.innerHTML = DOMPurify.sanitize(rawHtml);

    // Open all links in new tabs
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

function showConfigSection() {
  configSection.style.display = 'flex';
  appSection.style.display = 'none';
  repoInput.value = '';
  setRepoBtn.disabled = false;
  setRepoBtn.textContent = 'Connect';
  hideError();
}

function showChatSection() {
  configSection.style.display = 'none';
  appSection.style.display = 'flex';
  repoNameDisplay.textContent = `${currentRepo.owner}/${currentRepo.name}`;
}

async function loadIssues() {
  const tbody = document.getElementById('issues-tbody');
  tbody.innerHTML = '<tr><td colspan="9" class="loading-cell"><div class="loading-spinner"></div>Loading issues...</td></tr>';

  try {
    const stateFilter = document.getElementById('state-filter').value || 'open';
    const response = await fetch(`/api/issues/${currentRepo.owner}/${currentRepo.name}?state=${stateFilter}&limit=500`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load issues');
    }

    allIssues = data.issues;

    // Diagnostic: log project data from API response
    const withStatus = allIssues.filter(i => i.project_status);
    const withSprint = allIssues.filter(i => i.sprint);
    const withAssignees = allIssues.filter(i => i.assignees && i.assignees !== '[]');
    console.log(`[loadIssues] ${allIssues.length} issues loaded. ${withStatus.length} with project_status, ${withSprint.length} with sprint, ${withAssignees.length} with assignees`);
    if (withStatus.length > 0) {
      console.log(`[loadIssues] Sample with status:`, withStatus[0].number, withStatus[0].project_status, withStatus[0].sprint);
    } else if (allIssues.length > 0) {
      console.log(`[loadIssues] First issue keys:`, Object.keys(allIssues[0]).join(', '));
      console.log(`[loadIssues] First issue project_status:`, JSON.stringify(allIssues[0].project_status));
    }

    // Populate filter dropdowns with unique values
    populateFilterDropdowns();

    filterIssues();
  } catch (error) {
    console.error('Error loading issues:', error);
    tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">Error loading issues: ${error.message}</td></tr>`;
  }
}

function populateFilterDropdowns() {
  // Get unique statuses
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
      } catch (e) {
        // Ignore parse errors
      }
    }
  });

  // Populate status filter
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

  // Populate sprint filter
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

  // Populate assignee filter
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
  const stateFilter = document.getElementById('state-filter').value;
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
      case 'updated_at':
        valA = new Date(a.updated_at).getTime();
        valB = new Date(b.updated_at).getTime();
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

  if (filteredIssues.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No issues found</td></tr>';
    return;
  }

  tbody.innerHTML = filteredIssues.map(issue => {
    const issueUrl = `https://github.com/${currentRepo.owner}/${currentRepo.name}/issues/${issue.number}`;
    const severityClass = issue.severity ? `severity-${issue.severity}` : '';
    const stateClass = `state-${issue.state}`;
    const updatedDate = new Date(issue.updated_at).toLocaleDateString();

    // Parse assignees (stored as JSON string)
    let assigneeList = '—';
    if (issue.assignees) {
      try {
        const assigneesArray = typeof issue.assignees === 'string' ? JSON.parse(issue.assignees) : issue.assignees;
        assigneeList = assigneesArray.length > 0 ? assigneesArray.join(', ') : '—';
      } catch (e) {
        assigneeList = '—';
      }
    }

    return `
      <tr>
        <td><span class="issue-number">#${issue.number}</span></td>
        <td>${issue.severity ? `<span class="severity-badge ${severityClass}">${issue.severity}</span>` : '<span class="severity-badge">—</span>'}</td>
        <td><span class="status-badge">${escapeHtml(issue.project_status || '—')}</span></td>
        <td><a href="${issueUrl}" target="_blank" class="issue-title">${escapeHtml(issue.title)}</a></td>
        <td><div class="issue-summary">${escapeHtml(issue.summary || 'No summary available')}</div></td>
        <td><span class="sprint-badge">${escapeHtml(issue.sprint || '—')}</span></td>
        <td><span class="assignee-badge">${assigneeList}</span></td>
        <td><span class="state-badge ${stateClass}">${issue.state}</span></td>
        <td><span class="issue-date">${updatedDate}</span></td>
      </tr>
    `;
  }).join('');
}

async function loadInsights() {
  const insightsContent = document.getElementById('insights-content');
  insightsContent.innerHTML = '<div class="loading-cell"><div class="loading-spinner"></div>Loading insights...</div>';

  try {
    const response = await fetch(`/api/insights/${currentRepo.owner}/${currentRepo.name}`);
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
  const { stats, severityBreakdown, recentActivity, lastSynced } = data;
  const insightsContent = document.getElementById('insights-content');

  const lastSyncedDate = new Date(lastSynced).toLocaleString();

  // Calculate max count for severity bar scaling
  const maxCount = Math.max(...Object.values(severityBreakdown), 1);

  // Determine if P0-P2 issues exist (above no-ship threshold)
  const criticalIssues = (severityBreakdown.P0 || 0) + (severityBreakdown.P1 || 0) + (severityBreakdown.P2 || 0);

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
      <p class="info-text">Issues are automatically classified by AI based on severity. P0-P2 are above the no-ship threshold.</p>

      <div class="severity-bars">
        ${renderSeverityBar('P0', severityBreakdown.P0 || 0, maxCount, '#ef4444')}
        ${renderSeverityBar('P1', severityBreakdown.P1 || 0, maxCount, '#f59e0b')}
        ${renderSeverityBar('P2', severityBreakdown.P2 || 0, maxCount, '#fbbf24')}

        <div class="no-ship-line">⚠️ No-Ship Threshold</div>

        ${renderSeverityBar('P3', severityBreakdown.P3 || 0, maxCount, '#3b82f6')}
        ${renderSeverityBar('P4', severityBreakdown.P4 || 0, maxCount, '#9ca3af')}
      </div>

      ${criticalIssues > 0 ? `
        <p class="info-text" style="margin-top: 1.5rem; color: var(--error);">
          ⚠️ <strong>${criticalIssues} critical issue(s)</strong> are above the no-ship threshold and should be addressed before release.
        </p>
      ` : `
        <p class="info-text" style="margin-top: 1.5rem; color: var(--success);">
          ✓ No critical issues above the no-ship threshold. All P0-P2 issues have been resolved.
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
  `;
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

async function loadWIP() {
  const wipContent = document.getElementById('wip-content');
  wipContent.innerHTML = '<div class="loading-cell"><div class="loading-spinner"></div>Loading WIP summary...</div>';

  try {
    const response = await fetch(`/api/wip/${currentRepo.owner}/${currentRepo.name}`);
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
        <h3>🔨 What Engineers Are Building</h3>
        <div class="wip-text">${DOMPurify.sanitize(marked.parse(data.summary))}</div>
      </div>

      ${data.byEngineer && data.byEngineer.length > 0 ? `
        <div class="wip-section">
          <h3>👥 By Engineer</h3>
          <div class="engineer-list">
            ${data.byEngineer.map(eng => `
              <div class="engineer-item">
                <div class="engineer-name">${escapeHtml(eng.assignee)}</div>
                <ul class="engineer-tasks">
                  ${eng.issues.map(issue => `
                    <li>
                      <a href="${issue.html_url}" target="_blank" class="issue-link">
                        #${issue.number}
                      </a>
                      ${escapeHtml(issue.title)}
                      ${issue.project_status ? `<span class="status-badge-inline">${escapeHtml(issue.project_status)}</span>` : ''}
                    </li>
                  `).join('')}
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
    // Show a helpful error message in the chat as an assistant message
    const errorMessage = `⚠️ GitHub API Rate Limit Exceeded\n\n${errorData.error}`;
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
