# Spec: Hotkeys, Auto-Read on Focus, and Telemetry

## Status: Draft
## Branch: `spec/hotkeys-telemetry`

---

## 1. Overview

Three features that make Dispatch faster to use and easier to understand over time:

1. **In-app hotkeys** — keyboard shortcuts while the Dispatch window is focused
2. **Global hotkey** — a system-wide toggle to summon/dismiss Dispatch from any app
3. **Auto-mark-read on terminal focus** — clicking the terminal button marks the notification as read
4. **Interaction telemetry** — track how you use Dispatch over time, with a dedicated analytics screen

---

## 2. In-App Hotkeys

### 2.1 Motivation

Dispatch is a narrow feed of notifications. Power users should be able to triage entirely from the keyboard: navigate, read, delete, focus terminal — without touching the mouse.

### 2.2 Keybindings

| Key | Action | Context |
|---|---|---|
| `j` / `ArrowDown` | Select next notification | Feed |
| `k` / `ArrowUp` | Select previous notification | Feed |
| `Enter` / `r` | Mark selected as read | Feed, notification selected |
| `d` / `Backspace` | Delete selected notification | Feed, notification selected |
| `t` | Focus terminal (if tmux context exists) | Feed, notification selected |
| `Shift+R` | Mark all as read | Feed |
| `Shift+D` | Clear all notifications | Feed |
| `f` | Focus search input | Any |
| `Escape` | Clear search / deselect notification | Any |
| `1` | Filter: All | Any |
| `2` | Filter: Unread | Any |
| `3` | Filter: Read | Any |
| `?` | Show hotkey help overlay | Any |

### 2.3 Implementation

#### 2.3.1 Selection State

Add `selectedIndex: number | null` to App component state. This tracks which notification in the current list is "focused" via keyboard.

```typescript
// src/App.tsx
const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
```

Reset `selectedIndex` to `null` when filters/search change or notifications reload.

#### 2.3.2 Keyboard Handler Hook

Create `src/hooks/useHotkeys.ts`:

```typescript
interface HotkeyActions {
  selectNext: () => void;
  selectPrev: () => void;
  markSelectedRead: () => void;
  deleteSelected: () => void;
  focusTerminal: () => void;
  markAllRead: () => void;
  clearAll: () => void;
  focusSearch: () => void;
  clearSelection: () => void;
  setFilter: (filter: "all" | "unread" | "read") => void;
  toggleHelp: () => void;
}

export function useHotkeys(actions: HotkeyActions): void {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Skip if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
          actions.clearSelection();
        }
        return;
      }

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          actions.selectNext();
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          actions.selectPrev();
          break;
        case "Enter":
        case "r":
          actions.markSelectedRead();
          break;
        case "d":
        case "Backspace":
          actions.deleteSelected();
          break;
        case "t":
          actions.focusTerminal();
          break;
        case "R":
          actions.markAllRead();
          break;
        case "D":
          actions.clearAll();
          break;
        case "f":
          e.preventDefault();
          actions.focusSearch();
          break;
        case "Escape":
          actions.clearSelection();
          break;
        case "1":
          actions.setFilter("all");
          break;
        case "2":
          actions.setFilter("unread");
          break;
        case "3":
          actions.setFilter("read");
          break;
        case "?":
          actions.toggleHelp();
          break;
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [actions]);
}
```

#### 2.3.3 Visual Selection Indicator

In `NotificationCard.tsx`, accept an `isSelected` prop. When true, apply a left-border accent and slightly different background:

```
className={`... ${isSelected ? "ring-1 ring-accent/40 bg-surface-overlay" : ""}`}
```

Auto-scroll selected card into view using a ref + `scrollIntoView({ block: "nearest" })`.

#### 2.3.4 Help Overlay

Create `src/components/HotkeyHelp.tsx` — a simple modal/overlay listing all keybindings in a two-column grid. Dismiss with `Escape` or `?`.

#### 2.3.5 Files to Create/Modify

| File | Action |
|---|---|
| `src/hooks/useHotkeys.ts` | **Create** — keyboard event handler |
| `src/components/HotkeyHelp.tsx` | **Create** — help overlay component |
| `src/App.tsx` | **Modify** — add selectedIndex state, wire useHotkeys, pass isSelected to feed |
| `src/components/NotificationFeed.tsx` | **Modify** — accept/forward selectedIndex prop |
| `src/components/NotificationCard.tsx` | **Modify** — accept isSelected prop, scroll-into-view |
| `src/components/FilterBar.tsx` | **Modify** — expose ref to search input for programmatic focus |

---

## 3. Global Hotkey (Toggle Dispatch Window)

### 3.1 Motivation

Users want to summon Dispatch from any application with a single keystroke — like Spotlight or Alfred. Press once to show, press again to hide.

### 3.2 Chosen Approach: `tauri-plugin-global-shortcut`

Tauri v2 provides `tauri-plugin-global-shortcut` which registers OS-level hotkeys. This is the cleanest approach — no polling, no external deps, proper cleanup.

### 3.3 Default Hotkey

`Ctrl+Shift+D` (macOS: `Cmd+Shift+D`)

Stored in the existing `settings` table so it can be changed at runtime.

### 3.4 Implementation

#### 3.4.1 Install Plugin

```toml
# src-tauri/Cargo.toml
tauri-plugin-global-shortcut = "2"
```

```json
// src-tauri/capabilities/default.json — add to permissions[]
"global-shortcut:default"
```

#### 3.4.2 Register on Startup

In `src-tauri/src/lib.rs`, within the `.setup()` closure:

```rust
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// After tray setup
let shortcut: Shortcut = "CommandOrControl+Shift+D".parse().unwrap();
app.handle().plugin(
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(),
)?;
app.global_shortcut().register(shortcut)?;
```

#### 3.4.3 Settings UI (Optional, Phase 2)

A small settings panel where users can rebind the global hotkey. The new binding is:
1. Saved to `settings` table (`key = "global_hotkey"`)
2. Old shortcut unregistered, new one registered

For Phase 1, hardcode `Ctrl+Shift+D`.

#### 3.4.4 Files to Create/Modify

| File | Action |
|---|---|
| `src-tauri/Cargo.toml` | **Modify** — add `tauri-plugin-global-shortcut` dep |
| `src-tauri/capabilities/default.json` | **Modify** — add `global-shortcut:default` permission |
| `src-tauri/src/lib.rs` | **Modify** — register plugin + shortcut in setup |

---

## 4. Auto-Mark-Read on Terminal Focus

### 4.1 Motivation

If you click the terminal button, you're acknowledging the notification. It should automatically mark as read.

### 4.2 Implementation

This is a one-line change in the `handleFocusTerminal` callback in `App.tsx`. Before calling `focusTerminal()`, call `markRead()` on the notification.

The `NotificationCard` already receives the notification object and the `onFocusTerminal` callback. We need to also pass the notification ID to the focus handler.

#### 4.2.1 Change Signature

```typescript
// Current
onFocusTerminal: (session: string, window: string | null, pane: string | null) => void;

// New — add notification ID
onFocusTerminal: (id: string, session: string, window: string | null, pane: string | null) => void;
```

#### 4.2.2 Update App.tsx Handler

```typescript
const handleFocusTerminal = useCallback(
  async (id: string, session: string, window: string | null, pane: string | null) => {
    // Mark as read first (fire-and-forget, don't block focus)
    markRead(id);
    await focusTerminal(session, window ?? undefined, pane ?? undefined);
  },
  [markRead]
);
```

#### 4.2.3 Update NotificationCard.tsx Call Site

```tsx
onFocusTerminal(n.id, n.tmux_session!, n.tmux_window, n.tmux_pane);
```

#### 4.2.4 Files to Modify

| File | Action |
|---|---|
| `src/App.tsx` | **Modify** — update handler to call markRead |
| `src/components/NotificationCard.tsx` | **Modify** — pass `n.id` as first arg |
| `src/components/NotificationFeed.tsx` | **Modify** — update prop type |

---

## 5. Interaction Telemetry

### 5.1 Motivation

Track how you interact with Dispatch over time: what gets read, deleted, focused; when you're most active; which sources generate the most noise. This data lives locally in libSQL (SQLite-compatible) and powers a dedicated analytics screen.

### 5.2 Data Model

#### 5.2.1 New Table: `telemetry_events`

```sql
CREATE TABLE IF NOT EXISTS telemetry_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,          -- see enum below
    target_id   TEXT,                   -- notification ID (nullable for app-level events)
    source      TEXT,                   -- notification source at time of event
    project     TEXT,                   -- notification project at time of event
    metadata    TEXT,                   -- JSON blob for event-specific data
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_telemetry_event_type ON telemetry_events(event_type);
CREATE INDEX idx_telemetry_created_at ON telemetry_events(created_at);
CREATE INDEX idx_telemetry_source ON telemetry_events(source);
```

#### 5.2.2 Event Types

| Event Type | Trigger | Metadata |
|---|---|---|
| `notification_received` | New notification arrives via HTTP | `{ source, event_type, project }` |
| `notification_read` | User marks as read (click/hotkey/terminal-focus) | `{ method: "click" \| "hotkey" \| "terminal_focus" \| "mark_all" }` |
| `notification_deleted` | User deletes a notification | `{ method: "click" \| "hotkey" }` |
| `terminal_focused` | User clicks terminal button or presses `t` | `{ session, window, pane }` |
| `app_shown` | Window becomes visible (tray click / global hotkey) | `{ trigger: "tray" \| "hotkey" }` |
| `app_hidden` | Window hidden | `{ trigger: "close_button" \| "hotkey" }` |
| `search_performed` | User types in search (debounced 1s) | `{ query_length }` |
| `filter_changed` | User switches filter tab | `{ filter: "all" \| "unread" \| "read" }` |
| `clear_all` | User clears all notifications | `{ count }` |

#### 5.2.3 Rust Model

```rust
// src-tauri/src/models.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryEvent {
    pub id: i64,
    pub event_type: String,
    pub target_id: Option<String>,
    pub source: Option<String>,
    pub project: Option<String>,
    pub metadata: Option<String>,
    pub created_at: String,
}
```

### 5.3 Backend Implementation

#### 5.3.1 Migration

Create `src-tauri/migrations/002_telemetry.sql` with the schema above.

Update `db::init_db()` to run the new migration (currently it runs `001_initial.sql` inline — add `002_telemetry.sql` in the same pattern).

#### 5.3.2 Database Functions

Add to `src-tauri/src/db.rs`:

```rust
pub async fn record_telemetry(
    pool: &SqlitePool,
    event_type: &str,
    target_id: Option<&str>,
    source: Option<&str>,
    project: Option<&str>,
    metadata: Option<&str>,
) -> Result<(), sqlx::Error> { ... }

pub async fn query_telemetry(
    pool: &SqlitePool,
    event_type: Option<&str>,
    from: Option<&str>,       // ISO timestamp
    to: Option<&str>,         // ISO timestamp
    limit: Option<i64>,
) -> Result<Vec<TelemetryEvent>, sqlx::Error> { ... }

pub async fn get_telemetry_summary(
    pool: &SqlitePool,
    from: &str,
    to: &str,
) -> Result<TelemetrySummary, sqlx::Error> { ... }
```

#### 5.3.3 Summary Query

The summary endpoint returns pre-aggregated stats for a time range:

```rust
pub struct TelemetrySummary {
    pub total_received: i64,
    pub total_read: i64,
    pub total_deleted: i64,
    pub total_terminal_focuses: i64,
    pub total_app_opens: i64,
    pub avg_time_to_read_seconds: Option<f64>,   // AVG(read_at - created_at)
    pub busiest_hour: Option<i32>,               // 0-23
    pub top_sources: Vec<(String, i64)>,         // source → count
    pub events_by_day: Vec<(String, i64)>,       // date → count
    pub reads_by_method: Vec<(String, i64)>,     // method → count
}
```

This is computed with a few SQL queries:

```sql
-- Total counts by event_type
SELECT event_type, COUNT(*) as count
FROM telemetry_events
WHERE created_at BETWEEN ? AND ?
GROUP BY event_type;

-- Average time-to-read (join notifications table)
SELECT AVG(
    (julianday(n.read_at) - julianday(n.created_at)) * 86400
) as avg_seconds
FROM notifications n
WHERE n.read_at IS NOT NULL
  AND n.created_at BETWEEN ? AND ?;

-- Busiest hour
SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
FROM telemetry_events
WHERE event_type = 'notification_received'
  AND created_at BETWEEN ? AND ?
GROUP BY hour
ORDER BY count DESC
LIMIT 1;

-- Top sources
SELECT source, COUNT(*) as count
FROM telemetry_events
WHERE source IS NOT NULL
  AND created_at BETWEEN ? AND ?
GROUP BY source
ORDER BY count DESC
LIMIT 10;

-- Events by day (for sparkline/chart)
SELECT date(created_at) as day, COUNT(*) as count
FROM telemetry_events
WHERE created_at BETWEEN ? AND ?
GROUP BY day
ORDER BY day;

-- Reads by method
SELECT json_extract(metadata, '$.method') as method, COUNT(*) as count
FROM telemetry_events
WHERE event_type = 'notification_read'
  AND created_at BETWEEN ? AND ?
GROUP BY method;
```

#### 5.3.4 Tauri Commands

```rust
// src-tauri/src/commands.rs

#[tauri::command]
pub async fn record_telemetry_event(
    state: State<'_, Arc<AppState>>,
    event_type: String,
    target_id: Option<String>,
    source: Option<String>,
    project: Option<String>,
    metadata: Option<String>,
) -> Result<(), String> { ... }

#[tauri::command]
pub async fn get_telemetry_summary(
    state: State<'_, Arc<AppState>>,
    from: String,
    to: String,
) -> Result<TelemetrySummary, String> { ... }

#[tauri::command]
pub async fn get_telemetry_events(
    state: State<'_, Arc<AppState>>,
    event_type: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<TelemetryEvent>, String> { ... }
```

Register all three in `invoke_handler` in `lib.rs`.

### 5.4 Frontend Implementation

#### 5.4.1 Telemetry API

Create `src/lib/telemetry.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";

export type TelemetryEventType =
  | "notification_received"
  | "notification_read"
  | "notification_deleted"
  | "terminal_focused"
  | "app_shown"
  | "app_hidden"
  | "search_performed"
  | "filter_changed"
  | "clear_all";

export async function trackEvent(
  eventType: TelemetryEventType,
  opts?: {
    targetId?: string;
    source?: string;
    project?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  return invoke("record_telemetry_event", {
    eventType,
    targetId: opts?.targetId ?? null,
    source: opts?.source ?? null,
    project: opts?.project ?? null,
    metadata: opts?.metadata ? JSON.stringify(opts.metadata) : null,
  });
}

export interface TelemetrySummary {
  total_received: number;
  total_read: number;
  total_deleted: number;
  total_terminal_focuses: number;
  total_app_opens: number;
  avg_time_to_read_seconds: number | null;
  busiest_hour: number | null;
  top_sources: [string, number][];
  events_by_day: [string, number][];
  reads_by_method: [string, number][];
}

export async function getTelemetrySummary(from: string, to: string): Promise<TelemetrySummary> {
  return invoke("get_telemetry_summary", { from, to });
}
```

#### 5.4.2 Instrumentation Points

Track events at the call sites in `App.tsx` (and the hotkey handler):

| Action | Where to call `trackEvent` |
|---|---|
| Mark read (click) | `markRead()` call in NotificationCard onClick |
| Mark read (hotkey) | `markSelectedRead()` in useHotkeys actions |
| Mark read (terminal focus) | `handleFocusTerminal` |
| Mark all read | `markAllRead()` handler |
| Delete (click) | `handleDelete` |
| Delete (hotkey) | `deleteSelected()` in useHotkeys actions |
| Terminal focus | `handleFocusTerminal` |
| Filter change | `setFilter` handler |
| Search | Debounced in `FilterBar` (1s after typing stops) |
| Clear all | `clearAll()` handler |

Server-side events (recorded in Rust, not from frontend):
| Action | Where |
|---|---|
| `notification_received` | `server.rs` create_notification handler |
| `app_shown` / `app_hidden` | `lib.rs` tray click handler, global shortcut handler |

#### 5.4.3 Telemetry Screen

New route/view: `src/components/TelemetryScreen.tsx`

**Navigation**: Add a small bar-chart icon button to the `Header` component (next to the existing action buttons). Clicking it toggles between the notification feed and the telemetry screen.

**Layout** (single scrollable column, 420px wide to match the app):

```
┌──────────────────────────────────┐
│ ← Back to Feed        Last 7d ▾ │  ← Time range selector
├──────────────────────────────────┤
│                                  │
│  ┌──────┐ ┌──────┐ ┌──────┐    │
│  │  142 │ │   98 │ │   12 │    │  ← Stat cards
│  │ Recv │ │ Read │ │ Term │    │
│  └──────┘ └──────┘ └──────┘    │
│                                  │
│  Avg Time to Read: 4m 32s       │
│  Busiest Hour: 2:00 PM          │
│                                  │
├──────────────────────────────────┤
│  Activity (last 7 days)         │
│  ▁▃▇▅▂▆▄                       │  ← Bar chart (CSS-only)
│  M T W T F S S                  │
├──────────────────────────────────┤
│  Top Sources                    │
│  ░░░░░░░░░░░░░░░░  github  62  │  ← Horizontal bars
│  ░░░░░░░░░          build   34  │
│  ░░░░               ci      18  │
├──────────────────────────────────┤
│  How You Read                   │
│  ● 54% click                    │  ← Simple breakdown
│  ● 28% hotkey                   │
│  ● 12% terminal focus           │
│  ● 6%  mark all                 │
├──────────────────────────────────┤
│  Recent Events                  │
│  • terminal_focused  3m ago     │  ← Last 20 events
│  • notification_read 5m ago     │
│  • ...                          │
└──────────────────────────────────┘
```

**Time range selector**: Dropdown with options: `Today`, `Last 7 days` (default), `Last 30 days`, `All time`.

**No external chart library**. All visualizations are CSS-only:
- Bar chart: `div` elements with dynamic `height` percentages
- Horizontal bars: `div` elements with dynamic `width` percentages
- Stat cards: simple `div` grid

#### 5.4.4 Hook: `useTelemetry`

```typescript
// src/hooks/useTelemetry.ts
export function useTelemetry(from: string, to: string) {
  const [summary, setSummary] = useState<TelemetrySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const data = await getTelemetrySummary(from, to);
    setSummary(data);
    setLoading(false);
  }, [from, to]);

  useEffect(() => { refresh(); }, [refresh]);

  return { summary, loading, refresh };
}
```

### 5.5 Files to Create/Modify

| File | Action |
|---|---|
| `src-tauri/migrations/002_telemetry.sql` | **Create** — telemetry table + indexes |
| `src-tauri/src/models.rs` | **Modify** — add TelemetryEvent, TelemetrySummary structs |
| `src-tauri/src/db.rs` | **Modify** — add record/query/summary functions, run migration |
| `src-tauri/src/commands.rs` | **Modify** — add 3 telemetry commands |
| `src-tauri/src/lib.rs` | **Modify** — register telemetry commands |
| `src-tauri/src/server.rs` | **Modify** — record `notification_received` event |
| `src/lib/telemetry.ts` | **Create** — frontend telemetry API + types |
| `src/hooks/useTelemetry.ts` | **Create** — data fetching hook |
| `src/components/TelemetryScreen.tsx` | **Create** — analytics view |
| `src/components/Header.tsx` | **Modify** — add telemetry toggle button |
| `src/App.tsx` | **Modify** — add screen toggle state, instrument all actions |

---

## 6. Migration Strategy

### Database

Migrations are run sequentially in `db::init_db()`. The existing pattern runs SQL inline. Add `002_telemetry.sql` the same way:

```rust
pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Existing 001_initial.sql ...
    sqlx::raw_sql(include_str!("../migrations/001_initial.sql"))
        .execute(pool).await?;

    // New telemetry migration
    sqlx::raw_sql(include_str!("../migrations/002_telemetry.sql"))
        .execute(pool).await?;

    Ok(())
}
```

Both migrations use `CREATE TABLE IF NOT EXISTS`, so they're idempotent and safe to re-run.

### No libSQL migration needed

The spec calls for libSQL, but the existing app already uses SQLx with SQLite. libSQL is a SQLite fork with full compatibility. The current `sqlx` + `sqlite` driver works identically with libSQL databases. If we want to switch the driver to `libsql` crate later (for features like embedded replicas), that's a future concern. For now, the existing SQLite setup stores telemetry just fine — same database file, same connection pool.

---

## 7. Implementation Order

### Phase 1: Auto-mark-read on terminal focus
- Smallest change, 3 files modified
- No new dependencies
- **Estimate: 1 session**

### Phase 2: In-app hotkeys
- New hook + help overlay
- Selection state through component tree
- **Estimate: 1 session**

### Phase 3: Telemetry backend
- Migration, Rust models, DB functions, commands
- Server-side recording
- **Estimate: 1 session**

### Phase 4: Telemetry frontend
- Telemetry API, screen component, hook
- Instrument all existing actions
- **Estimate: 1-2 sessions**

### Phase 5: Global hotkey
- Plugin install + registration
- **Estimate: 1 session**

---

## 8. Verification Checklist

### Auto-mark-read
- [ ] Click terminal button on unread notification → dot disappears, notification moves to "read"
- [ ] Hotkey `t` on selected unread notification → same behavior

### In-app hotkeys
- [ ] `j`/`k` navigates the list, selected card is visually highlighted
- [ ] `Enter` marks selected as read
- [ ] `d` deletes selected, selection moves to next
- [ ] `t` focuses terminal (only when tmux context present)
- [ ] `f` focuses search, `Escape` clears
- [ ] `?` shows/hides help overlay
- [ ] Filter keys `1`/`2`/`3` switch tabs
- [ ] No hotkey interference when typing in search

### Global hotkey
- [ ] `Cmd+Shift+D` shows Dispatch when hidden
- [ ] `Cmd+Shift+D` hides Dispatch when visible
- [ ] Works from any app (tested from Kitty, browser, Finder)

### Telemetry
- [ ] `cargo build` passes with new migration
- [ ] `npx tsc --noEmit` passes
- [ ] New notifications create `notification_received` events
- [ ] All user actions create corresponding telemetry events
- [ ] Telemetry screen loads and shows summary data
- [ ] Time range selector works (today, 7d, 30d, all)
- [ ] CSS bar charts render proportionally
- [ ] No performance regression (telemetry writes are fire-and-forget)

### Cargo / TypeScript
- [ ] `cargo check` in `src-tauri/` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `bun run build` succeeds (if applicable)
