# Spec: Global Shortcuts + Yapture Notifications + V2 Support

## Overview

Three issues to address:
1. CMD+SHIFT+K doesn't focus the window or show the command palette
2. Yapture isn't showing notifications and deep links are missing
3. Need to support both Yapture v1 AND v2 (which uses `~/Code/yapture/auth`)

---

## 1. Fix: CMD+SHIFT+K not focusing window / showing command palette

### Root Cause

The global shortcut `CommandOrControl+Shift+K` is registered in `commands.rs:527-544` via `set_hotkey_config()`, which builds a `global_shortcut_map` HashMap. However, there is **no handler that emits the Tauri event** `"show-command-palette"` when the shortcut fires.

The shortcut registration code in `commands.rs`:
```rust
for binding in &config.bindings {
    if binding.scope == "global" && binding.enabled {
        for key_str in &binding.keys {
            if let Ok(shortcut) = key_str.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    eprintln!("[hotkeys] failed to register {}: {}", key_str, e);
                } else {
                    new_map.insert(key_str.clone(), binding.action.clone());
                }
            }
        }
    }
}
```

This registers the shortcut with the OS but only stores the mapping. The `on_shortcut_event` callback (set during plugin init) needs to:
1. Look up the action in `global_shortcut_map`
2. Focus/show the window
3. Emit the corresponding Tauri event

### Additional Issues

**A. Saved config may not include the new binding.** The `get_hotkey_config()` merge logic in `db.rs` adds missing actions from defaults to saved config. But if the user already has a saved config that was persisted BEFORE `show_command_palette` was added to defaults, the merge should pick it up — verify this works by checking that `get_hotkey_config` iterates default bindings and appends any whose `action` is not in the saved config.

**B. Inconsistent toggle behavior.** The frontend has two handlers:
- `App.tsx:127` — Tauri event listener: `setShowCommandPalette(true)` (always opens)
- `App.tsx:149-153` — Local CMD+K: `setShowCommandPalette((prev) => !prev)` (toggles)

Both should toggle, not just open.

**C. Window focus race condition.** When the shortcut fires while the window is hidden/unfocused, the handler must `window.show()` + `window.set_focus()` BEFORE emitting the event. If these are not awaited, the event arrives before the window is visible.

### Fix

#### Step 1: Add global shortcut event handler in Rust

In `lib.rs` (or wherever `tauri_plugin_global_shortcut` is initialized), add an `on_shortcut_event` callback:

```rust
.plugin(
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                let shortcut_str = shortcut.to_string();
                let state = app.state::<Arc<AppState>>();
                let map = state.global_shortcut_map.read();
                if let Some(action) = map.get(&shortcut_str) {
                    // Focus the window first
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    // Emit action-specific event
                    match action.as_str() {
                        "show_command_palette" => {
                            let _ = app.emit("show-command-palette", ());
                        }
                        "toggle_window" => {
                            // Already handled by show/focus above
                        }
                        _ => {}
                    }
                }
            }
        })
        .build()
)
```

If the shortcut handler already exists, extend it — don't duplicate. Check `lib.rs` for existing `with_handler` or `on_shortcut_event` setup.

#### Step 2: Fix frontend toggle consistency

In `App.tsx`, change the Tauri event listener to toggle:
```typescript
const unlisten = listen("show-command-palette", () => {
    setShowCommandPalette((prev) => !prev);
});
```

#### Step 3: Verify config merge

Test that opening Settings → Shortcuts shows both:
- `CommandOrControl+Shift+K` in Global section (action: `show_command_palette`)
- `CommandOrControl+K` in Navigation section (action: `show_command_palette_local`)

If the user has a pre-existing saved config, the merge logic should auto-add these. Verify by checking the raw DB value in `settings` table for `hotkey_config`.

### Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/lib.rs` | Add/extend `with_handler` callback for global shortcuts |
| `src/App.tsx` | Change `show-command-palette` listener from `set(true)` to toggle |

---

## 2. Fix: Yapture not showing notifications / missing deep links

### Root Cause Analysis

There are multiple potential failure points in the notification → Yapture pipeline:

#### A. `load_config()` returns None — notifications never reach Yapture

`yapture.rs:23-58` — `load_config()` requires ALL of these to be present:
- `yapture_enabled` = `"1"` in settings DB
- `yapture_api_url` non-empty
- `yapture_user_id` non-empty
- In-memory `service_token` (set during OAuth or app startup)

If ANY is missing, the function returns `None` and `server.rs:75` logs:
```
[yapture] push: skipped — load_config returned None
```

**Most likely failure:** The `service_token` is stored in-memory only (`Arc<RwLock<Option<String>>>`). After an app restart, this is `None` until the user re-authenticates or the token is restored from DB. Check whether `access_token` stored in DB settings is loaded into the in-memory `service_token` on app startup.

#### B. Deep links only generated when `tmux_session` is present

`yapture.rs:73-90` — Deep link construction:
```rust
let session = match &notification.tmux_session {
    Some(s) => s.clone(),
    None => {
        crate::log::log("[yapture] push: skipping — no tmux_session on notification");
        return;
    }
};
let mut deep_link = format!("dispatch://focus-terminal?session={}&nid={}",
    urlencoding::encode(&session), urlencoding::encode(&notification.id));
```

If `tmux_session` is `None`, the entire `push_notification()` returns early — no task is created in Yapture at all.

**Issue:** Many notifications (e.g., from non-tmux processes or the notification API) may not have `tmux_session` set. This causes silent skipping.

#### C. Auth token may be expired

The `push_notification()` function uses the token as-is. If the access token has expired, the Yapture API returns 401, but the error is only logged — there is no automatic token refresh in the push path.

#### D. Banner config suppression

`App.tsx:79-88` — The frontend filters banners:
```typescript
if (bannerConfig.globalEnabled && bannerConfig.screens[currentScreenKey] !== false) {
    setBannerQueue((prev) => [notification, ...prev]);
}
```

If the user disabled banners for the current screen, notifications won't show even though they arrive. This is expected behavior but may confuse users who don't remember their settings.

### Fix

#### Step 1: Restore service_token from DB on startup

In `lib.rs` or wherever `AppState` is initialized, after DB is ready:
```rust
// Restore Yapture service token from DB
if let Ok(Some(token)) = db::get_setting(&pool, "yapture_access_token").await {
    if !token.is_empty() {
        *state.service_token.write() = Some(token);
    }
}
```

This ensures `load_config()` can find the token after app restart without requiring re-auth.

#### Step 2: Make tmux_session optional for Yapture push

Change `push_notification()` to not bail when `tmux_session` is missing:
```rust
let session = notification.tmux_session.clone().unwrap_or_default();
let deep_link = if session.is_empty() {
    // No deep link possible without session info
    format!("dispatch://notifications?nid={}", urlencoding::encode(&notification.id))
} else {
    let mut dl = format!("dispatch://focus-terminal?session={}&nid={}",
        urlencoding::encode(&session), urlencoding::encode(&notification.id));
    if let Some(w) = &notification.tmux_window {
        dl.push_str(&format!("&window={}", urlencoding::encode(w)));
    }
    if let Some(p) = &notification.tmux_pane {
        dl.push_str(&format!("&pane={}", urlencoding::encode(p)));
    }
    dl
};
```

This sends a fallback deep link that opens the notifications screen instead of silently dropping.

#### Step 3: Add token refresh before push

In `push_notification()`, if the API call returns 401, attempt a token refresh and retry:
```rust
let resp = client.post(&url).bearer_auth(&config.service_token)
    .header("X-User-ID", &config.user_id)
    .json(&body).send().await;

match resp {
    Ok(r) if r.status() == 401 => {
        crate::log::log("[yapture] push: 401 — attempting token refresh");
        // Attempt refresh using refresh_token from DB
        // If successful, retry the request with the new token
    }
    // ... existing handling
}
```

#### Step 4: Add diagnostic logging

Add logging at every decision point so failures are traceable:
```rust
// In load_config()
eprintln!("[yapture] config check: enabled={}, api_url={}, user_id={}, has_token={}",
    enabled, !api_url.is_empty(), !user_id.is_empty(), token.is_some());

// In push_notification()
eprintln!("[yapture] push: notification_id={}, has_session={}, has_deep_link={}",
    notification.id, notification.tmux_session.is_some(), !deep_link.is_empty());
```

### Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/lib.rs` | Restore service_token from DB on startup |
| `src-tauri/src/yapture.rs` | Optional tmux_session, fallback deep link, token refresh on 401, diagnostic logging |

---

## 3. Feature: Support both Yapture v1 AND v2

### Context

- **Yapture v1** (production): Next.js + PostgreSQL + Better Auth + OAuth 2.0 PKCE
  - Endpoint: configured via `yapture_api_url` setting
  - Auth: Bearer token + X-User-ID header
  - Token prefixes: `yap_at_` (access), `yap_rt_` (refresh)
  - Client ID: `dispatch-desktop` registered in `~/Code/yapture/app/backend/src/auth/oauth.ts`

- **Yapture v2** (development): Astro + LibSQL + Solid.js
  - Uses `~/Code/yapture/auth` as a separate auth microservice
  - Different API surface, not yet production-ready
  - Auth microservice runs independently from the main app

- **Current Dispatch code** only supports v1 endpoints (`/api/tasks`, `/api/webhooks/capswan/task.created`)

### Architecture Decision

Support v1 and v2 via **API version detection**, not parallel implementations. This keeps the codebase simple and avoids maintaining two separate push paths.

#### Option A: Version auto-detection (recommended)

On startup or when Yapture settings change, probe the API to determine version:

```rust
async fn detect_yapture_version(api_url: &str) -> YaptureVersion {
    // Try v2 health endpoint first
    if let Ok(resp) = reqwest::get(&format!("{}/api/v2/health", api_url)).await {
        if resp.status().is_success() {
            return YaptureVersion::V2;
        }
    }
    // Fall back to v1
    YaptureVersion::V1
}
```

Store the detected version in `AppState` and use it to select the correct push implementation.

#### Option B: Explicit setting

Add a `yapture_version` setting (`"v1"` or `"v2"`) in the Yapture settings tab. Simpler but requires user to know which version they're running.

### Implementation Plan

#### Step 1: Define version enum and extend config

```rust
#[derive(Clone, Debug, PartialEq)]
pub enum YaptureVersion {
    V1,
    V2,
}

pub struct YaptureConfig {
    pub api_url: String,
    pub user_id: String,
    pub service_token: String,
    pub version: YaptureVersion,  // NEW
}
```

#### Step 2: Add v2 auth support

v2 uses `~/Code/yapture/auth` as a separate microservice. The auth flow:

1. **Auth service URL**: Separate from main API (e.g., `http://localhost:3001` for local dev)
2. **Token format**: May differ from v1's `yap_at_`/`yap_rt_` prefixed tokens
3. **OAuth flow**: Similar PKCE flow but against the auth microservice

Add to settings:
- `yapture_auth_url` — Auth service endpoint (only needed for v2)

Update `start_oauth_flow()` to use `auth_url` for v2:
```rust
let auth_endpoint = match version {
    YaptureVersion::V1 => format!("{}/authorize", api_url),
    YaptureVersion::V2 => format!("{}/authorize", auth_url),
};
```

#### Step 3: Add v2 push implementation

Create a `push_notification_v2()` function (or a version-aware dispatch):

```rust
pub async fn push_notification(config: &YaptureConfig, notification: &Notification, pool: Option<&SqlitePool>) {
    match config.version {
        YaptureVersion::V1 => push_v1(config, notification, pool).await,
        YaptureVersion::V2 => push_v2(config, notification, pool).await,
    }
}

async fn push_v2(config: &YaptureConfig, notification: &Notification, pool: Option<&SqlitePool>) {
    // v2 API endpoints TBD — implement once v2 API surface is finalized
    // Likely: POST /api/v2/notifications or POST /api/v2/tasks
    crate::log::log("[yapture-v2] push: not yet implemented");
}
```

#### Step 4: Update Settings UI

In `YaptureSettings.tsx`, add version indicator or selector:
```tsx
<div className="flex items-center gap-2">
    <span className="text-xs text-text-secondary">API Version:</span>
    <span className="text-xs font-mono">{yaptureVersion}</span>
</div>
```

If using auto-detection, this is read-only. If using explicit setting, add a toggle.

#### Step 5: v2 auth microservice integration

The `~/Code/yapture/auth` microservice needs:
1. `dispatch-desktop` client registered (same as v1)
2. PKCE flow support
3. Token endpoint for exchange and refresh

**Investigate** the auth microservice API surface:
- Check `~/Code/yapture/auth/src/` for route definitions
- Verify OAuth client registration mechanism
- Determine token format and endpoint paths

### Phasing

This should be implemented in phases:

**Phase A (now):** Fix v1 — address issues from Section 2 (token restoration, optional tmux_session, diagnostic logging). This unblocks current users.

**Phase B (next):** Version detection + config — add `YaptureVersion` enum, auto-detection probe, `yapture_auth_url` setting. No v2 push logic yet.

**Phase C (when v2 API is stable):** Implement `push_v2()` with actual v2 endpoints. Requires v2 API to be finalized.

### Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/yapture.rs` | Add `YaptureVersion` enum, version-aware push dispatch, v2 auth flow |
| `src-tauri/src/commands.rs` | Add `yapture_auth_url` setting commands, version detection command |
| `src-tauri/src/db.rs` | Add `yapture_auth_url` and `yapture_version` to default settings |
| `src/components/YaptureSettings.tsx` | Show detected version, optional auth URL field |

---

## Dependency Order

```
Issue 1 (CMD+SHIFT+K)  ──┐
                          ├──→ all independent, can be parallelized
Issue 2 (Yapture notifs) ─┤
                          │
Issue 3 Phase A ──────────┘  (shares yapture.rs with Issue 2 — do together)
Issue 3 Phase B ──────────── (after Phase A merges)
Issue 3 Phase C ──────────── (blocked on v2 API stabilization)
```

## Verification

### Issue 1
1. Press CMD+SHIFT+K when window is hidden → window appears AND command palette opens
2. Press CMD+SHIFT+K when window is focused + palette closed → palette opens
3. Press CMD+SHIFT+K when window is focused + palette open → palette closes
4. Press CMD+K inside app → same toggle behavior
5. Open Settings → Shortcuts → both bindings visible in correct sections

### Issue 2
1. Restart app → Yapture push works without re-authenticating
2. Send notification without tmux_session → still creates Yapture task (with fallback deep link)
3. Send notification with tmux_session → creates task with full deep link
4. Check Tauri console for `[yapture]` diagnostic logs at each step
5. Banner still respects per-screen config

### Issue 3
1. Phase A: All Issue 2 verifications pass
2. Phase B: App detects v1 vs v2 correctly, shows version in Settings
3. Phase C: Notifications push to v2 API when configured
