# Folder Grouping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add named, collapsible folders to the sidebar so users can organize markdown files into groups, with full CRUD, drag-and-drop, and retention exemption.

**Architecture:** New `folders` KV key in the existing `HISTORY` namespace stores folder metadata with denormalized `fileIds`. File metadata gains an optional `folderId` field. Seven new API routes under `/api/folders`. Frontend adds a Folders section above History in the sidebar, a folder toolbar button in the viewer, drag-and-drop on desktop, and context menus for mobile.

**Tech Stack:** Hono (backend), Vanilla JS (frontend), Cloudflare Workers KV + R2

**Security note:** All `innerHTML` usage in this plan is for hardcoded SVG icons and static content only — never for user-supplied data. User-provided text (folder names, filenames) must always use `textContent`.

---

## Task 1: Backend — Folder KV helpers

**Files:**
- Modify: `src/worker.js:34-67` (after history helpers section)

**Step 1: Add folder read/write helpers after the history helpers block (after line 67)**

Add these functions between the history helpers and the KV metadata scan helper:

```javascript
// ── Folder helpers ──────────────────────────────────────────────────────────

function generateFolderId() {
  return 'f-' + crypto.randomUUID().slice(0, 8);
}

async function readFolders(kv) {
  const data = await kv.get('folders');
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeFolders(kv, folders) {
  await kv.put('folders', JSON.stringify(folders));
}
```

**Step 2: Verify syntax**

Run: `cd /Users/noahr/development/md-file-viewer/.worktrees/feat-folder-grouping && node -c src/worker.js`
Expected: No errors

**Step 3: Commit**

```bash
git add src/worker.js
git commit -m "feat(folders): add KV read/write helpers for folders"
```

---

## Task 2: Backend — CRUD routes (create, list, rename, delete)

**Files:**
- Modify: `src/worker.js` (add routes after history routes, before SPA fallback at line 345)

**Step 1: Add GET /api/folders route**

Insert before the SPA fallback comment block. This route lists all folders with enriched file metadata:

```javascript
// ── Folder routes ───────────────────────────────────────────────────────────

app.get('/api/folders', async (c) => {
  const folders = await readFolders(c.env.HISTORY);
  const allMeta = await listAllMeta(c.env.HISTORY);

  const enriched = folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    created: folder.created,
    files: folder.fileIds
      .map((fid) => {
        const meta = allMeta.get(fid);
        if (!meta) return null;
        return { id: fid, filename: meta.filename, source: meta.source, size: meta.size };
      })
      .filter(Boolean),
  }));

  return c.json(enriched);
});
```

**Step 2: Add POST /api/folders route**

```javascript
app.post('/api/folders', async (c) => {
  const { name } = await c.req.json();
  if (!name || !name.trim()) {
    return c.json({ error: 'Folder name is required' }, 400);
  }

  const folder = {
    id: generateFolderId(),
    name: name.trim(),
    fileIds: [],
    created: new Date().toISOString(),
  };

  const folders = await readFolders(c.env.HISTORY);
  folders.push(folder);
  await writeFolders(c.env.HISTORY, folders);

  return c.json(folder, 201);
});
```

**Step 3: Add PATCH /api/folders/:id route**

```javascript
app.patch('/api/folders/:id', async (c) => {
  const id = c.req.param('id');
  const { name } = await c.req.json();
  if (!name || !name.trim()) {
    return c.json({ error: 'Folder name is required' }, 400);
  }

  const folders = await readFolders(c.env.HISTORY);
  const folder = folders.find((f) => f.id === id);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  folder.name = name.trim();
  await writeFolders(c.env.HISTORY, folders);

  return c.json(folder);
});
```

**Step 4: Add DELETE /api/folders/:id route**

This deletes the folder AND all files inside it (R2 content + KV metadata + history entries):

```javascript
app.delete('/api/folders/:id', async (c) => {
  const id = c.req.param('id');
  const folders = await readFolders(c.env.HISTORY);
  const folder = folders.find((f) => f.id === id);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  // Delete all contained files
  for (const fid of folder.fileIds) {
    await c.env.MD_FILES.delete(`${fid}.md`);
    await c.env.HISTORY.delete(`meta:${fid}`);
  }

  // Clean up history entries for deleted files
  if (folder.fileIds.length > 0) {
    const deleted = new Set(folder.fileIds);
    const history = await readHistory(c.env.HISTORY);
    await writeHistory(c.env.HISTORY, history.filter((h) => !deleted.has(h.id)));
  }

  // Remove the folder itself
  await writeFolders(c.env.HISTORY, folders.filter((f) => f.id !== id));

  return c.json({ success: true });
});
```

**Step 5: Verify syntax**

Run: `node -c src/worker.js`

**Step 6: Commit**

```bash
git add src/worker.js
git commit -m "feat(folders): add CRUD API routes for folders"
```

---

## Task 3: Backend — File-folder membership routes

**Files:**
- Modify: `src/worker.js` (add routes after folder CRUD routes)

**Step 1: Add POST /api/folders/:id/files (add file to folder)**

```javascript
app.post('/api/folders/:id/files', async (c) => {
  const folderId = c.req.param('id');
  const { fileId } = await c.req.json();
  if (!fileId) return c.json({ error: 'fileId is required' }, 400);

  const folders = await readFolders(c.env.HISTORY);
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  // Check file exists
  const metaJson = await c.env.HISTORY.get(`meta:${fileId}`);
  if (!metaJson) return c.json({ error: 'File not found' }, 404);

  // Remove from any existing folder
  for (const f of folders) {
    f.fileIds = f.fileIds.filter((id) => id !== fileId);
  }

  // Add to target folder
  folder.fileIds.push(fileId);
  await writeFolders(c.env.HISTORY, folders);

  // Update file metadata
  const meta = JSON.parse(metaJson);
  meta.folderId = folderId;
  await c.env.HISTORY.put(`meta:${fileId}`, JSON.stringify(meta));

  return c.json({ success: true });
});
```

**Step 2: Add DELETE /api/folders/:id/files/:fileId (remove file from folder)**

```javascript
app.delete('/api/folders/:id/files/:fileId', async (c) => {
  const folderId = c.req.param('id');
  const fileId = c.req.param('fileId');

  const folders = await readFolders(c.env.HISTORY);
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  folder.fileIds = folder.fileIds.filter((id) => id !== fileId);
  await writeFolders(c.env.HISTORY, folders);

  // Clear folderId from file metadata
  const metaJson = await c.env.HISTORY.get(`meta:${fileId}`);
  if (metaJson) {
    try {
      const meta = JSON.parse(metaJson);
      delete meta.folderId;
      await c.env.HISTORY.put(`meta:${fileId}`, JSON.stringify(meta));
    } catch { /* ignore corrupt meta */ }
  }

  return c.json({ success: true });
});
```

**Step 3: Add POST /api/folders/:id/files/:fileId/move (move file between folders)**

```javascript
app.post('/api/folders/:id/files/:fileId/move', async (c) => {
  const sourceFolderId = c.req.param('id');
  const fileId = c.req.param('fileId');
  const { targetFolderId } = await c.req.json();
  if (!targetFolderId) return c.json({ error: 'targetFolderId is required' }, 400);

  const folders = await readFolders(c.env.HISTORY);
  const source = folders.find((f) => f.id === sourceFolderId);
  const target = folders.find((f) => f.id === targetFolderId);
  if (!source || !target) return c.json({ error: 'Folder not found' }, 404);

  source.fileIds = source.fileIds.filter((id) => id !== fileId);
  if (!target.fileIds.includes(fileId)) target.fileIds.push(fileId);
  await writeFolders(c.env.HISTORY, folders);

  // Update file metadata
  const metaJson = await c.env.HISTORY.get(`meta:${fileId}`);
  if (metaJson) {
    try {
      const meta = JSON.parse(metaJson);
      meta.folderId = targetFolderId;
      await c.env.HISTORY.put(`meta:${fileId}`, JSON.stringify(meta));
    } catch { /* ignore corrupt meta */ }
  }

  return c.json({ success: true });
});
```

**Step 4: Verify syntax and commit**

Run: `node -c src/worker.js`

```bash
git add src/worker.js
git commit -m "feat(folders): add file-folder membership API routes"
```

---

## Task 4: Backend — Retention exemption + file delete cleanup

**Files:**
- Modify: `src/worker.js:95-123` (runRetention function)
- Modify: `src/worker.js:307-318` (DELETE /api/files/:id)

**Step 1: Replace runRetention function entirely**

The new version reads folders once at the top, skips files in valid folders, and clears stale folder references:

```javascript
async function runRetention(env) {
  const now = Date.now();
  const allMeta = await listAllMeta(env.HISTORY);
  const folders = await readFolders(env.HISTORY);
  const folderIds = new Set(folders.map((f) => f.id));
  const deletedIds = [];

  for (const [id, meta] of allMeta) {
    const ref = meta.lastAccessedAt || meta.created;
    if (!ref) continue;

    // Skip files in valid folders (exempt from retention)
    if (meta.folderId && folderIds.has(meta.folderId)) continue;

    // Clear stale folder references
    if (meta.folderId && !folderIds.has(meta.folderId)) {
      delete meta.folderId;
      await env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
    }

    const age = now - new Date(ref).getTime();

    if (age >= DELETE_MS) {
      await env.HISTORY.delete(`meta:${id}`);
      await env.MD_FILES.delete(`${id}.md`);
      deletedIds.push(id);
    } else if (age >= ARCHIVE_MS && !meta.archivedAt) {
      meta.archivedAt = new Date().toISOString();
      await env.HISTORY.put(`meta:${id}`, JSON.stringify(meta));
    }
  }

  if (deletedIds.length > 0) {
    const deleted = new Set(deletedIds);
    const history = await readHistory(env.HISTORY);
    await writeHistory(env.HISTORY, history.filter((h) => !deleted.has(h.id)));
  }
}
```

**Step 2: Replace DELETE /api/files/:id to add folder cleanup**

```javascript
app.delete('/api/files/:id', async (c) => {
  const id = c.req.param('id');

  await c.env.MD_FILES.delete(`${id}.md`);
  await c.env.HISTORY.delete(`meta:${id}`);

  // Remove from history
  const history = await readHistory(c.env.HISTORY);
  await writeHistory(c.env.HISTORY, history.filter((h) => h.id !== id));

  // Remove from any folder
  const folders = await readFolders(c.env.HISTORY);
  let foldersChanged = false;
  for (const folder of folders) {
    const before = folder.fileIds.length;
    folder.fileIds = folder.fileIds.filter((fid) => fid !== id);
    if (folder.fileIds.length !== before) foldersChanged = true;
  }
  if (foldersChanged) await writeFolders(c.env.HISTORY, folders);

  return c.json({ success: true });
});
```

**Step 3: Verify syntax and commit**

Run: `node -c src/worker.js`

```bash
git add src/worker.js
git commit -m "feat(folders): add retention exemption and file-delete folder cleanup"
```

---

## Task 5: Backend — Include folderId in history API response

**Files:**
- Modify: `src/worker.js` (GET /api/history route)

**Step 1: Enrich history entries with folderId**

Replace the GET /api/history route:

```javascript
app.get('/api/history', async (c) => {
  const history = await readHistory(c.env.HISTORY);
  const allMeta = await listAllMeta(c.env.HISTORY);

  return c.json(
    history
      .filter((h) => {
        const meta = allMeta.get(h.id);
        return meta && !meta.archivedAt;
      })
      .map((h) => {
        const meta = allMeta.get(h.id);
        return { ...h, folderId: meta?.folderId || null };
      }),
  );
});
```

**Step 2: Verify syntax and commit**

Run: `node -c src/worker.js`

```bash
git add src/worker.js
git commit -m "feat(folders): include folderId in history API response"
```

---

## Task 6: Frontend — Sidebar HTML + folder section rendering

**Files:**
- Modify: `public/index.html:70-76` (sidebar section)
- Modify: `public/js/app.js` (add folder DOM refs, loadFolders, renderFolderList)

**Step 1: Replace the sidebar `<aside>` content in `public/index.html` (lines 70-76)**

```html
<!-- Sidebar -->
<aside id="sidebar" class="sidebar">
  <div class="sidebar-section">
    <h2 class="sidebar-heading">Folders</h2>
    <button id="create-folder-btn" class="icon-btn sidebar-add-btn" aria-label="Create folder" title="New folder">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
  </div>
  <ul id="folder-list" class="folder-list"></ul>
  <div class="sidebar-section">
    <h2 class="sidebar-heading">History</h2>
    <button id="clear-history-btn" class="text-btn">Clear</button>
  </div>
  <ul id="history-list" class="history-list"></ul>
</aside>
```

**Step 2: Add folder DOM refs and state in app.js**

At the top of `public/js/app.js`, after the existing DOM refs (around line 44), add:

```javascript
const folderList = document.getElementById('folder-list');
const createFolderBtn = document.getElementById('create-folder-btn');

let foldersData = [];
```

**Step 3: Add loadFolders and renderFolderList functions**

Add after the history section (after line 251) in app.js. Note: All user-supplied text uses `textContent`, never `innerHTML`. The only `innerHTML` usage is for static SVG chevron icons.

```javascript
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

    // Folder header row
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
    renameBtn.textContent = '\u270E'; // pencil unicode
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startFolderRename(folder, name);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'folder-action-btn danger';
    deleteBtn.title = 'Delete folder';
    deleteBtn.textContent = '\u00D7'; // multiplication sign (x)
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFolder(folder);
    });

    actions.append(renameBtn, deleteBtn);
    header.append(chevron, name, count, actions);

    // Toggle expand/collapse
    header.addEventListener('click', () => {
      const state = JSON.parse(localStorage.getItem('folderExpandState') || '{}');
      state[folder.id] = !isExpanded;
      localStorage.setItem('folderExpandState', JSON.stringify(state));
      renderFolderList(foldersData);
    });

    li.appendChild(header);

    // File list inside folder (only if expanded)
    if (isExpanded) {
      const fileUl = document.createElement('ul');
      fileUl.className = 'folder-files';

      for (const file of folder.files) {
        const fileLi = document.createElement('li');
        fileLi.className = 'folder-file-item';
        fileLi.addEventListener('click', () => viewFile(file.id));

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
```

**Step 4: Add folder create/rename/delete functions**

```javascript
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

  async function save() {
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

  async function save() {
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
```

**Step 5: Call loadFolders in showApp**

In `showApp()`, add `loadFolders()` before `loadHistory()`:

```javascript
function showApp() {
  loginScreen.hidden = true;
  appScreen.hidden = false;
  loadFolders();
  loadHistory();
  const deepLinkId = getFileIdFromPath();
  if (deepLinkId) viewFile(deepLinkId, { updateUrl: false });
}
```

**Step 6: Verify syntax and commit**

```bash
node -c public/js/app.js
git add public/index.html public/js/app.js
git commit -m "feat(folders): add sidebar folder section with create/rename/delete"
```

---

## Task 7: Frontend — Folder CSS styles

**Files:**
- Modify: `public/css/style.css` (add after `.history-empty` block, around line 351)

**Step 1: Add folder styles**

Insert after the `.history-empty` rule:

```css
/* ── Folders ─────────────────────────────────────────────────────────────── */

.folder-list {
  list-style: none;
  padding: 0 8px 8px;
}

.folder-empty {
  padding: 16px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 0.8125rem;
}

.folder-item {
  margin-bottom: 2px;
}

.folder-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--text);
  transition: background 0.15s;
}

.folder-header:hover {
  background: var(--bg-tertiary);
}

.folder-chevron {
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform 0.15s;
  width: 14px;
  display: flex;
  align-items: center;
}

.folder-chevron.expanded {
  transform: rotate(90deg);
}

.folder-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.folder-count {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.folder-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.folder-header:hover .folder-actions {
  opacity: 1;
}

.folder-action-btn {
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 2px 4px;
  font-size: 0.8125rem;
  border-radius: 3px;
  transition: color 0.15s, background 0.15s;
}

.folder-action-btn:hover {
  color: var(--text);
  background: var(--border-light);
}

.folder-action-btn.danger:hover {
  color: var(--danger);
}

.folder-files {
  list-style: none;
  padding: 0 0 0 24px;
}

.folder-file-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  transition: background 0.15s;
}

.folder-file-item:hover {
  background: var(--bg-tertiary);
  color: var(--text);
}

.folder-file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-file-remove {
  opacity: 0;
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 2px;
  flex-shrink: 0;
  transition: opacity 0.15s, color 0.15s;
}

.folder-file-item:hover .folder-file-remove {
  opacity: 1;
}

.folder-file-remove:hover {
  color: var(--danger);
}

.folder-inline-input {
  width: 100%;
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  font-size: 0.875rem;
  font-family: inherit;
  background: var(--bg);
  color: var(--text);
  outline: none;
}

.sidebar-add-btn {
  width: 28px;
  height: 28px;
}

/* Folder badge in history items */
.history-folder-badge {
  font-size: 0.625rem;
  color: var(--text-tertiary);
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.history-folder-badge svg {
  width: 12px;
  height: 12px;
}
```

**Step 2: Commit**

```bash
git add public/css/style.css
git commit -m "feat(folders): add CSS styles for folder sidebar section"
```

---

## Task 8: Frontend — History folder badge

**Files:**
- Modify: `public/js/app.js` (renderHistoryList function)

**Step 1: Add a helper to create folder icon SVG elements**

```javascript
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
```

**Step 2: Update renderHistoryList to show folder badge**

Replace the `renderHistoryList` function. All user text uses `textContent`:

```javascript
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

    // Folder badge for files in a folder
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
```

**Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "feat(folders): show folder badge on history items"
```

---

## Task 9: Frontend — Viewer toolbar folder button

**Files:**
- Modify: `public/index.html:99-105` (viewer toolbar)
- Modify: `public/js/app.js` (add folder toolbar button logic)
- Modify: `public/css/style.css` (dropdown styles)

**Step 1: Add folder button to viewer toolbar HTML**

In `public/index.html`, replace the `.viewer-toolbar-right` div:

```html
<div class="viewer-toolbar-right">
  <div class="folder-dropdown-wrapper">
    <button id="folder-btn" class="text-btn" hidden>Move to Folder</button>
    <div id="folder-dropdown" class="folder-dropdown" hidden></div>
  </div>
  <button id="copy-md-btn" class="text-btn" hidden>Copy Markdown</button>
  <button id="delete-file-btn" class="text-btn danger">Delete</button>
</div>
```

**Step 2: Add DOM refs for folder button**

In `public/js/app.js`, add after existing DOM refs:

```javascript
const folderBtn = document.getElementById('folder-btn');
const folderDropdown = document.getElementById('folder-dropdown');
```

**Step 3: Add folder button click handler and dropdown logic**

```javascript
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

  // "Remove from folder" option if filed
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

  // List folders
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

  // "New folder" option
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
```

**Step 4: Show/hide folder button when viewing files**

In `viewFile()`, after `copyMdBtn.hidden = false;`, add:
```javascript
folderBtn.hidden = false;
```

In `showInputArea()`, after `copyMdBtn.hidden = true;`, add:
```javascript
folderBtn.hidden = true;
folderDropdown.hidden = true;
```

**Step 5: Add dropdown CSS styles to `public/css/style.css`**

```css
/* ── Folder dropdown (viewer toolbar) ────────────────────────────────────── */

.folder-dropdown-wrapper {
  position: relative;
}

.folder-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  min-width: 180px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  z-index: 50;
  padding: 4px;
}

.folder-dropdown-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--text);
  font-size: 0.8125rem;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
}

.folder-dropdown-item:hover {
  background: var(--bg-tertiary);
}

.folder-dropdown-item.active {
  color: var(--accent);
  font-weight: 500;
}

.folder-dropdown-sep {
  height: 1px;
  background: var(--border-light);
  margin: 4px 0;
}
```

**Step 6: Verify syntax and commit**

```bash
node -c public/js/app.js
git add public/index.html public/js/app.js public/css/style.css
git commit -m "feat(folders): add folder button and dropdown in viewer toolbar"
```

---

## Task 10: Frontend — Drag and drop (desktop)

**Files:**
- Modify: `public/js/app.js` (add drag/drop event listeners in render functions)
- Modify: `public/css/style.css` (drag-over visual feedback)

**Step 1: Make history items draggable**

In `renderHistoryList`, when creating each `li`, add after the click listener:
```javascript
li.draggable = true;
li.dataset.fileId = entry.id;
li.addEventListener('dragstart', (e) => {
  e.dataTransfer.setData('text/plain', entry.id);
  e.dataTransfer.effectAllowed = 'move';
});
```

**Step 2: Make folder file items draggable**

In `renderFolderList`, when creating each `fileLi` inside a folder, add after the click listener:
```javascript
fileLi.draggable = true;
fileLi.dataset.fileId = file.id;
fileLi.dataset.sourceFolderId = folder.id;
fileLi.addEventListener('dragstart', (e) => {
  e.dataTransfer.setData('text/plain', file.id);
  e.dataTransfer.setData('application/x-source-folder', folder.id);
  e.dataTransfer.effectAllowed = 'move';
});
```

**Step 3: Make folder headers drop targets**

In `renderFolderList`, after creating the `header` element and before `li.appendChild(header)`, add:

```javascript
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
```

**Step 4: Add drag-over CSS feedback**

In `public/css/style.css`:

```css
.folder-header.drag-over {
  background: var(--accent-subtle);
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}
```

**Step 5: Commit**

```bash
git add public/js/app.js public/css/style.css
git commit -m "feat(folders): add drag-and-drop for file-to-folder moves"
```

---

## Task 11: Frontend — Reload folders after file operations

**Files:**
- Modify: `public/js/app.js` (multiple locations)

**Step 1: Add loadFolders calls alongside existing loadHistory calls**

In `viewFile()`, after `loadHistory();`, add:
```javascript
loadFolders();
```

In the `deleteFileBtn` click handler, after `loadHistory();`, add:
```javascript
loadFolders();
```

In the `viewerTitle` rename save function, after `loadHistory();`, add:
```javascript
loadFolders();
```

**Step 2: Commit**

```bash
git add public/js/app.js
git commit -m "feat(folders): reload folder list after file operations"
```

---

## Task 12: Manual end-to-end verification

**Files:** None (testing only)

**Step 1: Start dev server**

Run: `pnpm dev`

**Step 2: Test complete workflow in browser at http://localhost:8787**

Verify each of these in order:
1. Login, sidebar shows "Folders" section (empty) above History
2. Click `+` to create a folder — inline input appears, type name, Enter saves
3. Upload a file, view it — folder button appears in toolbar
4. Click "Move to Folder" — dropdown shows the folder + "New folder"
5. Select a folder — file moves into it
6. Sidebar shows folder with file count badge, collapsed
7. Click folder to expand — shows the file inside
8. History shows the file with a folder badge icon
9. Drag a history item onto a different folder — moves it
10. Rename a folder via hover action
11. Remove a file from a folder via the x button
12. Delete a folder — confirms, deletes folder and its files
13. Delete a file via viewer while it's in a folder — file removed from folder too

**Step 3: Commit any fixes needed**

```bash
git add -A
git commit -m "fix(folders): address issues found during manual testing"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Backend KV helpers | `src/worker.js` |
| 2 | Backend CRUD routes | `src/worker.js` |
| 3 | Backend membership routes | `src/worker.js` |
| 4 | Backend retention + delete cleanup | `src/worker.js` |
| 5 | Backend history folderId enrichment | `src/worker.js` |
| 6 | Frontend sidebar HTML + folder rendering | `index.html`, `app.js` |
| 7 | Frontend folder CSS | `style.css` |
| 8 | Frontend history folder badge | `app.js` |
| 9 | Frontend viewer toolbar folder button | `index.html`, `app.js`, `style.css` |
| 10 | Frontend drag and drop | `app.js`, `style.css` |
| 11 | Frontend reload folders after operations | `app.js` |
| 12 | Manual end-to-end verification | (testing) |
