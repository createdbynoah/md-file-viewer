# Folder Grouping in Sidebar — Design

**Issue:** #16
**Date:** 2026-02-20
**Branch:** `feat/folder-grouping`

## Summary

Add named folders to the sidebar so users can group files. Folders appear above the existing History section, are collapsible (collapsed by default), and exempt their contents from auto-archive/deletion retention rules.

## Data Model

### `folders` KV key (in existing `HISTORY` namespace)

```json
[
  {
    "id": "f-abc123",
    "name": "Work Notes",
    "fileIds": ["uuid1", "uuid2"],
    "created": "2026-02-20T12:00:00Z"
  }
]
```

Folder IDs use a `f-` prefix + short random string to distinguish from file UUIDs.

### `meta:{uuid}` additions

Optional `folderId` field added to existing file metadata:

```json
{
  "filename": "notes.md",
  "source": "upload",
  "size": 1234,
  "created": "...",
  "lastAccessedAt": "...",
  "folderId": "f-abc123"
}
```

Both the folder's `fileIds` array and the file's `folderId` are kept in sync (denormalized). The folder's `fileIds` is the primary source for listing; `folderId` on metadata enables quick lookups and retention exemption checks.

## API Routes

All auth-protected. Added under `/api/folders`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/folders` | List all folders with member file metadata |
| POST | `/api/folders` | Create a folder (body: `{ name }`) |
| PATCH | `/api/folders/:id` | Rename a folder (body: `{ name }`) |
| DELETE | `/api/folders/:id` | Delete folder + all contained files from R2 and KV |
| POST | `/api/folders/:id/files` | Add file to folder (body: `{ fileId }`) |
| DELETE | `/api/folders/:id/files/:fileId` | Remove file from folder (returns to flat list) |
| POST | `/api/folders/:id/files/:fileId/move` | Move file to different folder (body: `{ targetFolderId }`) |

### `GET /api/folders` response shape

```json
[
  {
    "id": "f-abc123",
    "name": "Work Notes",
    "files": [
      { "id": "uuid1", "filename": "notes.md", "source": "upload", "size": 1234 },
      { "id": "uuid2", "filename": "todo.md", "source": "paste", "size": 567 }
    ],
    "created": "2026-02-20T12:00:00Z"
  }
]
```

## Sidebar Layout

```
+--------------------------+
|  Folders           [+ ]  |  <- "Folders" heading + create button
|  > Work Notes        (3) |  <- Collapsed by default, file count badge
|  > Personal          (1) |  <- Collapsed by default
|--------------------------|
|  History        [Clear]  |
|  [F] notes.md            |  <- Folder badge on filed items
|  meeting.md              |  <- Unfiled item, no badge
|  old-doc.md              |
+--------------------------+
```

- Folders section above History
- All folders collapsed by default
- Expanded/collapsed state persisted in `localStorage`
- File count badge shown on collapsed folders
- `[+]` button creates a new folder (inline text input)

## Interactions

### Creating a folder
Click `[+]` button -> inline text input appears in the folders section -> type name -> Enter to confirm, Escape to cancel.

### Drag and drop (desktop)
- Drag a history item onto a folder to add it
- Drag a file from one folder to another to move it
- Drag a file out of a folder onto the "History" heading to unfile it

### Context menu (mobile + desktop)
- Hover/long-press on a file in a folder -> "Move to folder" (submenu), "Remove from folder"
- Hover/long-press on a folder -> "Rename", "Delete"

### Viewer toolbar
New folder icon button next to existing delete/copy buttons:
- Click -> dropdown showing available folders + "New folder" + "Remove from folder" (if currently filed)
- Selecting a folder moves the currently viewed file there

### History section
- Files that belong to a folder still appear in History when viewed
- A small folder icon badge indicates the file is in a folder
- Clicking a filed item in history opens the file normally

## Retention Exemption

The `runRetention()` cron is modified to check `folderId` on each file's metadata:
- If `folderId` is present and the folder still exists -> skip archiving and deletion
- If `folderId` references a deleted folder -> treat as unfiled (subject to normal retention)

This means files are protected from auto-archive/deletion as long as they remain in a folder.

## Error Handling

- **Delete folder:** Confirmation prompt ("Delete folder and N files?") before proceeding
- **Move filed file:** Shows which folder the file is leaving
- **Duplicate folder names:** Allowed (folders identified by ID, not name)
- **Delete file via viewer:** Also removes the file from its folder's `fileIds`
- **Stale folder references:** If a file's `folderId` points to a nonexistent folder, clear it on next access

## Out of Scope

- Nested folders (subfolders)
- Folder-level permissions
- Folder ordering/sorting (alphabetical by default)
- Drag-to-reorder files within a folder
