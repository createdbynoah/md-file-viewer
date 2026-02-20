// ── Markdown-it setup ───────────────────────────────────────────────────────

const md = window.markdownit({
  html: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch {}
    }
    return '';
  },
});

// ── DOM refs ────────────────────────────────────────────────────────────────

const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const themeToggle = document.getElementById('theme-toggle');
const themeIconSun = document.getElementById('theme-icon-sun');
const themeIconMoon = document.getElementById('theme-icon-moon');
const logoutBtn = document.getElementById('logout-btn');
const historyList = document.getElementById('history-list');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const pasteInput = document.getElementById('paste-input');
const renderBtn = document.getElementById('render-btn');
const inputArea = document.getElementById('input-area');
const viewerArea = document.getElementById('viewer-area');
const renderedOutput = document.getElementById('rendered-output');
const backBtn = document.getElementById('back-btn');
const deleteFileBtn = document.getElementById('delete-file-btn');
const viewerTitle = document.getElementById('viewer-title');
const hljsThemeLink = document.getElementById('hljs-theme');

let currentFileId = null;
let currentFileSource = null;

// ── API helpers ─────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (res.status === 401 && !path.includes('/auth/')) {
    showLogin();
    throw new Error('Unauthorized');
  }
  return res;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function checkAuth() {
  try {
    const res = await api('/api/auth/check');
    const data = await res.json();
    if (data.authenticated) {
      showApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showLogin() {
  loginScreen.hidden = false;
  appScreen.hidden = true;
}

function showApp() {
  loginScreen.hidden = true;
  appScreen.hidden = false;
  loadHistory();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: loginPassword.value }),
    });
    if (res.ok) {
      loginPassword.value = '';
      showApp();
    } else {
      loginError.hidden = false;
    }
  } catch {
    loginError.hidden = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  showLogin();
});

// ── Theme ───────────────────────────────────────────────────────────────────

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const isDark = theme === 'dark';
  themeIconSun.hidden = isDark;
  themeIconMoon.hidden = !isDark;
  hljsThemeLink.href = isDark
    ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css'
    : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css';
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ── Sidebar ─────────────────────────────────────────────────────────────────

function openSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.hidden = false;
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.hidden = true;
}

sidebarToggle.addEventListener('click', () => {
  if (sidebar.classList.contains('open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
});

sidebarOverlay.addEventListener('click', closeSidebar);

// ── History ─────────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await api('/api/history');
    const history = await res.json();
    renderHistoryList(history);
  } catch {}
}

function renderHistoryList(history) {
  historyList.innerHTML = '';

  if (history.length === 0) {
    historyList.innerHTML = '<li class="history-empty">No history yet</li>';
    return;
  }

  for (const entry of history) {
    const li = document.createElement('li');
    li.addEventListener('click', () => viewFile(entry.id));

    const sourceTag = document.createElement('span');
    sourceTag.className = 'history-source';
    sourceTag.textContent = entry.source === 'watch' ? 'watch' : entry.source === 'paste' ? 'paste' : 'file';

    const name = document.createElement('span');
    name.className = 'history-name';
    name.textContent = entry.filename;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'history-remove';
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Remove from history';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/history/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      loadHistory();
    });

    li.append(sourceTag, name, removeBtn);
    historyList.appendChild(li);
  }
}

clearHistoryBtn.addEventListener('click', async () => {
  await api('/api/history', { method: 'DELETE' });
  loadHistory();
});

// ── File viewing ────────────────────────────────────────────────────────────

async function viewFile(id) {
  try {
    const res = await api(`/api/files/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const data = await res.json();
    renderMarkdown(data.content, data.filename, id);
    currentFileId = id;
    currentFileSource = id.startsWith('watch:') ? 'watch' : 'upload';
    deleteFileBtn.hidden = currentFileSource === 'watch';
    closeSidebar();
    loadHistory();
  } catch {}
}

function renderMarkdown(content, title, id) {
  renderedOutput.innerHTML = md.render(content);
  viewerTitle.textContent = title || 'Markdown Viewer';
  inputArea.hidden = true;
  viewerArea.hidden = false;
}

function showInputArea() {
  inputArea.hidden = false;
  viewerArea.hidden = true;
  viewerTitle.textContent = 'Markdown Viewer';
  currentFileId = null;
  currentFileSource = null;
}

backBtn.addEventListener('click', showInputArea);

deleteFileBtn.addEventListener('click', async () => {
  if (!currentFileId || currentFileSource === 'watch') return;
  if (!confirm('Delete this file?')) return;
  await api(`/api/files/${encodeURIComponent(currentFileId)}`, { method: 'DELETE' });
  showInputArea();
  loadHistory();
});

// ── Drop zone ───────────────────────────────────────────────────────────────

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) {
    uploadFile(fileInput.files[0]);
    fileInput.value = '';
  }
});

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) return;
    const data = await res.json();
    viewFile(data.id);
  } catch {}
}

// ── Paste render ────────────────────────────────────────────────────────────

renderBtn.addEventListener('click', async () => {
  const content = pasteInput.value.trim();
  if (!content) return;
  try {
    const res = await api('/api/paste', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    if (!res.ok) return;
    const data = await res.json();
    pasteInput.value = '';
    viewFile(data.id);
  } catch {}
});

// Allow Ctrl/Cmd+Enter to render
pasteInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    renderBtn.click();
  }
});

// ── Init ────────────────────────────────────────────────────────────────────

initTheme();
checkAuth();
