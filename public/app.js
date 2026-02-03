// State management
let currentRepo = null;
let isSyncing = false;
let isProcessing = false;

// DOM elements
const configSection = document.getElementById('config-section');
const chatSection = document.getElementById('chat-section');
const repoInput = document.getElementById('repo-input');
const setRepoBtn = document.getElementById('set-repo-btn');
const configError = document.getElementById('config-error');
const repoNameDisplay = document.getElementById('repo-name');
const changeRepoBtn = document.getElementById('change-repo-btn');
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
      throw new Error(data.error || 'Repository not found');
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
        setSyncStatus('complete', `Ready! ${data.issuesCount} issues synced`);
        hideProgress();
        isSyncing = false;
        disableStarterButtons(false);
      } else if (data.status === 'error') {
        clearInterval(interval);
        showSyncError(data);
        hideProgress();
        isSyncing = false;
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

  // Convert issue numbers to links
  const linkedContent = content.replace(/#(\d+)/g, (match, number) => {
    const url = `https://github.com/${currentRepo.owner}/${currentRepo.name}/issues/${number}`;
    return `<a href="${url}" target="_blank">${match}</a>`;
  });

  contentDiv.innerHTML = linkedContent;

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
  chatSection.style.display = 'none';
  repoInput.value = '';
  setRepoBtn.disabled = false;
  setRepoBtn.textContent = 'Connect';
  hideError();
}

function showChatSection() {
  configSection.style.display = 'none';
  chatSection.style.display = 'flex';
  repoNameDisplay.textContent = `${currentRepo.owner}/${currentRepo.name}`;
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
