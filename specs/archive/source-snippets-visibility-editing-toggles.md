# Spec: Source Snippet Visibility, In-App Editing & Source Toggles

## Status: Draft
## Branch: `spec/source-snippets-visibility-editing-toggles`
## Depends on: `impl/boilerplate-config-generator`

---

## 1. Problem Statement

After creating or importing an expansion config, users hit several gaps:

1. **Source-disabled snippets still appear** — Disabling a source in the Sources view does NOT hide its snippets from the main list or the live expansion trigger cache. The `list_snippets()` query and `refresh_trigger_cache()` both filter only on `s.is_enabled = 1` but never check whether the parent `snippet_sources.is_enabled` is 0. This means the source toggle is cosmetic — it doesn't actually do anything.

2. **No way to edit the YAML config in-app** — `file_parser.rs` only has read functions (`parse_expansion_file`, `parse_expansion_folder`). There's no write-back path. Users can edit source-imported snippets via the edit form, but those changes persist only in the DB — the source YAML file is never updated. On next sync, DB edits are overwritten by the file. There's no warning about this.

3. **Creation toast works but could be clearer** — Both `App.tsx` and `SnippetManager.tsx` show "Created config with N snippets in /path". This is good but could be enhanced: the snippet list doesn't auto-scroll to show the new snippets, and there's no visual indicator of which snippets are new.

4. **Individual source snippet toggles are disconnected** — Users can toggle individual snippet `is_enabled` in the edit form, but re-syncing the source resets them (upsert overwrites). There's no per-snippet override mechanism that survives sync.

---

## 2. Changes

### 2.1 Fix Source-Level Filtering (Critical Bug)

**Problem**: `list_snippets()` and `refresh_trigger_cache()` ignore `snippet_sources.is_enabled`.

#### 2.1.1 `db.rs` — `list_snippets()`

Current WHERE clause:
```sql
WHERE s.is_enabled = 1
```

Change to:
```sql
WHERE s.is_enabled = 1
  AND (s.source_id IS NULL OR ss.is_enabled = 1 OR ss.is_enabled IS NULL)
```

This ensures:
- Built-in snippets (no source_id) always show
- Source-imported snippets only show when their source is enabled
- Orphaned snippets (source deleted but snippet remains) still show

The `LEFT JOIN snippet_sources ss ON s.source_id = ss.id` is already present in the query.

#### 2.1.2 `trigger_cache.rs` — `refresh_trigger_cache()`

Current query:
```sql
SELECT id, trigger, variables FROM snippets WHERE is_enabled = 1
```

Change to:
```sql
SELECT s.id, s.trigger, s.variables
FROM snippets s
LEFT JOIN snippet_sources ss ON s.source_id = ss.id
WHERE s.is_enabled = 1
  AND (s.source_id IS NULL OR ss.is_enabled = 1 OR ss.is_enabled IS NULL)
```

This ensures disabled sources don't trigger live expansion.

#### 2.1.3 `db.rs` — `list_recent_snippets()` and `list_favorite_snippets()`

Apply the same source-enabled filter to these queries so disabled-source snippets don't appear in the command palette's Recents and Favorites sections.

#### 2.1.4 Frontend — Refresh After Toggle

In `SnippetManager.tsx` `SourcesView`, when `handleToggleEnabled` is called, also refresh the trigger cache by invoking a new backend command or by calling an existing refresh path. Currently the toggle only updates the `snippet_sources` row — the trigger cache remains stale until the app restarts.

Add a new backend command `refresh_triggers` that calls `trigger_cache::refresh_trigger_cache()`:

```rust
#[tauri::command]
pub async fn refresh_triggers(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache)
        .await
        .map_err(|e| e.to_string())
}
```

Call this from the frontend after toggling a source:
```ts
await updateSnippetSource(source.id, { isEnabled: !source.is_enabled });
await invoke("refresh_triggers");
refreshSources();
```

---

### 2.2 In-App Config File Editor

**Goal**: Let users view and edit the YAML source file directly within Dispatch, with changes written back to disk and re-synced.

#### 2.2.1 Backend — Read/Write Source File

Add two new commands in `commands.rs`:

```rust
#[tauri::command]
pub async fn read_source_file(
    state: State<'_, Arc<AppState>>,
    source_id: String,
) -> Result<String, String> {
    let source = db::get_snippet_source(&state.db, &source_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Source not found")?;
    std::fs::read_to_string(&source.path)
        .map_err(|e| format!("Failed to read {}: {}", source.path, e))
}

#[tauri::command]
pub async fn write_source_file(
    state: State<'_, Arc<AppState>>,
    source_id: String,
    content: String,
) -> Result<models::SyncResult, String> {
    let source = db::get_snippet_source(&state.db, &source_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Source not found")?;

    // Validate YAML before writing
    let _: file_parser::ExpansionConfig = serde_yaml::from_str(&content)
        .map_err(|e| format!("Invalid YAML: {}", e))?;

    std::fs::write(&source.path, &content)
        .map_err(|e| format!("Failed to write {}: {}", source.path, e))?;

    // Re-sync after writing
    let result = sync_source_internal(&state.db, &source).await?;
    let _ = trigger_cache::refresh_trigger_cache(&state.db, &state.trigger_cache).await;
    Ok(result)
}
```

Key: `write_source_file` validates the YAML before writing to prevent corruption. It also auto-syncs after write.

Register both commands in `lib.rs` invoke_handler.

#### 2.2.2 Frontend — API Wrappers

Add to `src/lib/snippets.ts`:

```ts
export async function readSourceFile(sourceId: string): Promise<string> {
  return invoke<string>("read_source_file", { sourceId });
}

export async function writeSourceFile(sourceId: string, content: string): Promise<SyncResult> {
  return invoke<SyncResult>("write_source_file", { sourceId, content });
}
```

#### 2.2.3 Frontend — SourceFileEditor Component

Add a new view mode to `SnippetManager.tsx`:

```ts
type ViewMode = "list" | "edit" | "sources" | "edit-source";
```

Add a new `SourceFileEditor` component:

```
┌─────────────────────────────────────────────────┐
│  < Back to Sources    {source.name}     [Save]  │
├─────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────┐    │
│  │ # Dispatch Expansion Config             │    │
│  │ # Package: my-snippets                  │    │
│  │                                         │    │
│  │ name: "my-snippets"                     │    │
│  │                                         │    │
│  │ snippets:                               │    │
│  │   - trigger: ":hello"                   │    │
│  │     label: "Greeting"                   │    │
│  │     body: "Hello world!"                │    │
│  │     ...                                 │    │
│  └─────────────────────────────────────────┘    │
├─────────────────────────────────────────────────┤
│  ⚠ YAML validation: OK                         │
│  Last synced: 2 min ago · 6 snippets            │
└─────────────────────────────────────────────────┘
```

**Behavior:**
- Loads the raw YAML file content via `readSourceFile(source.id)`
- Displays in a monospace `<textarea>` with syntax-friendly styling
- On Save: calls `writeSourceFile(source.id, content)`, validates YAML server-side
- If validation fails, show the error message inline (red text below the editor) without closing
- If save succeeds, show toast with sync results ("Saved — +2 added, ~1 updated, -0 removed")
- "Back to Sources" returns to SourcesView

**Entry point**: Add an "Edit" button to each source card in `SourcesView`, next to Sync/Enabled/Remove:

```tsx
<button
  onClick={() => handleEditSource(source)}
  className="text-[10px] text-accent hover:text-accent-hover transition-colors"
>
  Edit
</button>
```

#### 2.2.4 Warning on Editing Source-Imported Snippets via Form

When a user clicks to edit a source-imported snippet (via the individual snippet edit form), show a warning banner at the top:

```tsx
{isFromFile && (
  <div className="px-4 py-2 bg-warning/10 border-b border-warning/20">
    <p className="text-[11px] text-warning">
      This snippet is imported from a source file. Edits here only apply locally
      and will be overwritten on next sync. Edit the source file directly for
      permanent changes.
    </p>
  </div>
)}
```

Add this in `SnippetEditView`, after the top bar and before the form.

---

### 2.3 Enhanced Creation Feedback

**Goal**: After creating a new config, make it obvious the snippets are now available.

#### 2.3.1 Auto-Navigate + Filter by Source

After config creation (both command palette and SnippetManager paths):
1. Navigate to expander screen (already done for command palette)
2. Set a transient source filter so only the new source's snippets are visible
3. Show a dismissible banner: "Created {name} — {n} snippets added"

**Implementation**: Add optional `sourceFilter` state to SnippetManager:

```ts
const [sourceFilter, setSourceFilter] = useState<string | null>(null);
```

Pass it to `useSnippets` hook / the backend `list_snippets` query. Add a `source_id` filter param:

In `db.rs` `list_snippets()`, add optional `source_id` param:
```sql
AND ($source_id IS NULL OR s.source_id = $source_id)
```

In the frontend, when sourceFilter is set, show a filter chip:
```
┌─────────────────────────────────────────────────┐
│  Showing: my-snippets (6)           [Clear ✕]   │
├─────────────────────────────────────────────────┤
│  ☆  :hello    Greeting         my-snippets      │
│  ☆  :today    Today's date     my-snippets      │
│  ...                                            │
```

#### 2.3.2 Toast Enhancement

The toast message already shows snippet count. Additionally, show a brief animation or highlight on newly-synced snippet rows (e.g., a subtle pulse or accent-colored left border that fades after 2 seconds). This is optional polish — the source filter in 2.3.1 is the primary feedback mechanism.

---

### 2.4 Source Toggle That Actually Works

**Goal**: Toggling a source on/off in SourcesView should immediately show/hide its snippets everywhere.

This is handled by the query fixes in 2.1.1–2.1.3 and the trigger cache refresh in 2.1.4. Additionally:

#### 2.4.1 Visual Feedback in SourcesView

When a source is disabled, visually dim its card:

```tsx
<div className={`rounded-lg bg-surface-raised border border-border-subtle p-3 ${
  !source.is_enabled ? "opacity-50" : ""
}`}>
```

#### 2.4.2 Snippet Count on Source Cards

Show how many snippets each source contributes. Add a count query:

```rust
pub async fn count_source_snippets(pool: &SqlitePool, source_id: &str) -> Result<i64, sqlx::Error> {
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM snippets WHERE source_id = ? AND is_enabled = 1"
    )
    .bind(source_id)
    .fetch_one(pool)
    .await?;
    Ok(count)
}
```

Display in the source card: "6 snippets · File · Last synced: 2 min ago"

#### 2.4.3 Bulk Toggle in Main Snippet List

In the main snippet list, snippets from external sources already show a source badge. Add a subtle toggle per-source-group: when a user long-presses or right-clicks a source badge, show a context action to disable that source. This is lower priority and can be deferred.

---

## 3. Implementation Phases

### Phase 1: Fix Source-Level Filtering (Backend)

**Files:**
- `src-tauri/src/db.rs` — update `list_snippets()`, `list_recent_snippets()`, `list_favorite_snippets()` WHERE clauses
- `src-tauri/src/trigger_cache.rs` — update `refresh_trigger_cache()` query
- `src-tauri/src/commands.rs` — add `refresh_triggers` command
- `src-tauri/src/lib.rs` — register `refresh_triggers`

**Verify:** Disable a source → its snippets disappear from main list. Re-enable → they reappear. `cargo check` + `cargo test` pass.

### Phase 2: In-App Config File Editor (Backend + Frontend)

**Files:**
- `src-tauri/src/commands.rs` — add `read_source_file`, `write_source_file` commands
- `src-tauri/src/lib.rs` — register new commands
- `src/lib/snippets.ts` — add `readSourceFile`, `writeSourceFile` wrappers
- `src/components/SnippetManager.tsx` — add `SourceFileEditor` component, "edit-source" view mode, "Edit" button in SourcesView, warning banner in SnippetEditView for source-imported snippets

**Verify:** Open Sources → click Edit on a source → see YAML content → modify → Save → toast shows sync results → snippet list reflects changes.

### Phase 3: Source Toggle UX + Trigger Cache Refresh (Frontend)

**Files:**
- `src/lib/snippets.ts` — add `refreshTriggers` wrapper
- `src/components/SnippetManager.tsx` — call `refreshTriggers` after toggling source, dim disabled sources, show snippet count on source cards

**Verify:** Toggle a source off → trigger cache refreshed → live expansion no longer fires for those triggers. Source card shows dimmed with count.

### Phase 4: Creation Feedback (Backend + Frontend)

**Files:**
- `src-tauri/src/db.rs` — add `source_id` filter to `list_snippets()`
- `src-tauri/src/commands.rs` — pass `source_id` param through `list_snippets` command
- `src/hooks/useSnippets.ts` — accept optional `sourceId` filter
- `src/components/SnippetManager.tsx` — add `sourceFilter` state, source filter chip, pass to hook
- `src/App.tsx` — after config creation, pass source ID to SnippetManager (via state or URL param)

**Verify:** Create new config → expander screen shows only new source's snippets with filter chip → clear filter to see all.

---

## 4. File-Level Change Summary

| File | Phase | Change |
|------|-------|--------|
| `src-tauri/src/db.rs` | 1, 4 | Fix WHERE clauses to check `ss.is_enabled`; add `source_id` filter; add `count_source_snippets` |
| `src-tauri/src/trigger_cache.rs` | 1 | Join `snippet_sources`, filter disabled sources |
| `src-tauri/src/commands.rs` | 1, 2 | Add `refresh_triggers`, `read_source_file`, `write_source_file` |
| `src-tauri/src/lib.rs` | 1, 2 | Register new commands |
| `src/lib/snippets.ts` | 2, 3 | Add `readSourceFile`, `writeSourceFile`, `refreshTriggers` wrappers |
| `src/components/SnippetManager.tsx` | 2, 3, 4 | Add `SourceFileEditor`, source edit button, warning banner, dim disabled sources, snippet count, source filter chip, trigger cache refresh on toggle |
| `src/hooks/useSnippets.ts` | 4 | Accept optional `sourceId` filter |
| `src/App.tsx` | 4 | Pass source filter after config creation |

---

## 5. Conflict Analysis for Parallel Work

- **Phase 1** (backend only: `db.rs`, `trigger_cache.rs`, `commands.rs`, `lib.rs`) and **Phase 2** backend changes (`commands.rs`, `lib.rs`) overlap on `commands.rs` and `lib.rs` → do sequentially or carefully merge
- **Phase 2** frontend and **Phase 3** frontend both touch `SnippetManager.tsx` → do sequentially
- **Phase 4** touches both backend (`db.rs`, `commands.rs`) and frontend (`SnippetManager.tsx`) → do after 1-3

**Recommended execution order**: Phase 1 → Phase 2 → Phase 3 → Phase 4 (sequential, all files overlap)

---

## 6. Out of Scope

- **File watcher / auto-sync on save** — watching the filesystem for external changes to YAML files
- **Syntax highlighting in YAML editor** — a plain monospace textarea is sufficient for v1; CodeMirror/Monaco would be a future enhancement
- **Multi-file source editing** — for folder-type sources, only editing individual YAML files within the folder (not the folder itself)
- **Undo/redo in YAML editor** — browser native undo in textarea is sufficient
- **Drag-and-drop reordering of snippets** — out of scope for this spec
