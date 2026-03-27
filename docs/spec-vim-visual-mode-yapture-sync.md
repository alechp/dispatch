# Spec: Vim Visual Mode, Auto-Focus, and Bidirectional Yapture Sync

## Overview

Three interconnected features that minimize mouse interaction and create a closed loop between Dispatch and Yapture:

1. **Auto-focus on global hotkey** — CMD+SHIFT+D shows window AND selects most recent notification
2. **Visual mode** — Multi-select notifications for bulk clear/complete
3. **Bidirectional Yapture sync** — Clearing or terminal-focusing a notification in Dispatch completes the corresponding Yapture task; `#@dispatch` workspace tag on all Dispatch-generated tasks

---

## 1. Auto-Focus Most Recent Notification on Global Hotkey

### Problem

Currently CMD+SHIFT+D toggles the window but leaves `selectedIndex = null`. The user must press `j` once to enter vim navigation. This extra keystroke breaks flow.

### Behavior

When the global hotkey **shows** the window (not hides):
1. Show + focus the window (existing behavior)
2. Emit a new event `"auto-select-first"` to the frontend
3. Frontend sets `selectedIndex = 0` (most recent notification) and scrolls it into view
4. If notification list is empty, `selectedIndex` stays `null`

When the hotkey **hides** the window: no change — just hide.

### Changes

#### `src-tauri/src/lib.rs` — Global shortcut handler

In the `"toggle_window"` match arm (~line 520), after `window.show()` + `window.set_focus()`:

```rust
"toggle_window" => {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("auto-select-first", ());  // NEW
    }
}
```

#### `src/App.tsx` — Listen for auto-select event

Add a Tauri event listener (alongside the existing `"show-expander-palette"` listener):

```typescript
const unlisten = await listen("auto-select-first", () => {
  if (notifications.length > 0) {
    setSelectedIndex(0);
  }
});
```

Also reset `selectedIndex` to 0 on window re-focus if it's currently `null` and there are notifications. This handles edge cases where the event fires before notifications load.

### Verification

- CMD+SHIFT+D from hidden → window appears, first notification highlighted, j/k/t work immediately
- CMD+SHIFT+D from visible → window hides, no side effects
- CMD+SHIFT+D with empty feed → window appears, no selection, no error

---

## 2. Visual Mode (Multi-Select)

### Concept

Inspired by Vim's visual mode. The user enters visual mode to select multiple notifications, then performs a bulk action (clear, mark read). Exiting visual mode deselects all.

### Keybindings

| Key | Action | Scope |
|-----|--------|-------|
| `v` | Toggle visual mode on/off | app |
| `j` / `k` | Extend selection down/up (in visual mode) | app (modified behavior) |
| `Space` | Toggle individual notification selection | app (visual mode only) |
| `d` | Delete all selected (in visual mode) | app (modified behavior) |
| `r` | Mark all selected read (in visual mode) | app (modified behavior) |
| `Escape` | Exit visual mode, clear selection | app (modified behavior) |

### State

Add to `App.tsx`:

```typescript
const [visualMode, setVisualMode] = useState(false);
const [visualSelections, setVisualSelections] = useState<Set<string>>(new Set()); // notification IDs
```

### Behavior

1. **Entering visual mode** (`v`):
   - Set `visualMode = true`
   - If `selectedIndex !== null`, add that notification's ID to `visualSelections`
   - If `selectedIndex === null`, set `selectedIndex = 0` first, then add

2. **Navigation in visual mode** (`j`/`k`):
   - Move `selectedIndex` as normal
   - Automatically add/extend selection: every notification between the anchor (where `v` was pressed) and cursor is selected
   - This mirrors Vim's visual line mode (`V`) — contiguous range selection

3. **Toggle individual** (`Space`):
   - Toggle the notification at `selectedIndex` in/out of `visualSelections`
   - Allows non-contiguous multi-select (like Vim's visual block)

4. **Bulk delete** (`d` in visual mode):
   - Delete all notifications in `visualSelections`
   - Trigger Yapture sync for each (see Section 3)
   - Exit visual mode
   - Adjust `selectedIndex` to nearest surviving notification

5. **Bulk mark read** (`r` in visual mode):
   - Mark all selected as read
   - Exit visual mode

6. **Exit visual mode** (`Escape` or `v` again):
   - Set `visualMode = false`
   - Clear `visualSelections`
   - Keep `selectedIndex` where it is

### Visual Indicator

- Visual mode notifications get a distinct selection style (e.g., left border + background tint)
- Show a mode indicator in the header/toolbar: **`-- VISUAL --`** (like Vim's mode line)
- Show count: **`3 selected`**

### Changes

#### `src/hooks/useHotkeys.ts` — New actions

Add to `ACTION_MAP`:

```typescript
toggle_visual_mode: (a) => a.toggleVisualMode(),
visual_toggle_item: (a) => a.visualToggleItem(),
```

Modify `select_next` / `select_prev` / `delete_selected` / `mark_selected_read` to check visual mode flag and delegate to bulk variants.

#### `src-tauri/migrations/011_visual_mode_hotkeys.sql`

Add new hotkey binding:

```sql
-- Add visual mode hotkey to existing config
-- v → toggle_visual_mode, scope: app, category: Navigation
-- Space → visual_toggle_item, scope: app, category: Navigation
```

Update the `hotkey_config` JSON in the `settings` table to include the two new bindings.

#### `src/App.tsx` — Visual mode state + actions

```typescript
const [visualMode, setVisualMode] = useState(false);
const [visualSelections, setVisualSelections] = useState<Set<string>>(new Set());
const [visualAnchor, setVisualAnchor] = useState<number | null>(null);

// In hotkeyActions:
toggleVisualMode: () => {
  if (visualMode) {
    // Exit
    setVisualMode(false);
    setVisualSelections(new Set());
    setVisualAnchor(null);
  } else {
    // Enter
    const idx = selectedIndex ?? 0;
    setSelectedIndex(idx);
    setVisualMode(true);
    setVisualAnchor(idx);
    const id = notifications[idx]?.id;
    if (id) setVisualSelections(new Set([id]));
  }
},

// Modified selectNext (visual mode):
selectNext: () => {
  setSelectedIndex((prev) => {
    const next = Math.min((prev ?? -1) + 1, notifications.length - 1);
    if (visualMode && visualAnchor !== null) {
      // Select contiguous range from anchor to cursor
      const lo = Math.min(visualAnchor, next);
      const hi = Math.max(visualAnchor, next);
      const ids = new Set(notifications.slice(lo, hi + 1).map(n => n.id));
      setVisualSelections(ids);
    }
    return next;
  });
},
```

#### `src/components/NotificationCard.tsx` — Visual selection styling

Accept `isVisualSelected: boolean` prop. When true, apply distinct visual treatment (checkbox icon + highlight).

#### `src/components/HotkeyHelp.tsx`

Add visual mode section to the help overlay.

### Verification

- Press `v` → mode indicator appears, current notification highlighted
- `j`/`k` → extends contiguous selection visually
- `Space` → toggles individual items for non-contiguous selection
- `d` → all selected deleted, visual mode exits
- `Escape` → exits visual mode, clears selection
- Visual mode persists across scrolling

---

## 3. Bidirectional Yapture Sync

### Problem

Currently Dispatch → Yapture is one-way: notifications are pushed as tasks. There's no feedback loop — clearing a notification in Dispatch doesn't complete it in Yapture, and there's no `#@dispatch` workspace tag for organization.

### 3A. Yapture Task ID Tracking in Dispatch

#### Notification Model Change

Add `yapture_task_id` column to `notifications` table:

```sql
-- Migration 011 (or 012)
ALTER TABLE notifications ADD COLUMN yapture_task_id TEXT;
```

**Rust model** (`models.rs`):
```rust
pub struct Notification {
    // ... existing fields ...
    pub yapture_task_id: Option<String>,  // NEW
}
```

**TypeScript type** (`lib/types.ts`):
```typescript
export interface Notification {
  // ... existing fields ...
  yapture_task_id: string | null;  // NEW
}
```

#### Capture Yapture Task ID on Push

In `yapture.rs` `push_notification()`, the task creation response already returns the Yapture task ID. Currently it's used only for the webhook. Store it back:

```rust
// After successful task creation:
if let Some(task_id) = &created_task_id {
    if let Err(e) = db::set_yapture_task_id(&config.db, &notification.id, task_id).await {
        dlog!("[yapture] failed to store task_id: {}", e);
    }
}
```

New DB helper (`db.rs`):
```rust
pub async fn set_yapture_task_id(pool: &SqlitePool, notification_id: &str, yapture_task_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE notifications SET yapture_task_id = ? WHERE id = ?")
        .bind(yapture_task_id)
        .bind(notification_id)
        .execute(pool)
        .await?;
    Ok(())
}
```

#### Pass DB Pool to push_notification

Currently `push_notification` takes `&YaptureConfig` and `&Notification`. The signature needs the DB pool to write back the task ID. Two options:

**Option A (preferred)**: Add `db: &SqlitePool` parameter to `push_notification`.

**Option B**: Return the task ID from `push_notification` and let the caller store it.

Go with **Option A** — cleaner since the function already does fire-and-forget async work.

### 3B. Sync Setting

#### Setting Storage

New setting in `settings` table:

| Key | Default | Description |
|-----|---------|-------------|
| `yapture_bidirectional_sync` | `"true"` | When enabled, Dispatch actions sync to Yapture |

#### Rust Commands

```rust
#[tauri::command]
pub async fn get_yapture_sync_enabled(state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    let val = db::get_setting(&state.db, "yapture_bidirectional_sync").await
        .ok().flatten().unwrap_or_else(|| "true".to_string());
    Ok(val == "true")
}

#[tauri::command]
pub async fn set_yapture_sync_enabled(state: State<'_, Arc<AppState>>, enabled: bool) -> Result<(), String> {
    db::set_setting(&state.db, "yapture_bidirectional_sync", if enabled { "true" } else { "false" }).await
        .map_err(|e| e.to_string())
}
```

#### Frontend

Add toggle in `YaptureSettings.tsx`:
- Label: **"Bidirectional Sync"**
- Description: "When enabled, clearing notifications or focusing terminal in Dispatch will complete the corresponding task in Yapture."
- Default: ON

### 3C. Complete Yapture Task on Dispatch Actions

#### New Rust Function

```rust
// yapture.rs
pub async fn complete_yapture_task(config: &YaptureConfig, yapture_task_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/tasks/{}", config.api_url, yapture_task_id);
    let auth = format!("Bearer {}", config.access_token);

    let resp = client
        .patch(&url)
        .header("Authorization", &auth)
        .header("X-User-ID", &config.user_id)
        .json(&serde_json::json!({ "completed": true }))
        .send()
        .await
        .map_err(|e| format!("Yapture PATCH failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Yapture returned {}", resp.status()));
    }
    Ok(())
}
```

#### Trigger Points

Sync fires on these Dispatch actions (when sync enabled AND `yapture_task_id` is not null):

| Dispatch Action | Trigger Location | Notes |
|----------------|------------------|-------|
| **Delete notification** (`d` key or click) | `delete_notification` command | Before deleting from local DB |
| **Bulk delete** (visual mode `d`) | Same command, called per-notification | Batch: fire all concurrently |
| **Focus terminal** (`t` key) | `focus_terminal` command | Complete task = "handled" |
| **Deep link focus** (from Yapture click) | `do_focus_terminal` deep link handler | Complete task = "handled" |
| **Clear all** (`D` key) | `clear_all_notifications` command | Fetch all, complete each in Yapture |

#### Implementation in `commands.rs`

For each trigger point, add a sync step. Example for `delete_notification`:

```rust
#[tauri::command]
pub async fn delete_notification(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> {
    // 1. Check sync enabled
    let sync_enabled = db::get_setting(&state.db, "yapture_bidirectional_sync")
        .await.ok().flatten().unwrap_or_else(|| "true".into()) == "true";

    // 2. Get notification (need yapture_task_id before deleting)
    let notification = db::get_notification_by_id(&state.db, &id).await
        .map_err(|e| e.to_string())?;

    // 3. If sync enabled and has yapture_task_id, complete in Yapture (fire-and-forget)
    if sync_enabled {
        if let Some(Some(yapture_id)) = notification.as_ref().map(|n| n.yapture_task_id.as_ref()) {
            let yapture_id = yapture_id.clone();
            let db = state.db.clone();
            tokio::spawn(async move {
                if let Ok(Some(config)) = yapture::load_config(&db).await {
                    if let Err(e) = yapture::complete_yapture_task(&config, &yapture_id).await {
                        dlog!("[yapture-sync] failed to complete task {}: {}", yapture_id, e);
                    } else {
                        dlog!("[yapture-sync] completed task {}", yapture_id);
                    }
                }
            });
        }
    }

    // 4. Delete locally
    db::delete_notification(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}
```

Same pattern for `focus_terminal` — after successfully focusing, fire-and-forget complete:

```rust
#[tauri::command]
pub async fn focus_terminal(
    state: State<'_, Arc<AppState>>,
    session: String,
    window: Option<String>,
    pane: Option<String>,
    notification_id: Option<String>,  // NEW param — pass from frontend
) -> Result<(), String> {
    do_focus_terminal(&state.db, &session, window.as_deref(), pane.as_deref()).await?;

    // Sync to Yapture
    if let Some(nid) = notification_id {
        let sync_enabled = db::get_setting(&state.db, "yapture_bidirectional_sync")
            .await.ok().flatten().unwrap_or_else(|| "true".into()) == "true";
        if sync_enabled {
            if let Ok(Some(n)) = db::get_notification_by_id(&state.db, &nid).await {
                if let Some(yapture_id) = n.yapture_task_id {
                    let db = state.db.clone();
                    tokio::spawn(async move {
                        if let Ok(Some(config)) = yapture::load_config(&db).await {
                            let _ = yapture::complete_yapture_task(&config, &yapture_id).await;
                        }
                    });
                }
            }
        }
    }
    Ok(())
}
```

#### Frontend Changes

Pass `notification_id` to `focus_terminal` command:

```typescript
// App.tsx — handleFocusTerminal
const handleFocusTerminal = useCallback(
  async (id: string, session: string, window: string | null, pane: string | null) => {
    await invoke("focus_terminal", {
      session, window, pane,
      notificationId: id,  // NEW
    });
  },
  []
);
```

#### Deep Link Handler

In `lib.rs`, the `dispatch://focus-terminal` handler also needs sync. Add an optional `notification_id` query param:

```
dispatch://focus-terminal?session=X&window=Y&pane=Z&nid=NOTIFICATION_UUID
```

Update `yapture.rs` `push_notification()` to include `&nid={notification.id}` in the deep link URL. Then in the deep link handler, after calling `do_focus_terminal`, also fire the Yapture complete.

### 3D. `#@dispatch` Workspace Tag

#### Goal

Every task pushed from Dispatch to Yapture should be tagged with the `#@dispatch` workspace. This lets users filter all Dispatch-originated tasks in Yapture's UI.

#### Implementation

In `yapture.rs` `push_notification()`, prepend `#@dispatch` to the task text:

```rust
// Build task text
let mut text = format!("#@dispatch ");  // Workspace tag first
if let Some(project) = &notification.project {
    text.push_str(&format!("[{}] ", project));
}
text.push_str(&notification.title);
// ... rest of text building
```

Yapture's NLP service (`nlpService.ts`) already parses `#@workspace` syntax and auto-creates the workspace if it doesn't exist. No Yapture-side changes needed — the workspace will be created on first push.

#### Result in Yapture

- Workspace `dispatch` appears in workspace list with default green color
- All Dispatch notifications appear under this workspace
- Users can filter by workspace to see only Dispatch items
- The `#@dispatch` tag is stripped from display text by Yapture's NLP (stored as workspace relation, not in cleaned `text`)

---

## 4. Summary of All Changes

### New Migration

**`src-tauri/migrations/011_visual_mode_and_sync.sql`**:

```sql
-- Add yapture_task_id for bidirectional sync
ALTER TABLE notifications ADD COLUMN yapture_task_id TEXT;

-- Default sync setting (on by default)
INSERT OR IGNORE INTO settings (key, value) VALUES ('yapture_bidirectional_sync', 'true');

-- Visual mode hotkeys are added to hotkey_config JSON (handled in Rust default config)
```

### Files Changed — Dispatch (Rust)

| File | Changes |
|------|---------|
| `src-tauri/src/models.rs` | Add `yapture_task_id: Option<String>` to `Notification` |
| `src-tauri/src/db.rs` | Add migration 011, `set_yapture_task_id()` helper |
| `src-tauri/src/yapture.rs` | `complete_yapture_task()`, prepend `#@dispatch` to task text, store task ID back, include `nid` in deep link URL |
| `src-tauri/src/commands.rs` | Sync logic in `delete_notification`, `focus_terminal` (add `notification_id` param), `clear_all_notifications`; new `get/set_yapture_sync_enabled` commands |
| `src-tauri/src/lib.rs` | Emit `"auto-select-first"` on toggle_window show; sync in deep link handler; register new commands |

### Files Changed — Dispatch (Frontend)

| File | Changes |
|------|---------|
| `src/App.tsx` | Visual mode state (`visualMode`, `visualSelections`, `visualAnchor`); listen for `"auto-select-first"`; visual-aware `selectNext`/`selectPrev`/`deleteSelected`/`markSelectedRead`; pass `notificationId` to `focus_terminal` |
| `src/hooks/useHotkeys.ts` | Add `toggle_visual_mode`, `visual_toggle_item` to `ACTION_MAP`; modify existing actions to check visual mode |
| `src/lib/types.ts` | Add `yapture_task_id: string \| null` to `Notification` interface |
| `src/lib/api.ts` | Add `getYaptureSyncEnabled()`, `setYaptureSyncEnabled()` wrappers |
| `src/components/NotificationCard.tsx` | Accept `isVisualSelected` prop, render selection indicator |
| `src/components/HotkeyHelp.tsx` | Add visual mode keybindings to help overlay |
| `src/components/YaptureSettings.tsx` | Add "Bidirectional Sync" toggle |

### Files Changed — Yapture

None. All integration handled via existing API (`PATCH /api/tasks/:id` with `completed: true`) and existing NLP workspace parsing (`#@dispatch`).

### New Hotkey Bindings (added to default config)

| Key | Action | Category | Scope |
|-----|--------|----------|-------|
| `v` | `toggle_visual_mode` | Navigation | app |
| `Space` | `visual_toggle_item` | Navigation | app |

### New Tauri Commands

| Command | Purpose |
|---------|---------|
| `get_yapture_sync_enabled` | Read bidirectional sync setting |
| `set_yapture_sync_enabled` | Write bidirectional sync setting |

### New Tauri Events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `auto-select-first` | Backend → Frontend | Select first notification on window show |

---

## 5. Verification Checklist

### Auto-Focus
- [ ] CMD+SHIFT+D from hidden → first notification selected
- [ ] CMD+SHIFT+D from visible → window hides
- [ ] CMD+SHIFT+D with empty feed → no error
- [ ] After auto-focus, `j`/`k`/`t`/`d` all work without extra keystroke

### Visual Mode
- [ ] `v` enters visual mode, mode indicator visible
- [ ] `j`/`k` extends contiguous selection
- [ ] `Space` toggles individual items
- [ ] `d` bulk-deletes all selected, exits visual mode
- [ ] `r` bulk-marks-read, exits visual mode
- [ ] `Escape` exits visual mode, clears selection
- [ ] `v` again exits visual mode
- [ ] Visual selection styling distinct from single-select

### Yapture Bidirectional Sync
- [ ] New notification creates Yapture task with `#@dispatch` workspace
- [ ] `yapture_task_id` stored on notification after push
- [ ] Delete notification → Yapture task completed
- [ ] `t` (focus terminal) → Yapture task completed
- [ ] Deep link click from Yapture → Yapture task completed
- [ ] Visual mode bulk delete → all corresponding Yapture tasks completed
- [ ] Clear all → all Yapture tasks completed
- [ ] Sync toggle OFF → no Yapture completion on any action
- [ ] Sync toggle ON (default) → completions fire
- [ ] Failed Yapture sync doesn't block local Dispatch operation (fire-and-forget)

### #@dispatch Workspace
- [ ] New Dispatch tasks appear under `dispatch` workspace in Yapture
- [ ] Workspace auto-created on first push
- [ ] Workspace filterable in Yapture sidebar
- [ ] `#@dispatch` stripped from display text (NLP handles this)

### Edge Cases
- [ ] Notification without `yapture_task_id` (created before sync) → no sync attempted, no error
- [ ] Yapture disconnected/unauthenticated → sync fails silently, logged
- [ ] Yapture task already completed → PATCH is idempotent, no error
- [ ] Rapid bulk operations → concurrent tokio::spawn tasks don't conflict
- [ ] Token expired during sync → refresh attempt before retry (or fail silently)
