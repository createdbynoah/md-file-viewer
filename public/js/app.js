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
const copyMdBtn = document.getElementById('copy-md-btn');
const viewerTitle = document.getElementById('viewer-title');
const hljsThemeLink = document.getElementById('hljs-theme');
const folderList = document.getElementById('folder-list');
const createFolderBtn = document.getElementById('create-folder-btn');
const folderBtn = document.getElementById('folder-btn');
const folderDropdown = document.getElementById('folder-dropdown');

let foldersData = [];
let currentFileId = null;
let currentFileSource = null;
let currentRawMarkdown = null;
let currentFilename = null;

// ── Client-side routing ─────────────────────────────────────────────────────

const UUID_RE = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function getFileIdFromPath() {
  const match = location.pathname.match(UUID_RE);
  return match ? match[1] : null;
}

function pushUrl(path) {
  if (location.pathname !== path) {
    history.pushState(null, '', path);
  }
}

function extractTitle(markdown) {
  const match = markdown.match(/^#{1,6}\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

window.addEventListener('popstate', () => {
  const id = getFileIdFromPath();
  if (id) {
    viewFile(id, { updateUrl: false });
  } else {
    showInputArea({ updateUrl: false });
  }
});

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
  loadFolders();
  loadHistory();
  const deepLinkId = getFileIdFromPath();
  if (deepLinkId) {
    viewFile(deepLinkId, { updateUrl: false });
  }
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
    ? 'https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github-dark.min.css'
    : 'https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/github.min.css';
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

function isMobile() {
  return window.matchMedia('(max-width: 767px)').matches;
}

function openSidebar() {
  sidebar.classList.add('open');
  if (isMobile()) sidebarOverlay.hidden = false;
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

function createFolderBadgeSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z');
  svg.appendChild(path);
  return svg;
}

function renderHistoryList(history) {
  historyList.textContent = '';

  if (history.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'No history yet';
    historyList.appendChild(empty);
    return;
  }

  for (const entry of history) {
    const li = document.createElement('li');
    li.addEventListener('click', () => viewFile(entry.id));

    li.draggable = true;
    li.dataset.fileId = entry.id;
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', entry.id);
      e.dataTransfer.effectAllowed = 'move';
    });

    const sourceTag = document.createElement('span');
    sourceTag.className = 'history-source';
    sourceTag.textContent = entry.source === 'paste' ? 'paste' : 'file';

    const name = document.createElement('span');
    name.className = 'history-name';
    name.textContent = entry.filename;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'history-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = 'Remove from history';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api('/api/history/' + encodeURIComponent(entry.id), { method: 'DELETE' });
      loadHistory();
    });

    li.append(sourceTag, name);

    if (entry.folderId) {
      const badge = document.createElement('span');
      badge.className = 'history-folder-badge';
      badge.title = 'In a folder';
      badge.appendChild(createFolderBadgeSvg());
      li.appendChild(badge);
    }

    li.appendChild(removeBtn);
    historyList.appendChild(li);
  }
}

clearHistoryBtn.addEventListener('click', async () => {
  await api('/api/history', { method: 'DELETE' });
  loadHistory();
});

// ── Folders ──────────────────────────────────────────────────────────────────

async function loadFolders() {
  try {
    const res = await api('/api/folders');
    foldersData = await res.json();
    renderFolderList(foldersData);
  } catch {}
}

function createChevronSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M9 6l6 6-6 6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '3');
  svg.appendChild(path);
  return svg;
}

function renderFolderList(folders) {
  folderList.textContent = '';

  if (folders.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'folder-empty';
    empty.textContent = 'No folders yet';
    folderList.appendChild(empty);
    return;
  }

  const expandedState = JSON.parse(localStorage.getItem('folderExpandState') || '{}');

  for (const folder of folders) {
    const li = document.createElement('li');
    li.className = 'folder-item';
    li.dataset.folderId = folder.id;

    const isExpanded = expandedState[folder.id] === true;

    const header = document.createElement('div');
    header.className = 'folder-header';

    const chevron = document.createElement('span');
    chevron.className = 'folder-chevron' + (isExpanded ? ' expanded' : '');
    chevron.appendChild(createChevronSvg());

    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;

    const count = document.createElement('span');
    count.className = 'folder-count';
    count.textContent = '(' + folder.files.length + ')';

    const actions = document.createElement('span');
    actions.className = 'folder-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'folder-action-btn';
    renameBtn.title = 'Rename folder';
    renameBtn.textContent = '\u270E';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startFolderRename(folder, name);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'folder-action-btn danger';
    deleteBtn.title = 'Delete folder';
    deleteBtn.textContent = '\u00D7';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFolder(folder);
    });

    actions.append(renameBtn, deleteBtn);
    header.append(chevron, name, count, actions);

    header.addEventListener('click', () => {
      const state = JSON.parse(localStorage.getItem('folderExpandState') || '{}');
      state[folder.id] = !isExpanded;
      localStorage.setItem('folderExpandState', JSON.stringify(state));
      renderFolderList(foldersData);
    });

    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      header.classList.add('drag-over');
    });

    header.addEventListener('dragleave', () => {
      header.classList.remove('drag-over');
    });

    header.addEventListener('drop', async (e) => {
      e.preventDefault();
      header.classList.remove('drag-over');
      const fileId = e.dataTransfer.getData('text/plain');
      const sourceFolderId = e.dataTransfer.getData('application/x-source-folder');
      if (!fileId) return;

      if (sourceFolderId && sourceFolderId !== folder.id) {
        await api('/api/folders/' + encodeURIComponent(sourceFolderId) + '/files/' + encodeURIComponent(fileId) + '/move', {
          method: 'POST',
          body: JSON.stringify({ targetFolderId: folder.id }),
        });
      } else if (!sourceFolderId) {
        await api('/api/folders/' + encodeURIComponent(folder.id) + '/files', {
          method: 'POST',
          body: JSON.stringify({ fileId }),
        });
      }
      loadFolders();
      loadHistory();
    });

    li.appendChild(header);

    if (isExpanded) {
      const fileUl = document.createElement('ul');
      fileUl.className = 'folder-files';

      for (const file of folder.files) {
        const fileLi = document.createElement('li');
        fileLi.className = 'folder-file-item';
        fileLi.addEventListener('click', () => viewFile(file.id));

        fileLi.draggable = true;
        fileLi.dataset.fileId = file.id;
        fileLi.dataset.sourceFolderId = folder.id;
        fileLi.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', file.id);
          e.dataTransfer.setData('application/x-source-folder', folder.id);
          e.dataTransfer.effectAllowed = 'move';
        });

        const fileName = document.createElement('span');
        fileName.className = 'folder-file-name';
        fileName.textContent = file.filename;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'folder-file-remove';
        removeBtn.textContent = '\u00D7';
        removeBtn.title = 'Remove from folder';
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await api('/api/folders/' + encodeURIComponent(folder.id) + '/files/' + encodeURIComponent(file.id), { method: 'DELETE' });
          loadFolders();
        });

        fileLi.append(fileName, removeBtn);
        fileUl.appendChild(fileLi);
      }

      li.appendChild(fileUl);
    }

    folderList.appendChild(li);
  }
}

createFolderBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'folder-inline-input';
  input.placeholder = 'Folder name...';

  const li = document.createElement('li');
  li.className = 'folder-item';
  li.appendChild(input);
  folderList.prepend(li);
  input.focus();

  let saving = false;
  async function save() {
    if (saving) return;
    saving = true;
    const name = input.value.trim();
    if (!name) {
      li.remove();
      return;
    }
    await api('/api/folders', { method: 'POST', body: JSON.stringify({ name }) });
    loadFolders();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') li.remove();
  });
  input.addEventListener('blur', save);
});

function startFolderRename(folder, nameEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'folder-inline-input';
  input.value = folder.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let saving = false;
  async function save() {
    if (saving) return;
    saving = true;
    const newName = input.value.trim();
    if (!newName || newName === folder.name) {
      input.replaceWith(nameEl);
      return;
    }
    await api('/api/folders/' + encodeURIComponent(folder.id), {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    });
    loadFolders();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { input.replaceWith(nameEl); }
  });
  input.addEventListener('blur', save);
}

async function deleteFolder(folder) {
  if (!confirm('Delete "' + folder.name + '" and ' + folder.files.length + ' file(s)?')) return;
  await api('/api/folders/' + encodeURIComponent(folder.id), { method: 'DELETE' });
  loadFolders();
  loadHistory();
}

// ── Viewer folder button ────────────────────────────────────────────────────

folderBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!folderDropdown.hidden) {
    folderDropdown.hidden = true;
    return;
  }
  renderFolderDropdown();
  folderDropdown.hidden = false;
});

document.addEventListener('click', () => {
  folderDropdown.hidden = true;
});

function renderFolderDropdown() {
  folderDropdown.textContent = '';

  const currentFolderId = getCurrentFileFolderId();

  if (currentFolderId) {
    const removeOpt = document.createElement('button');
    removeOpt.className = 'folder-dropdown-item';
    removeOpt.textContent = 'Remove from folder';
    removeOpt.addEventListener('click', async () => {
      await api('/api/folders/' + encodeURIComponent(currentFolderId) + '/files/' + encodeURIComponent(currentFileId), { method: 'DELETE' });
      folderDropdown.hidden = true;
      loadFolders();
      loadHistory();
    });
    folderDropdown.appendChild(removeOpt);

    const sep = document.createElement('div');
    sep.className = 'folder-dropdown-sep';
    folderDropdown.appendChild(sep);
  }

  for (const folder of foldersData) {
    const opt = document.createElement('button');
    opt.className = 'folder-dropdown-item';
    if (folder.id === currentFolderId) opt.classList.add('active');
    opt.textContent = folder.name;
    opt.addEventListener('click', async () => {
      if (folder.id === currentFolderId) return;
      await api('/api/folders/' + encodeURIComponent(folder.id) + '/files', {
        method: 'POST',
        body: JSON.stringify({ fileId: currentFileId }),
      });
      folderDropdown.hidden = true;
      loadFolders();
      loadHistory();
    });
    folderDropdown.appendChild(opt);
  }

  const sep2 = document.createElement('div');
  sep2.className = 'folder-dropdown-sep';
  folderDropdown.appendChild(sep2);

  const newFolderOpt = document.createElement('button');
  newFolderOpt.className = 'folder-dropdown-item';
  newFolderOpt.textContent = '+ New folder';
  newFolderOpt.addEventListener('click', async () => {
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;
    const res = await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    if (res.ok) {
      const folder = await res.json();
      await api('/api/folders/' + encodeURIComponent(folder.id) + '/files', {
        method: 'POST',
        body: JSON.stringify({ fileId: currentFileId }),
      });
      folderDropdown.hidden = true;
      loadFolders();
      loadHistory();
    }
  });
  folderDropdown.appendChild(newFolderOpt);
}

function getCurrentFileFolderId() {
  if (!currentFileId) return null;
  for (const folder of foldersData) {
    if (folder.files.some((f) => f.id === currentFileId)) return folder.id;
  }
  return null;
}

// ── File viewing ────────────────────────────────────────────────────────────

async function viewFile(id, { updateUrl = true } = {}) {
  try {
    const res = await api(`/api/files/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const data = await res.json();
    currentRawMarkdown = data.content;
    renderMarkdown(data.content, data.filename, id);
    currentFileId = id;
    currentFileSource = 'upload';
    deleteFileBtn.hidden = false;
    copyMdBtn.hidden = false;
    folderBtn.hidden = false;
    if (updateUrl) pushUrl(`/${id}`);
    closeSidebar();
    loadHistory();
    loadFolders();
  } catch {}
}

function renderMarkdown(content, title, id) {
  renderedOutput.innerHTML = md.render(content);
  addCodeCopyButtons();
  viewerTitle.textContent = title || 'Markdown Viewer';
  currentFilename = title || 'Markdown Viewer';
  viewerTitle.setAttribute('data-editable', id ? 'true' : 'false');
  inputArea.hidden = true;
  viewerArea.hidden = false;
}

function addCodeCopyButtons() {
  for (const pre of renderedOutput.querySelectorAll('pre')) {
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
    pre.appendChild(btn);
  }
}

function showInputArea({ updateUrl = true } = {}) {
  inputArea.hidden = false;
  viewerArea.hidden = true;
  viewerTitle.textContent = 'Markdown Viewer';
  viewerTitle.setAttribute('data-editable', 'false');
  currentFileId = null;
  currentFileSource = null;
  currentRawMarkdown = null;
  currentFilename = null;
  copyMdBtn.hidden = true;
  folderBtn.hidden = true;
  folderDropdown.hidden = true;
  if (updateUrl) pushUrl('/');
}

backBtn.addEventListener('click', showInputArea);

copyMdBtn.addEventListener('click', () => {
  if (!currentRawMarkdown) return;
  navigator.clipboard.writeText(currentRawMarkdown);
  const orig = copyMdBtn.textContent;
  copyMdBtn.textContent = 'Copied!';
  setTimeout(() => { copyMdBtn.textContent = orig; }, 1500);
});

deleteFileBtn.addEventListener('click', async () => {
  if (!currentFileId) return;
  if (!confirm('Delete this file?')) return;
  await api(`/api/files/${encodeURIComponent(currentFileId)}`, { method: 'DELETE' });
  showInputArea();
  loadHistory();
  loadFolders();
});

// ── Inline title rename ──────────────────────────────────────────────────

viewerTitle.addEventListener('click', () => {
  if (viewerTitle.getAttribute('data-editable') !== 'true' || !currentFileId) return;

  const previous = currentFilename;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'topbar-title-input';
  input.value = previous;

  const sizer = document.createElement('span');
  sizer.className = 'topbar-title-input';
  sizer.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  document.body.appendChild(sizer);

  function resizeInput() {
    sizer.textContent = input.value || ' ';
    input.style.width = sizer.scrollWidth + 2 + 'px';
  }

  viewerTitle.replaceWith(input);
  resizeInput();
  input.focus();
  input.select();

  input.addEventListener('input', resizeInput);

  function cleanup() {
    sizer.remove();
  }

  async function save() {
    const newName = input.value.trim();
    if (!newName || newName === previous) {
      input.replaceWith(viewerTitle);
      cleanup();
      return;
    }
    try {
      const res = await api(`/api/files/${encodeURIComponent(currentFileId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ filename: newName }),
      });
      if (res.ok) {
        currentFilename = newName;
        viewerTitle.textContent = newName;
        loadHistory();
        loadFolders();
      }
    } catch {}
    input.replaceWith(viewerTitle);
    cleanup();
  }

  function cancel() {
    input.replaceWith(viewerTitle);
    cleanup();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      cancel();
    }
  });

  input.addEventListener('blur', save);
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
    const title = extractTitle(content);
    const res = await api('/api/paste', {
      method: 'POST',
      body: JSON.stringify({ content, title }),
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
