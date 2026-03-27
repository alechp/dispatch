# Spec: Expander V2 — Command Palette, External Sources, Recents & Favorites

## Status: Draft
## Branch: `spec/expander-v2-command-palette-sources`

---

## 1. Overview

This spec evolves the text expander from a standalone palette into an integrated command-palette flow with external config file support, usage recency, and favorites. The goals:

1. **CMD+SHIFT+K** opens a **general command palette** (not just expander)
2. Typing the **expand prefix** (e.g. `:`) filters to available expansions
3. Users can **customize the prefix** character
4. Users can **import expansion configs** from files/folders on disk
5. Expansions display their **source** (defaults, file path, package name)
6. A **boilerplate generator** creates new config files in user-chosen folders
7. **Recents** surface the most recently used expansions
8. **Favorites** let users pin expansions for quick access

---

## 2. CMD+SHIFT+K Opens the General Command Palette

### 2.1 Motivation

Currently CMD+SHIFT+K opens `ExpanderPalette` directly. Users need a single entry point for all actions — navigation, snippets, settings — similar to VS Code's Cmd+K / Alfred.

### 2.2 Behavior Change

- **CMD+SHIFT+K** → opens `CommandPalette` (the existing general palette in `CommandPalette.tsx`)
- The current in-app `Cmd+K` binding for CommandPalette remains unchanged
- The `show_expander` hotkey action is renamed to `show_command_palette` in the backend

### 2.3 Changes

#### `src-tauri/src/db.rs`

Update `DEFAULT_HOTKEY_CONFIG`:
```json
{
  "action": "show_command_palette",
  "keys": ["CommandOrControl+Shift+K"],
  "enabled": true,
  "scope": "global",
  "category": "Global",
  "description": "Command palette"
}
```

#### `src-tauri/src/lib.rs` (~line 557)

Rename the action handler:
```rust
"show_command_palette" => {
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("show-command-palette", ());
}
```

Keep the existing `"show_expander"` handler as-is for backwards compatibility (it can remain in the codebase, just not bound by default).

#### `src/App.tsx`

Add listener for `"show-command-palette"` event → set `showCommandPalette = true`.

```typescript
useEffect(() => {
  const unlisten = listen("show-command-palette", () => {
    setShowCommandPalette(true);
  });
  return () => { unlisten.then((fn) => fn()); };
}, []);
```

---

## 3. Expand Prefix Filters to Expansions

### 3.1 Motivation

When the command palette is open, typing `:` (or the user's configured prefix) should seamlessly transition into snippet-search mode — no separate palette needed.

### 3.2 Behavior

1. User opens command palette (CMD+SHIFT+K)
2. They see general commands (navigate, settings, etc.)
3. They type `:` → palette switches to **expansion mode**:
   - Command list is replaced by snippet list
   - Search input shows `:` prefix (non-editable badge/chip)
   - Remaining text filters snippets by trigger or label
   - Visual indicator shows "Expansions" mode
4. Backspacing past the `:` returns to general command mode
5. Selecting a snippet expands it and copies to clipboard (existing behavior)

### 3.3 Changes

#### `src/components/CommandPalette.tsx`

Add state machine with two modes:

```typescript
type PaletteMode = "commands" | "expansions";

const [mode, setMode] = useState<PaletteMode>("commands");
const [query, setQuery] = useState("");
```

**Input handler logic:**
- If `mode === "commands"` and input starts with the configured prefix → switch to `"expansions"` mode, strip prefix from search query
- If `mode === "expansions"` and input is empty + backspace → switch back to `"commands"`

**Rendering:**
- `mode === "commands"` → existing command list filtered by query
- `mode === "expansions"` → snippet list from `list_snippets` Tauri command, filtered by remaining query

The expansion selection/form/expand logic can be extracted from `ExpanderPalette.tsx` into a shared hook (`useSnippetExpansion`) to avoid duplication.

#### `src/lib/snippets.ts`

Add a `get_expand_prefix()` / `set_expand_prefix()` pair (see Section 4).

---

## 4. Configurable Expand Prefix

### 4.1 Motivation

Different users prefer different trigger prefixes. Espanso uses `:`, some tools use `/`, others use `;;`. The prefix should be configurable.

### 4.2 Data Model

Store as a setting in the existing `settings` table:

| Key | Default | Description |
|-----|---------|-------------|
| `expand_prefix` | `:` | Character(s) that activate expansion mode in the command palette |

### 4.3 Changes

#### `src-tauri/src/db.rs`

```rust
pub async fn get_expand_prefix(pool: &SqlitePool) -> Result<String, String> {
    get_setting(pool, "expand_prefix")
        .await
        .map_err(|e| e.to_string())
        .map(|v| v.unwrap_or_else(|| ":".to_string()))
}

pub async fn set_expand_prefix(pool: &SqlitePool, prefix: &str) -> Result<(), String> {
    set_setting(pool, "expand_prefix", prefix)
        .await
        .map_err(|e| e.to_string())
}
```

#### `src-tauri/src/commands.rs`

Add Tauri commands:
```rust
#[tauri::command]
pub async fn get_expand_prefix(state: State<'_, AppState>) -> Result<String, String> { ... }

#[tauri::command]
pub async fn set_expand_prefix(state: State<'_, AppState>, prefix: String) -> Result<(), String> { ... }
```

#### `src/components/SnippetManager.tsx` (Settings section)

Add a "Trigger Prefix" input field in the expander settings area. Show current prefix with an editable text input. Validate: non-empty, max 3 characters, no whitespace.

#### Live expansion (macOS listener)

The `trigger_cache.rs` and `macos_listener.rs` already match by trigger suffix. The prefix is part of the trigger string itself (e.g. `:date`), so no change needed for live expansion — the prefix in the palette is a UI concern only. Users can already set whatever trigger prefix they want per-snippet.

**Clarification**: The prefix setting controls **command palette filtering behavior only**. Individual snippet triggers remain independent (a snippet with trigger `:date` works regardless of the palette prefix setting). This avoids breaking live expansion.

---

## 5. External Expansion Config Files

### 5.1 Motivation

Users want to:
- Store expansion configs in git repos alongside projects
- Share configs across machines via Dropbox/iCloud/git
- Edit configs in their preferred text editor
- Avoid lock-in to the GUI for all snippet management

### 5.2 Config File Format

Use YAML (`.yml` / `.yaml`) for human-readability, matching espanso's format:

```yaml
# ~/.config/dispatch/expansions/work-emails.yml
name: "Work Emails"
snippets:
  - trigger: ":standup"
    label: "Daily standup template"
    body: |
      ## Standup — {{date}}
      **Yesterday:** {{yesterday}}
      **Today:** {{today}}
      **Blockers:** {{blockers}}
    variables:
      - name: date
        type: date
        params:
          format: "%Y-%m-%d"
      - name: yesterday
        type: form
        params:
          label: "What did you do yesterday?"
          default: ""
      - name: today
        type: form
        params:
          label: "What will you do today?"
          default: ""
      - name: blockers
        type: form
        params:
          label: "Any blockers?"
          default: "None"

  - trigger: ":ooo"
    label: "Out of office"
    body: "I'm currently out of office and will return on {{return_date}}. For urgent matters, contact {{backup}}."
    variables:
      - name: return_date
        type: form
        params:
          label: "Return date"
          default: ""
      - name: backup
        type: form
        params:
          label: "Backup contact"
          default: ""
```

### 5.3 Data Model

#### New table: `snippet_sources`

```sql
CREATE TABLE IF NOT EXISTS snippet_sources (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,          -- Display name ("Work Emails", "Project X")
    path        TEXT NOT NULL UNIQUE,   -- Absolute path to file or folder
    is_folder   INTEGER NOT NULL DEFAULT 0,  -- 0 = single file, 1 = folder (all .yml inside)
    is_enabled  INTEGER NOT NULL DEFAULT 1,
    auto_reload INTEGER NOT NULL DEFAULT 1,  -- Watch for changes via fs notify
    last_synced_at TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
```

#### Extend `snippets` table

Add a `source_id` column:

```sql
ALTER TABLE snippets ADD COLUMN source_id TEXT REFERENCES snippet_sources(id) ON DELETE CASCADE;
ALTER TABLE snippets ADD COLUMN source_type TEXT NOT NULL DEFAULT 'builtin';
-- source_type: 'builtin' (GUI-created), 'file' (from external config)
```

**Note**: `source_id IS NULL` + `source_type = 'builtin'` → snippet was created in the GUI (the "defaults").

### 5.4 Sync Behavior

#### On app startup
1. Load all `snippet_sources` where `is_enabled = 1`
2. For each source, parse the YAML file(s)
3. Upsert snippets: match on `(source_id, trigger)` composite
4. Remove snippets that exist in DB for this source but not in the file (deleted externally)
5. Update `last_synced_at`

#### File watching (optional, if `auto_reload = 1`)
- Use `notify` crate (already common in Tauri apps) to watch source paths
- On file change → re-sync that source
- Debounce: 500ms after last change event

#### Conflict resolution
- If two sources define the same trigger, **both** appear in the palette with source labels
- The most recently used one appears first (by `last_used_at`)
- Live expansion uses the **first enabled match** by source priority (builtin first, then by `snippet_sources.created_at` ASC)

### 5.5 Changes

#### `src-tauri/src/db.rs`

New functions:
```rust
pub async fn create_snippet_source(pool: &SqlitePool, name: &str, path: &str, is_folder: bool) -> Result<SnippetSource, String>
pub async fn list_snippet_sources(pool: &SqlitePool) -> Result<Vec<SnippetSource>, String>
pub async fn update_snippet_source(pool: &SqlitePool, id: &str, name: Option<&str>, is_enabled: Option<bool>, auto_reload: Option<bool>) -> Result<(), String>
pub async fn delete_snippet_source(pool: &SqlitePool, id: &str) -> Result<(), String>
pub async fn sync_snippets_from_source(pool: &SqlitePool, source: &SnippetSource) -> Result<SyncResult, String>
```

#### `src-tauri/src/models.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SnippetSource {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_folder: i32,
    pub is_enabled: i32,
    pub auto_reload: i32,
    pub last_synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub errors: Vec<String>,
}
```

#### `src-tauri/src/file_parser.rs` (new file)

```rust
pub fn parse_expansion_file(path: &Path) -> Result<Vec<ParsedSnippet>, String>
pub fn parse_expansion_folder(path: &Path) -> Result<Vec<(String, Vec<ParsedSnippet>)>, String>
```

Uses `serde_yaml` crate for parsing.

#### `src-tauri/src/commands.rs`

New Tauri commands:
- `add_snippet_source` — validate path exists, create source, run initial sync
- `list_snippet_sources`
- `update_snippet_source`
- `remove_snippet_source` — deletes source + cascades to its snippets
- `sync_snippet_source` — manual re-sync trigger
- `sync_all_sources` — re-sync everything

#### `src/components/SnippetManager.tsx`

New **"Sources"** tab/section:
- List of configured sources with name, path, enabled toggle, last synced time
- "Add Source" button → file/folder picker dialog (`tauri::api::dialog`)
- "Sync Now" button per source
- "Remove" button with confirmation
- Source count badge showing number of snippets from each source

#### `src/lib/snippets.ts`

New invoke wrappers:
```typescript
export const addSnippetSource = (name: string, path: string, isFolder: boolean) => invoke<SnippetSource>("add_snippet_source", { name, path, isFolder });
export const listSnippetSources = () => invoke<SnippetSource[]>("list_snippet_sources");
export const removeSnippetSource = (id: string) => invoke<void>("remove_snippet_source", { id });
export const syncSnippetSource = (id: string) => invoke<SyncResult>("sync_snippet_source", { id });
```

#### Dependencies

Add to `Cargo.toml`:
```toml
serde_yaml = "0.9"
notify = { version = "6", features = ["macos_kqueue"] }
```

---

## 6. Source Attribution on Expansions

### 6.1 Motivation

When a user has dozens of snippets from multiple sources, they need to know where each one comes from — especially for debugging conflicts or deciding which to edit.

### 6.2 Display

#### In the Command Palette (expansion mode)

Each snippet row shows:
```
:standup    Daily standup template         [Work Emails]
:date       Current date                   [Defaults]
:deploy     Deploy command                 [~/projects/myapp/.dispatch/snippets.yml]
```

The source badge shows:
- `"Defaults"` for `source_type = 'builtin'`
- The `snippet_sources.name` for file-sourced snippets (e.g. `"Work Emails"`)
- Falls back to the file path if no name is set

#### In the Snippet Manager

- Source column in the snippet list
- Filtering by source (dropdown or tag filter)
- File-sourced snippets show a "read-only" badge (edits should be made in the file)
- "Open in Finder" / "Open in Editor" button for file-sourced snippets

### 6.3 User-Customizable Source Name

Users can rename any source in the Sources settings:

```typescript
// SnippetManager.tsx — source list item
<input
  value={source.name}
  onChange={(e) => updateSnippetSource(source.id, { name: e.target.value })}
/>
```

The `name` field on `snippet_sources` is always user-editable, even after creation.

### 6.4 Changes

#### `src/components/CommandPalette.tsx`

In expansion mode, each row renders:
```tsx
<span className="snippet-source-badge">{snippet.source_name ?? "Defaults"}</span>
```

#### `src-tauri/src/db.rs` — `list_snippets()`

Update query to JOIN with `snippet_sources`:
```sql
SELECT s.*, COALESCE(ss.name, 'Defaults') as source_name
FROM snippets s
LEFT JOIN snippet_sources ss ON s.source_id = ss.id
WHERE ...
ORDER BY ...
```

#### `src-tauri/src/models.rs`

Add to `Snippet`:
```rust
pub source_id: Option<String>,
pub source_type: String,
// Populated by JOIN, not stored:
#[sqlx(default)]
pub source_name: Option<String>,
```

---

## 7. Boilerplate Generator

### 7.1 Motivation

Users want a quick way to create a new expansion config file in a project directory without manually writing YAML. The GUI should scaffold it and auto-register it as a source.

### 7.2 Flow

1. User clicks **"New Config File"** in Snippet Manager → Sources section
2. **Folder picker dialog** opens (native macOS Finder via `tauri::api::dialog::FileDialogBuilder`)
3. User selects a destination folder
4. **Prompt dialog** asks for **"Package name"** (what appears in source badges)
   - Default: folder name (e.g. `my-project`)
   - This becomes the `name` field in `snippet_sources`
5. App creates `<selected_folder>/dispatch-snippets.yml` with starter template:

```yaml
# Dispatch Expansion Config
# Package: {{package_name}}
# Docs: https://dispatch.dev/docs/expansions
#
# Add your snippets below. Changes are auto-synced.

name: "{{package_name}}"
snippets:
  - trigger: ":example"
    label: "Example snippet"
    body: "Hello from {{package_name}}!"
```

6. App registers the file as a new `snippet_source` with:
   - `name`: user-provided package name
   - `path`: full path to created file
   - `is_folder`: 0
   - `auto_reload`: 1
7. Initial sync imports the example snippet
8. Success toast: `"Created dispatch-snippets.yml in <folder> — 1 snippet imported"`
9. The Finder reveals the file (optional — `open -R <path>`)

### 7.3 Changes

#### `src-tauri/src/commands.rs`

```rust
#[tauri::command]
pub async fn create_boilerplate_config(
    state: State<'_, AppState>,
    folder_path: String,
    package_name: String,
) -> Result<SnippetSource, String> {
    // 1. Validate folder exists
    // 2. Check dispatch-snippets.yml doesn't already exist
    // 3. Write template YAML
    // 4. Create snippet_source record
    // 5. Run initial sync
    // 6. Return the new source
}
```

#### `src/components/SnippetManager.tsx`

New button in Sources section:
```tsx
<button onClick={handleCreateBoilerplate}>
  New Config File
</button>
```

Handler:
```typescript
async function handleCreateBoilerplate() {
  const folder = await open({ directory: true, title: "Choose folder for expansion config" });
  if (!folder) return;

  const name = await promptDialog("Package name", basename(folder));
  if (!name) return;

  const source = await invoke("create_boilerplate_config", {
    folderPath: folder,
    packageName: name,
  });

  // Refresh source list
  // Show success toast
}
```

### 7.4 File Naming

Use `dispatch-snippets.yml` as the default filename. This is:
- Clearly associated with Dispatch
- Discoverable in project roots
- Not likely to conflict with other tools

If the file already exists, show an error: `"dispatch-snippets.yml already exists in this folder. Would you like to import it instead?"`

---

## 8. Recents

### 8.1 Motivation

Users tend to re-use the same handful of snippets. Surfacing recently used ones saves time.

### 8.2 Behavior

When the command palette is in expansion mode:
1. **Before typing** (empty search) → show **"Recent"** section at the top
   - Up to 5 most recently used snippets, ordered by `last_used_at DESC`
   - Visually separated with a "Recent" header
   - Below recents, show "All Snippets" section with remaining snippets
2. **While typing** → recents section disappears, full-text search across all snippets
3. Recently used snippets that match the search appear in normal results (no duplication)

### 8.3 Data Model

Already supported — the `snippets` table has `use_count` and `last_used_at` columns, and `increment_snippet_use()` updates both. No schema changes needed.

### 8.4 Changes

#### `src-tauri/src/db.rs`

New query function:
```rust
pub async fn list_recent_snippets(pool: &SqlitePool, limit: i64) -> Result<Vec<Snippet>, String> {
    sqlx::query_as::<_, Snippet>(
        "SELECT s.*, COALESCE(ss.name, 'Defaults') as source_name
         FROM snippets s
         LEFT JOIN snippet_sources ss ON s.source_id = ss.id
         WHERE s.is_enabled = 1 AND s.last_used_at IS NOT NULL
         ORDER BY s.last_used_at DESC
         LIMIT ?"
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}
```

#### `src-tauri/src/commands.rs`

```rust
#[tauri::command]
pub async fn list_recent_snippets(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Snippet>, String> {
    db::list_recent_snippets(&state.pool, limit.unwrap_or(5)).await
}
```

#### `src/components/CommandPalette.tsx`

In expansion mode, fetch recents on mount:
```typescript
const [recents, setRecents] = useState<Snippet[]>([]);

useEffect(() => {
  if (mode === "expansions" && query === "") {
    invoke<Snippet[]>("list_recent_snippets", { limit: 5 }).then(setRecents);
  }
}, [mode, query]);
```

Render with section headers:
```tsx
{query === "" && recents.length > 0 && (
  <>
    <div className="palette-section-header">Recent</div>
    {recents.map(renderSnippetRow)}
    <div className="palette-section-header">All Snippets</div>
  </>
)}
{filteredSnippets.map(renderSnippetRow)}
```

---

## 9. Favorites

### 9.1 Motivation

Power users have go-to snippets they use constantly. Favorites pin these at the top for instant access, separate from recency.

### 9.2 Behavior

- Users can **star/unstar** any snippet (toggle)
- In the command palette expansion mode:
  - **Tab key** cycles sections: `Favorites → Recent → All`
  - Favorites section appears above Recents (when present)
  - Visual star icon on favorited items
- In the Snippet Manager:
  - Star toggle on each snippet row
  - "Favorites" filter option

### 9.3 Data Model

Add column to `snippets`:

```sql
ALTER TABLE snippets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_snippets_favorite ON snippets(is_favorite);
```

### 9.4 Changes

#### `src-tauri/src/db.rs`

```rust
pub async fn toggle_snippet_favorite(pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let row: (i32,) = sqlx::query_as("SELECT is_favorite FROM snippets WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    let new_val = if row.0 == 0 { 1 } else { 0 };
    sqlx::query("UPDATE snippets SET is_favorite = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(new_val)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(new_val == 1)
}

pub async fn list_favorite_snippets(pool: &SqlitePool) -> Result<Vec<Snippet>, String> {
    sqlx::query_as::<_, Snippet>(
        "SELECT s.*, COALESCE(ss.name, 'Defaults') as source_name
         FROM snippets s
         LEFT JOIN snippet_sources ss ON s.source_id = ss.id
         WHERE s.is_enabled = 1 AND s.is_favorite = 1
         ORDER BY s.use_count DESC"
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())
}
```

#### `src-tauri/src/commands.rs`

```rust
#[tauri::command]
pub async fn toggle_snippet_favorite(state: State<'_, AppState>, id: String) -> Result<bool, String> { ... }

#[tauri::command]
pub async fn list_favorite_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> { ... }
```

#### `src/components/CommandPalette.tsx`

Tab-cycling between sections:
```typescript
type PaletteSection = "favorites" | "recent" | "all";
const [activeSection, setActiveSection] = useState<PaletteSection>("favorites");

// Tab key handler
if (e.key === "Tab") {
  e.preventDefault();
  setActiveSection(prev =>
    prev === "favorites" ? "recent" : prev === "recent" ? "all" : "favorites"
  );
}
```

Section rendering order (empty query only):
1. **Favorites** (starred, sorted by use_count)
2. **Recent** (last 5 used, excluding favorites)
3. **All** (everything else, sorted by trigger alphabetically)

Each section has a header with count badge: `Favorites (3)`, `Recent (5)`, `All (42)`.

#### `src/components/SnippetManager.tsx`

Add star toggle to each snippet row:
```tsx
<button
  className={`star-toggle ${snippet.is_favorite ? "active" : ""}`}
  onClick={() => toggleFavorite(snippet.id)}
  title={snippet.is_favorite ? "Remove from favorites" : "Add to favorites"}
>
  {snippet.is_favorite ? "★" : "☆"}
</button>
```

---

## 10. Migration Plan

### New migration: `006_snippet_sources_and_favorites.sql`

```sql
-- External snippet sources
CREATE TABLE IF NOT EXISTS snippet_sources (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    is_folder   INTEGER NOT NULL DEFAULT 0,
    is_enabled  INTEGER NOT NULL DEFAULT 1,
    auto_reload INTEGER NOT NULL DEFAULT 1,
    last_synced_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Extend snippets with source tracking and favorites
ALTER TABLE snippets ADD COLUMN source_id TEXT REFERENCES snippet_sources(id) ON DELETE CASCADE;
ALTER TABLE snippets ADD COLUMN source_type TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE snippets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_snippets_source ON snippets(source_id);
CREATE INDEX IF NOT EXISTS idx_snippets_favorite ON snippets(is_favorite);
CREATE INDEX IF NOT EXISTS idx_snippets_source_trigger ON snippets(source_id, trigger);
```

---

## 11. New Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| `serde_yaml` | `0.9` | Parse YAML expansion config files |
| `notify` | `6.x` | Filesystem watcher for auto-reload of external configs |

---

## 12. Implementation Order

| Phase | Features | Sections |
|-------|----------|----------|
| **Phase 1** | CMD+SHIFT+K → CommandPalette, prefix filtering | §2, §3 |
| **Phase 2** | Configurable prefix, favorites, recents | §4, §8, §9 |
| **Phase 3** | External sources, source attribution | §5, §6 |
| **Phase 4** | Boilerplate generator | §7 |

Phase 1 is the highest priority — it unblocks the core workflow. Phases 2–4 can be parallelized.

---

## 13. Verification Checklist

- [ ] CMD+SHIFT+K opens command palette globally (including from Kitty/terminals)
- [ ] Typing `:` in command palette transitions to expansion mode
- [ ] Backspace past `:` returns to command mode
- [ ] Prefix is configurable in settings; palette respects custom prefix
- [ ] External YAML config files can be imported as sources
- [ ] Folder sources import all `.yml` files within
- [ ] File changes are auto-detected and synced (when auto_reload enabled)
- [ ] Each snippet shows its source badge in the palette
- [ ] Source name is editable by the user
- [ ] Boilerplate generator creates valid YAML, registers source, and syncs
- [ ] Duplicate filename check shows import-instead prompt
- [ ] Recents section shows top 5 most recently used (empty query only)
- [ ] Favorites section shows starred snippets above recents
- [ ] Tab cycles focus between Favorites → Recent → All sections
- [ ] Star toggle works in both palette and Snippet Manager
- [ ] Hotkey settings UI shows updated "Command palette" binding
- [ ] Existing `show_expander` action still works for backwards compat
- [ ] Migration runs cleanly on fresh install and existing databases
