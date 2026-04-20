# Spec: Session Tracker & Text Expander

## Status: Draft
## Branch: `spec/session-tracker-text-expander`

---

## 1. Overview

Two new features, each with a dedicated screen accessible from the Header:

1. **Session Tracker** — a persistent dashboard of every project that has ever sent a notification, with live status and last-notification summary. Lets you monitor multiple projects at a glance even when individual notifications scroll out of the feed.

2. **Text Expander** — an in-app snippet expansion system inspired by [espanso](https://espanso.org). Manage triggers and replacements in a GUI, invoke them via a global search palette, and paste expanded text into any application.

---

## 2. Session Tracker

### 2.1 Motivation

Dispatch receives notifications from many projects (builds, CI, dev servers, linters, etc.). Once a notification scrolls past or gets cleared, there's no way to see "what's the latest with project X?" The session tracker solves this by maintaining a persistent, auto-updated status board of every project that has ever submitted a notification.

### 2.2 Data Model

#### 2.2.1 New Table: `project_sessions`

This table is a **materialized summary** — updated on every notification insert, not computed at query time.

```sql
CREATE TABLE IF NOT EXISTS project_sessions (
    project         TEXT NOT NULL,
    source          TEXT NOT NULL,
    last_event_type TEXT NOT NULL DEFAULT 'notification',
    last_title      TEXT NOT NULL,
    last_body       TEXT,
    last_metadata   TEXT,
    last_tmux_session TEXT,
    last_tmux_window  TEXT,
    last_tmux_pane    TEXT,
    notification_count INTEGER NOT NULL DEFAULT 1,
    unread_count    INTEGER NOT NULL DEFAULT 0,
    error_count     INTEGER NOT NULL DEFAULT 0,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    PRIMARY KEY (project, source)
);

CREATE INDEX IF NOT EXISTS idx_project_sessions_last_seen ON project_sessions(last_seen_at DESC);
```

The composite primary key `(project, source)` means a project can have multiple rows if it sends notifications from different sources (e.g., `myapp` from both `github` and `build`). This gives finer-grained tracking.

#### 2.2.2 Migration: `003_project_sessions.sql`

```sql
-- Create the table
CREATE TABLE IF NOT EXISTS project_sessions ( ... );  -- as above

-- Backfill from existing notifications
INSERT OR REPLACE INTO project_sessions (
    project, source, last_event_type, last_title, last_body, last_metadata,
    last_tmux_session, last_tmux_window, last_tmux_pane,
    notification_count, unread_count, error_count,
    first_seen_at, last_seen_at
)
SELECT
    COALESCE(n.project, n.source) as project,
    n.source,
    n.event_type,
    n.title,
    n.body,
    n.metadata,
    n.tmux_session,
    n.tmux_window,
    n.tmux_pane,
    COUNT(*) as notification_count,
    SUM(CASE WHEN n.is_read = 0 THEN 1 ELSE 0 END) as unread_count,
    SUM(CASE WHEN n.event_type = 'error' THEN 1 ELSE 0 END) as error_count,
    MIN(n.created_at) as first_seen_at,
    MAX(n.created_at) as last_seen_at
FROM notifications n
GROUP BY COALESCE(n.project, n.source), n.source
-- Use the latest notification's fields for last_* columns:
-- SQLite picks the row that matches MAX(n.created_at) for non-aggregate columns
-- when using GROUP BY, so we rely on a subquery for accuracy
;
```

Note: The backfill above is a best-effort approximation. For exact last-notification fields, use a more precise subquery:

```sql
INSERT OR REPLACE INTO project_sessions (
    project, source, last_event_type, last_title, last_body, last_metadata,
    last_tmux_session, last_tmux_window, last_tmux_pane,
    notification_count, unread_count, error_count,
    first_seen_at, last_seen_at
)
SELECT
    agg.project,
    agg.source,
    latest.event_type,
    latest.title,
    latest.body,
    latest.metadata,
    latest.tmux_session,
    latest.tmux_window,
    latest.tmux_pane,
    agg.notification_count,
    agg.unread_count,
    agg.error_count,
    agg.first_seen_at,
    agg.last_seen_at
FROM (
    SELECT
        COALESCE(project, source) as project,
        source,
        COUNT(*) as notification_count,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread_count,
        SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) as error_count,
        MIN(created_at) as first_seen_at,
        MAX(created_at) as last_seen_at
    FROM notifications
    GROUP BY COALESCE(project, source), source
) agg
JOIN notifications latest ON latest.created_at = agg.last_seen_at
    AND COALESCE(latest.project, latest.source) = agg.project
    AND latest.source = agg.source;
```

#### 2.2.3 Keeping It Updated

On every new notification insert (in `server.rs` `create_notification`), upsert into `project_sessions`:

```sql
INSERT INTO project_sessions (
    project, source, last_event_type, last_title, last_body, last_metadata,
    last_tmux_session, last_tmux_window, last_tmux_pane,
    notification_count, unread_count, error_count,
    first_seen_at, last_seen_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
ON CONFLICT(project, source) DO UPDATE SET
    last_event_type = excluded.last_event_type,
    last_title = excluded.last_title,
    last_body = excluded.last_body,
    last_metadata = excluded.last_metadata,
    last_tmux_session = excluded.last_tmux_session,
    last_tmux_window = excluded.last_tmux_window,
    last_tmux_pane = excluded.last_tmux_pane,
    notification_count = project_sessions.notification_count + 1,
    unread_count = project_sessions.unread_count + 1,
    error_count = project_sessions.error_count + CASE WHEN excluded.last_event_type = 'error' THEN 1 ELSE 0 END,
    last_seen_at = excluded.last_seen_at;
```

On `mark_notification_read`, decrement `unread_count` for the matching project/source.

On `mark_all_notifications_read`, set all `unread_count = 0`.

On `delete_notification`, decrement counts accordingly (query the notification first to get project/source/event_type).

On `clear_all_notifications`, delete all rows from `project_sessions` (or reset counts to 0).

### 2.3 Rust Model

```rust
// src-tauri/src/models.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSession {
    pub project: String,
    pub source: String,
    pub last_event_type: String,
    pub last_title: String,
    pub last_body: Option<String>,
    pub last_metadata: Option<String>,
    pub last_tmux_session: Option<String>,
    pub last_tmux_window: Option<String>,
    pub last_tmux_pane: Option<String>,
    pub notification_count: i64,
    pub unread_count: i64,
    pub error_count: i64,
    pub first_seen_at: String,
    pub last_seen_at: String,
}
```

### 2.4 Database Functions

```rust
// src-tauri/src/db.rs

/// Called on every new notification insert
pub async fn upsert_project_session(
    pool: &SqlitePool,
    notification: &Notification,
) -> Result<(), sqlx::Error> { ... }

/// Called on mark_read — decrement unread_count
pub async fn decrement_session_unread(
    pool: &SqlitePool,
    project: &str,
    source: &str,
) -> Result<(), sqlx::Error> { ... }

/// Called on mark_all_read — zero all unread_counts
pub async fn reset_all_session_unread(
    pool: &SqlitePool,
) -> Result<(), sqlx::Error> { ... }

/// Query all project sessions, ordered by last_seen_at DESC
pub async fn get_project_sessions(
    pool: &SqlitePool,
    search: Option<&str>,
) -> Result<Vec<ProjectSession>, sqlx::Error> { ... }
```

### 2.5 Tauri Commands

```rust
#[tauri::command]
pub async fn get_project_sessions(
    state: State<'_, Arc<AppState>>,
    search: Option<String>,
) -> Result<Vec<models::ProjectSession>, String> { ... }
```

Register in `invoke_handler`.

### 2.6 Frontend

#### 2.6.1 Types

Add to `src/lib/types.ts`:
```typescript
export interface ProjectSession {
  project: string;
  source: string;
  last_event_type: string;
  last_title: string;
  last_body: string | null;
  last_metadata: string | null;
  last_tmux_session: string | null;
  last_tmux_window: string | null;
  last_tmux_pane: string | null;
  notification_count: number;
  unread_count: number;
  error_count: number;
  first_seen_at: string;
  last_seen_at: string;
}
```

#### 2.6.2 API

Add to `src/lib/api.ts`:
```typescript
export async function getProjectSessions(search?: string): Promise<ProjectSession[]> {
  return invoke("get_project_sessions", { search: search ?? null });
}
```

#### 2.6.3 Screen: `src/components/SessionTracker.tsx`

**Layout** (scrollable column, 420px):

```
┌──────────────────────────────────┐
│ ← Back          🔍 filter...     │
├──────────────────────────────────┤
│                                  │
│  myapp                     3m ↗  │  ← project name + time since last
│  ● Build succeeded (github)      │  ← status dot + last title + source
│  23 total · 2 unread · 0 errors  │  ← counts
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│  api-server                12m ↗  │
│  ⬤ Error: OOM killed (build)     │  ← red dot for error state
│  87 total · 0 unread · 3 errors  │
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│  frontend                  1h ↗  │
│  ● Tests passed (ci)             │  ← green dot for success
│  12 total · 0 unread · 0 errors  │
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│  ...                             │
│                                  │
└──────────────────────────────────┘
```

**Status dot color** (derived from `last_event_type`):
| Event Type | Color | Meaning |
|---|---|---|
| `error` | `bg-error` (red) | Last event was an error |
| `warning` | `bg-warning` (yellow) | Last event was a warning |
| `stop` / `success` | `bg-success` (green) | Last event was success/stop |
| anything else | `bg-accent` (blue) | Normal notification |

**Features**:
- Search/filter input at the top (filters by project name)
- Each row is clickable — if `last_tmux_session` exists, clicking calls `focusTerminal` (same as notification cards)
- Unread count shown as a badge if > 0
- Error count shown in red if > 0
- Rows sorted by `last_seen_at` DESC (most recent activity first)
- Auto-refresh when `notifications-changed` event fires

**Props**:
```typescript
interface SessionTrackerProps {
  onBack: () => void;
  onFocusTerminal: (id: string, session: string, window: string | null, pane: string | null) => void;
}
```

#### 2.6.4 Hook: `src/hooks/useProjectSessions.ts`

```typescript
export function useProjectSessions(search?: string) {
  const [sessions, setSessions] = useState<ProjectSession[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const data = await getProjectSessions(search);
    setSessions(data);
    setLoading(false);
  }, [search]);

  useEffect(() => { refresh(); }, [refresh]);

  return { sessions, loading, refresh };
}
```

#### 2.6.5 Navigation

Add to Header: a sessions/projects icon button (similar to analytics toggle). Uses a grid/layout icon.

App.tsx navigation state changes from booleans to an enum:
```typescript
type ActiveScreen = "feed" | "telemetry" | "sessions" | "expander";
const [activeScreen, setActiveScreen] = useState<ActiveScreen>("feed");
```

This replaces the current `showTelemetry` boolean and scales to all screens.

### 2.7 Files to Create/Modify

| File | Action |
|---|---|
| `src-tauri/migrations/003_project_sessions.sql` | **Create** — table + backfill |
| `src-tauri/src/models.rs` | **Modify** — add ProjectSession struct |
| `src-tauri/src/db.rs` | **Modify** — add upsert/query/decrement functions, run migration |
| `src-tauri/src/commands.rs` | **Modify** — add get_project_sessions command |
| `src-tauri/src/lib.rs` | **Modify** — register command |
| `src-tauri/src/server.rs` | **Modify** — call upsert_project_session on insert |
| `src/lib/types.ts` | **Modify** — add ProjectSession type |
| `src/lib/api.ts` | **Modify** — add getProjectSessions function |
| `src/hooks/useProjectSessions.ts` | **Create** — data fetching hook |
| `src/components/SessionTracker.tsx` | **Create** — session dashboard screen |
| `src/components/Header.tsx` | **Modify** — add sessions icon button |
| `src/App.tsx` | **Modify** — add screen enum, wire SessionTracker |

---

## 3. Text Expander

### 3.1 Motivation

Espanso is a powerful system-wide text expander, but it runs as a separate daemon with YAML config files. By building a text expander into Dispatch, we get:

- **GUI-first management** — create, edit, search, and organize snippets visually instead of editing YAML
- **Unified tool** — one app for notifications + text expansion, reducing menubar clutter
- **Global palette** — leverage Dispatch's existing global hotkey infrastructure for a search-and-paste workflow
- **SQLite-backed** — snippets stored in the same database, queryable and syncable

### 3.2 How It Differs from Espanso

| Capability | Espanso | Dispatch Expander |
|---|---|---|
| **Activation** | Background daemon intercepts every keystroke | Global hotkey opens search palette; paste into target app |
| **Configuration** | YAML files in `~/.config/espanso/` | GUI in Dispatch app + SQLite storage |
| **Live keystroke matching** | Yes (inline expansion as you type) | No — search-and-paste model instead |
| **Dynamic variables** | `{{date}}`, `{{clipboard}}`, `{{shell}}` | Same — date, clipboard, shell command substitution |
| **Forms** | Yes (popup before expansion) | Yes — inline form fields in the expansion dialog |
| **App-specific configs** | Yes (per-app filter files) | No — snippets are global (simpler model) |
| **Regex triggers** | Yes | No — search-based discovery replaces regex matching |
| **Package ecosystem** | espanso Hub | Import/export JSON (future: sharing) |
| **Rich text** | Markdown/HTML insertion | Plain text + optional Markdown rendering on paste |

### 3.3 Core Concept: Search-and-Paste

Instead of intercepting keystrokes system-wide (which requires accessibility permissions and a background daemon), Dispatch uses a **search palette** model:

1. User presses **`Cmd+Shift+E`** (global hotkey) from any app
2. Dispatch shows a floating search palette (similar to Spotlight/Raycast)
3. User types to filter snippets by trigger, label, or tag
4. User selects a snippet with `Enter`
5. If the snippet has form fields, a form appears for input
6. The expanded text is copied to clipboard and auto-pasted into the previous app

This avoids the complexity and permission requirements of keystroke interception while providing a fast, keyboard-driven workflow.

### 3.4 Data Model

#### 3.4.1 New Table: `snippets`

```sql
CREATE TABLE IF NOT EXISTS snippets (
    id          TEXT PRIMARY KEY,        -- UUID
    trigger     TEXT NOT NULL,           -- short trigger text (e.g., ":sig", ":addr")
    label       TEXT,                    -- human-readable description for search
    body        TEXT NOT NULL,           -- replacement template with {{vars}}
    tags        TEXT,                    -- JSON array of tag strings
    variables   TEXT,                    -- JSON array of variable definitions
    is_enabled  INTEGER NOT NULL DEFAULT 1,
    use_count   INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snippets_trigger ON snippets(trigger);
CREATE INDEX IF NOT EXISTS idx_snippets_use_count ON snippets(use_count DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snippets_trigger_unique ON snippets(trigger);
```

#### 3.4.2 Variable Definitions (JSON in `variables` column)

Each snippet can have variables that get resolved at expansion time:

```json
[
  {
    "name": "date",
    "type": "date",
    "params": { "format": "%Y-%m-%d" }
  },
  {
    "name": "name",
    "type": "form",
    "params": { "label": "Recipient name", "default": "" }
  },
  {
    "name": "clipboard",
    "type": "clipboard"
  },
  {
    "name": "ip",
    "type": "shell",
    "params": { "cmd": "curl -s https://api.ipify.org" }
  }
]
```

#### 3.4.3 Supported Variable Types

| Type | Description | Params |
|---|---|---|
| `echo` | Static value | `{ value: string }` |
| `date` | Date/time formatting | `{ format: string, offset?: number }` — strftime format, optional seconds offset |
| `clipboard` | Current clipboard content | none |
| `shell` | Shell command output | `{ cmd: string }` |
| `form` | User input field | `{ label: string, default?: string, multiline?: boolean }` |
| `choice` | Dropdown selection | `{ label: string, values: string[] }` |
| `random` | Random pick from list | `{ values: string[] }` |

Variables are referenced in `body` as `{{variable_name}}`.

#### 3.4.4 Cursor Positioning

The special token `$|$` in the body indicates where the cursor should be placed after expansion. In the search-and-paste model, this means:
- Text before `$|$` is pasted
- Then the cursor position is noted (for future IDE integration)
- For now: `$|$` is simply stripped, and the full text is pasted

### 3.5 Migration: `004_snippets.sql`

```sql
CREATE TABLE IF NOT EXISTS snippets ( ... );  -- as above

-- Seed a few example snippets
INSERT OR IGNORE INTO snippets (id, trigger, label, body, tags, variables, is_enabled, use_count, created_at, updated_at)
VALUES
  ('seed-1', ':date', 'Current date', '{{date}}', '["utility"]',
   '[{"name":"date","type":"date","params":{"format":"%Y-%m-%d"}}]',
   1, 0, datetime('now'), datetime('now')),
  ('seed-2', ':time', 'Current time', '{{time}}', '["utility"]',
   '[{"name":"time","type":"date","params":{"format":"%H:%M"}}]',
   1, 0, datetime('now'), datetime('now')),
  ('seed-3', ':sig', 'Email signature', E'Best regards,\n{{name}}', '["email"]',
   '[{"name":"name","type":"form","params":{"label":"Your name","default":""}}]',
   1, 0, datetime('now'), datetime('now')),
  ('seed-4', ':shrug', 'Shrug emoji', '\u00AF\\_(\u30C4)_/\u00AF', '["emoji"]',
   '[]', 1, 0, datetime('now'), datetime('now')),
  ('seed-5', ':clip', 'Clipboard contents', '{{clipboard}}', '["utility"]',
   '[{"name":"clipboard","type":"clipboard"}]',
   1, 0, datetime('now'), datetime('now'));
```

Note: Adjust string escaping for SQLite (use `char(10)` for newlines if needed, standard SQL strings for the rest). The seed data provides immediate value on first launch.

### 3.6 Rust Model

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub trigger: String,
    pub label: Option<String>,
    pub body: String,
    pub tags: Option<String>,       // JSON array
    pub variables: Option<String>,  // JSON array
    pub is_enabled: i32,
    pub use_count: i64,
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSnippetRequest {
    pub trigger: String,
    pub label: Option<String>,
    pub body: String,
    pub tags: Option<String>,
    pub variables: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSnippetRequest {
    pub trigger: Option<String>,
    pub label: Option<String>,
    pub body: Option<String>,
    pub tags: Option<String>,
    pub variables: Option<String>,
    pub is_enabled: Option<i32>,
}
```

### 3.7 Database Functions

```rust
pub async fn create_snippet(pool: &SqlitePool, req: &CreateSnippetRequest) -> Result<Snippet, sqlx::Error> { ... }
pub async fn update_snippet(pool: &SqlitePool, id: &str, req: &UpdateSnippetRequest) -> Result<Snippet, sqlx::Error> { ... }
pub async fn delete_snippet(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> { ... }
pub async fn get_snippet(pool: &SqlitePool, id: &str) -> Result<Option<Snippet>, sqlx::Error> { ... }
pub async fn list_snippets(pool: &SqlitePool, search: Option<&str>, tag: Option<&str>) -> Result<Vec<Snippet>, sqlx::Error> { ... }
pub async fn increment_snippet_use(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> { ... }
pub async fn import_snippets(pool: &SqlitePool, snippets: &[CreateSnippetRequest]) -> Result<u64, sqlx::Error> { ... }
pub async fn export_snippets(pool: &SqlitePool) -> Result<Vec<Snippet>, sqlx::Error> { ... }
```

The `list_snippets` function searches across `trigger`, `label`, `body`, and `tags` using LIKE, ordered by `use_count DESC` (most-used first) for the search palette, or `updated_at DESC` for the management screen.

### 3.8 Variable Resolution (Rust)

Create `src-tauri/src/expander.rs` — a dedicated module for variable resolution:

```rust
pub async fn expand_snippet(snippet: &Snippet, form_values: Option<&HashMap<String, String>>) -> Result<String, String> {
    let variables: Vec<VariableDef> = serde_json::from_str(
        snippet.variables.as_deref().unwrap_or("[]")
    ).map_err(|e| e.to_string())?;

    let mut resolved: HashMap<String, String> = HashMap::new();

    for var in &variables {
        let value = match var.var_type.as_str() {
            "echo" => var.params.get("value").cloned().unwrap_or_default(),
            "date" => resolve_date(&var.params)?,
            "clipboard" => resolve_clipboard()?,
            "shell" => resolve_shell(&var.params).await?,
            "form" => {
                form_values
                    .and_then(|fv| fv.get(&var.name))
                    .cloned()
                    .unwrap_or_else(|| var.params.get("default").cloned().unwrap_or_default())
            }
            "choice" => {
                form_values
                    .and_then(|fv| fv.get(&var.name))
                    .cloned()
                    .unwrap_or_default()
            }
            "random" => resolve_random(&var.params)?,
            _ => String::new(),
        };
        resolved.insert(var.name.clone(), value);
    }

    // Replace {{var}} placeholders in body
    let mut result = snippet.body.clone();
    for (name, value) in &resolved {
        result = result.replace(&format!("{{{{{}}}}}", name), value);
    }

    // Strip cursor marker
    result = result.replace("$|$", "");

    Ok(result)
}
```

**Individual resolvers:**

- `resolve_date(params)` — uses `chrono` (already a dep) with `format` and optional `offset` (seconds)
- `resolve_clipboard()` — reads system clipboard via `arboard` crate (lightweight, cross-platform)
- `resolve_shell(params)` — runs `cmd` via `tokio::process::Command`, captures stdout, trims whitespace
- `resolve_random(params)` — picks random item from `values` array using `rand` (or just use `fastrand` which is lightweight)

### 3.9 Tauri Commands

```rust
#[tauri::command]
pub async fn list_snippets(
    state: State<'_, Arc<AppState>>,
    search: Option<String>,
    tag: Option<String>,
) -> Result<Vec<models::Snippet>, String> { ... }

#[tauri::command]
pub async fn create_snippet(
    state: State<'_, Arc<AppState>>,
    trigger: String,
    label: Option<String>,
    body: String,
    tags: Option<String>,
    variables: Option<String>,
) -> Result<models::Snippet, String> { ... }

#[tauri::command]
pub async fn update_snippet(
    state: State<'_, Arc<AppState>>,
    id: String,
    trigger: Option<String>,
    label: Option<String>,
    body: Option<String>,
    tags: Option<String>,
    variables: Option<String>,
    is_enabled: Option<i32>,
) -> Result<models::Snippet, String> { ... }

#[tauri::command]
pub async fn delete_snippet(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> { ... }

#[tauri::command]
pub async fn expand_snippet(
    state: State<'_, Arc<AppState>>,
    id: String,
    form_values: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let snippet = db::get_snippet(&state.db, &id).await
        .map_err(|e| e.to_string())?
        .ok_or("Snippet not found")?;

    let expanded = expander::expand_snippet(&snippet, form_values.as_ref()).await?;

    // Increment use count (fire-and-forget)
    let pool = state.db.clone();
    let sid = id.clone();
    tokio::spawn(async move { let _ = db::increment_snippet_use(&pool, &sid).await; });

    // Record telemetry
    let tpool = state.db.clone();
    tokio::spawn(async move {
        let _ = db::record_telemetry(&tpool, "snippet_expanded", Some(&id), None, None, None).await;
    });

    Ok(expanded)
}

#[tauri::command]
pub async fn import_snippets(
    state: State<'_, Arc<AppState>>,
    snippets_json: String,
) -> Result<u64, String> { ... }

#[tauri::command]
pub async fn export_snippets(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<models::Snippet>, String> { ... }
```

### 3.10 New Cargo Dependencies

```toml
arboard = "3"     # Clipboard read/write
```

`chrono` and `tokio` are already dependencies. `rand` is not needed — use `fastrand` (zero-dep) or just `std` random for the `random` variable type.

### 3.11 Global Expander Hotkey

Register a second global shortcut in `lib.rs`:

```rust
let expander_shortcut: Shortcut = "CommandOrControl+Shift+E".parse().unwrap();
```

When pressed:
1. Show the Dispatch window (if hidden)
2. Emit a `"show-expander-palette"` Tauri event to the frontend
3. Frontend listens for this event and opens the search palette overlay

This reuses the existing window show/focus mechanism and adds a targeted event.

### 3.12 Frontend

#### 3.12.1 Types

Add to `src/lib/types.ts`:
```typescript
export interface Snippet {
  id: string;
  trigger: string;
  label: string | null;
  body: string;
  tags: string | null;       // JSON array string
  variables: string | null;  // JSON array string
  is_enabled: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SnippetVariable {
  name: string;
  type: "echo" | "date" | "clipboard" | "shell" | "form" | "choice" | "random";
  params: Record<string, unknown>;
}
```

#### 3.12.2 API: `src/lib/snippets.ts`

```typescript
export async function listSnippets(search?: string, tag?: string): Promise<Snippet[]> { ... }
export async function createSnippet(data: { trigger: string; label?: string; body: string; tags?: string; variables?: string }): Promise<Snippet> { ... }
export async function updateSnippet(id: string, data: Partial<{ trigger: string; label: string; body: string; tags: string; variables: string; is_enabled: number }>): Promise<Snippet> { ... }
export async function deleteSnippet(id: string): Promise<boolean> { ... }
export async function expandSnippet(id: string, formValues?: Record<string, string>): Promise<string> { ... }
export async function importSnippets(json: string): Promise<number> { ... }
export async function exportSnippets(): Promise<Snippet[]> { ... }
```

#### 3.12.3 Expander Search Palette: `src/components/ExpanderPalette.tsx`

A floating overlay (like Spotlight) that appears on `Cmd+Shift+E`:

```
┌──────────────────────────────────────┐
│  🔍 Search snippets...               │
├──────────────────────────────────────┤
│  :sig     Email signature        ↵   │  ← highlighted
│  :date    Current date               │
│  :time    Current time               │
│  :addr    Office address             │
│  :clip    Clipboard contents         │
│  :ip      Public IP address          │
└──────────────────────────────────────┘
```

**Behavior**:
- Full keyboard navigation (`j`/`k` or `Up`/`Down` to move, `Enter` to select, `Escape` to close)
- Fuzzy search across trigger, label, body, and tags
- If selected snippet has `form` or `choice` variables, show inline form fields before expanding
- After expansion: copy to clipboard, hide Dispatch, paste into previous app (via simulated `Cmd+V`)
- Results sorted by `use_count DESC` (most-used first) then by match relevance

**Form Fields Inline**:
When a snippet with form variables is selected and `Enter` is pressed, the palette transitions to a form view:

```
┌──────────────────────────────────────┐
│  :sig — Email signature              │
├──────────────────────────────────────┤
│  Recipient name:                     │
│  ┌──────────────────────────────┐    │
│  │ John Doe                     │    │
│  └──────────────────────────────┘    │
│                                      │
│           [Cancel]  [Expand ↵]       │
└──────────────────────────────────────┘
```

**Props**:
```typescript
interface ExpanderPaletteProps {
  onClose: () => void;
  onExpand: (text: string) => void;
}
```

#### 3.12.4 Snippet Manager Screen: `src/components/SnippetManager.tsx`

The full management UI accessible from the Header (like telemetry/sessions screens):

```
┌──────────────────────────────────┐
│ ← Back      🔍 filter...   [+]  │  ← search + add button
├──────────────────────────────────┤
│                                  │
│  :sig     Email signature        │
│  Best regards, {{name}}          │  ← body preview (truncated)
│  #email · used 42x              │  ← tags + use count
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│  :date    Current date           │
│  {{date}}                        │
│  #utility · used 23x            │
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│  ...                             │
│                                  │
├──────────────────────────────────┤
│  [Import] [Export]               │  ← bottom action bar
└──────────────────────────────────┘
```

Clicking a snippet opens an **edit view** (inline or as a slide-over):

```
┌──────────────────────────────────┐
│ ← Back to list       [Delete]    │
├──────────────────────────────────┤
│  Trigger                         │
│  ┌──────────────────────────────┐│
│  │ :sig                         ││
│  └──────────────────────────────┘│
│                                  │
│  Label                           │
│  ┌──────────────────────────────┐│
│  │ Email signature              ││
│  └──────────────────────────────┘│
│                                  │
│  Body                            │
│  ┌──────────────────────────────┐│
│  │ Best regards,                ││
│  │ {{name}}                     ││
│  └──────────────────────────────┘│
│                                  │
│  Variables                       │
│  ┌─────────────────────────────┐ │
│  │ name (form)  [Edit] [✕]    │ │
│  └─────────────────────────────┘ │
│  [+ Add Variable]                │
│                                  │
│  Tags                            │
│  ┌──────────────────────────────┐│
│  │ email, work                  ││
│  └──────────────────────────────┘│
│                                  │
│  Enabled: [toggle]               │
│                                  │
│  [Save]                          │
└──────────────────────────────────┘
```

**Variable Editor** (shown when editing a variable):
- Type dropdown: echo, date, clipboard, shell, form, choice, random
- Params fields change based on type selection
- For `shell`: a command input
- For `date`: a format string input + offset
- For `form`: label, default value, multiline toggle
- For `choice`: label + values list (add/remove)
- For `random`: values list

#### 3.12.5 Hook: `src/hooks/useSnippets.ts`

```typescript
export function useSnippets(search?: string, tag?: string) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loading, setLoading] = useState(true);
  // ... standard fetch pattern
  return { snippets, loading, refresh };
}
```

#### 3.12.6 Clipboard + Auto-Paste

After expanding a snippet, the frontend:
1. Copies expanded text to clipboard via `navigator.clipboard.writeText()`
2. Hides the Dispatch window via Tauri window API
3. Sends a simulated `Cmd+V` keystroke to paste into the previously focused app

For step 3, use Tauri's window hide (which returns focus to the previous app) followed by a short delay and a simulated paste. This can be done from Rust:

```rust
// After hiding the window, simulate Cmd+V
#[cfg(target_os = "macos")]
fn simulate_paste() {
    std::process::Command::new("osascript")
        .args(&["-e", r#"tell application "System Events" to keystroke "v" using command down"#])
        .spawn()
        .ok();
}
```

This requires Accessibility permissions on macOS (same as any paste automation). If that's not available, the user simply does `Cmd+V` manually — the text is already on the clipboard.

### 3.13 Telemetry Integration

Add new event type: `snippet_expanded` — recorded automatically in the `expand_snippet` command (already shown in 3.9).

### 3.14 Files to Create/Modify

| File | Action |
|---|---|
| `src-tauri/migrations/004_snippets.sql` | **Create** — snippets table + seed data |
| `src-tauri/src/expander.rs` | **Create** — variable resolution engine |
| `src-tauri/src/models.rs` | **Modify** — add Snippet, CreateSnippetRequest, UpdateSnippetRequest |
| `src-tauri/src/db.rs` | **Modify** — add CRUD + expand + import/export functions, run migration |
| `src-tauri/src/commands.rs` | **Modify** — add 7 snippet commands |
| `src-tauri/src/lib.rs` | **Modify** — register commands, add `mod expander`, register Cmd+Shift+E hotkey |
| `src-tauri/Cargo.toml` | **Modify** — add `arboard` dep |
| `src/lib/types.ts` | **Modify** — add Snippet, SnippetVariable types |
| `src/lib/snippets.ts` | **Create** — frontend snippet API |
| `src/hooks/useSnippets.ts` | **Create** — data fetching hook |
| `src/components/ExpanderPalette.tsx` | **Create** — search-and-expand overlay |
| `src/components/SnippetManager.tsx` | **Create** — CRUD management screen |
| `src/components/Header.tsx` | **Modify** — add sessions + expander icon buttons |
| `src/App.tsx` | **Modify** — screen enum, wire new screens + palette |

---

## 4. Navigation Refactor

Both features require a screen navigation refactor. The current boolean toggles (`showTelemetry`) don't scale.

### 4.1 Screen Enum

```typescript
type ActiveScreen = "feed" | "telemetry" | "sessions" | "expander";
const [activeScreen, setActiveScreen] = useState<ActiveScreen>("feed");
```

### 4.2 Header Icons (left to right in the right-side group)

| Icon | Screen | SVG Description |
|---|---|---|
| Grid (2x2) | Sessions | Four squares in a grid |
| Bar chart | Telemetry | Three vertical bars |
| Brackets `</>` | Expander | Code/snippet icon |
| Keyboard | Help overlay | Keyboard rectangle |
| "Read All" | — | Text button |
| "Clear" | — | Text button |

Each icon button highlights (e.g., `text-accent` instead of `text-text-tertiary`) when its screen is active.

### 4.3 Conditional Rendering in App.tsx

```tsx
{activeScreen === "feed" && (
  <>
    <FilterBar ... />
    <NotificationFeed ... />
  </>
)}
{activeScreen === "telemetry" && <TelemetryScreen onBack={() => setActiveScreen("feed")} />}
{activeScreen === "sessions" && <SessionTracker onBack={() => setActiveScreen("feed")} onFocusTerminal={handleFocusTerminal} />}
{activeScreen === "expander" && <SnippetManager onBack={() => setActiveScreen("feed")} />}
```

The expander palette is a separate overlay (not a screen) — it floats above everything:
```tsx
{showExpanderPalette && <ExpanderPalette onClose={() => setShowPalette(false)} onExpand={handleExpand} />}
```

---

## 5. Implementation Order

### Phase 1: Navigation Refactor
- Replace boolean screen toggles with `ActiveScreen` enum
- Update Header with all icon buttons
- No new features, just plumbing
- **Estimate: 1 session**

### Phase 2: Session Tracker Backend
- Migration 003, models, DB functions (upsert/query/decrement)
- Hook into existing notification CRUD to maintain session state
- **Estimate: 1 session**

### Phase 3: Session Tracker Frontend
- SessionTracker component, useProjectSessions hook, types
- Wire into App.tsx
- **Estimate: 1 session**

### Phase 4: Text Expander Backend
- Migration 004, expander module, models, DB functions, commands
- `arboard` dep for clipboard
- **Estimate: 1-2 sessions**

### Phase 5: Snippet Manager Frontend
- SnippetManager component (list + editor), useSnippets hook, API client
- Full CRUD UI with variable editor
- **Estimate: 1-2 sessions**

### Phase 6: Expander Palette + Global Hotkey
- ExpanderPalette component with search + inline forms
- Cmd+Shift+E global hotkey registration
- Clipboard copy + auto-paste flow
- **Estimate: 1-2 sessions**

### Parallelization Strategy

These can be parallelized across worktrees:
- **Worktree A**: Phase 2 (Session Tracker backend — Rust only)
- **Worktree B**: Phase 4 (Text Expander backend — Rust only)
- **Worktree C**: Phase 1 (Navigation refactor — frontend only, no Rust conflicts)

After merging those:
- **Worktree D**: Phase 3 (Session Tracker frontend)
- **Worktree E**: Phase 5 + 6 (Snippet Manager + Palette)

---

## 6. Verification Checklist

### Session Tracker
- [ ] `cargo check` passes with migration 003
- [ ] `npx tsc --noEmit` passes
- [ ] Send notifications from 3+ different projects
- [ ] Session tracker shows all projects with correct last notification
- [ ] New notification updates the corresponding project row
- [ ] Marking all read zeros out all unread counts
- [ ] Deleting a notification updates counts
- [ ] Search filters projects by name
- [ ] Clicking a row with tmux context focuses the terminal

### Text Expander
- [ ] `cargo check` passes with migration 004 and `arboard` dep
- [ ] `npx tsc --noEmit` passes
- [ ] Seed snippets appear on first launch
- [ ] Can create, edit, delete snippets via SnippetManager
- [ ] `{{date}}` and `{{clipboard}}` variables resolve correctly
- [ ] `{{shell}}` variables execute and capture output
- [ ] Form variables show input fields before expansion
- [ ] Choice variables show dropdown before expansion
- [ ] `Cmd+Shift+E` opens the expander palette from any app
- [ ] Search palette filters by trigger, label, and tags
- [ ] Selecting a snippet copies expanded text to clipboard
- [ ] Import/export works with JSON format
- [ ] Use count increments on each expansion
- [ ] `snippet_expanded` telemetry event is recorded

### Navigation
- [ ] All 4 header icons work and highlight when active
- [ ] Switching screens preserves notification feed state (filter, search)
- [ ] Back buttons return to feed
- [ ] Help overlay still works across all screens
