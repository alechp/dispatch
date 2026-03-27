# Batch 4: Fixes, OAuth, and Text Expander Overhaul

## Overview

Seven action items addressing regressions, UX polish, Yapture OAuth integration, and a fundamental redesign of the text expansion permission strategy.

---

## Item 1: Change Default Toggle Window Hotkey to CMD+SHIFT+D

**Priority:** Quick fix
**Files:** `src-tauri/src/db.rs`, `src-tauri/migrations/010_update_hotkey_defaults.sql`

### Problem

Migration 010 changed the toggle window shortcut from CMD+SHIFT+D to CMD+SHIFT+E. The user wants CMD+SHIFT+D restored as the default.

### Current State

- `DEFAULT_HOTKEY_CONFIG` in `db.rs` line 623: `"CommandOrControl+Shift+E"`
- Migration 010 uses `INSERT OR REPLACE` to overwrite the config with CMD+SHIFT+E

### Changes

1. **`db.rs`** — Change `CommandOrControl+Shift+E` back to `CommandOrControl+Shift+D` in `DEFAULT_HOTKEY_CONFIG`
2. **`migrations/010_update_hotkey_defaults.sql`** — Update the JSON to use `CommandOrControl+Shift+D`. Keep the `show_expander` removal (it was correctly removed).

---

## Item 2: Yapture OAuth Integration

**Priority:** High
**Files:** `src-tauri/src/yapture.rs`, `src/components/YaptureSettings.tsx`, `src-tauri/src/lib.rs`

### Problem

The Settings screen shows "Connect your Yapture account" with a "Connecting..." button and environment selector, but the actual OAuth flow needs to work with Yapture's custom OAuth 2.0 server. The current implementation references `api.yapture.app` but the user wants proper OAuth login.

### Yapture OAuth Architecture (from ~/Code/yapture/app analysis)

Yapture runs a **custom OAuth 2.0 server** (not Auth0/Supabase) built on Elysia.js with:

| Endpoint | URL |
|----------|-----|
| Authorization | `{base}/authorize` |
| Token Exchange | `{base}/token` |
| User Info | `{base}/api/userinfo` |
| Metadata | `{base}/.well-known/oauth-authorization-server` |

**Key characteristics:**
- **PKCE required** (S256 only) — no client secrets needed
- **Public clients** (`token_endpoint_auth_methods: ["none"]`)
- **Token format:** `yap_at_{hex}` (access), `yap_rt_{hex}` (refresh)
- **Access token lifetime:** 1 hour
- **Refresh token:** No expiration, no rotation
- **Available scopes:** `openid profile email api:read api:write`

**Environment URLs:**
| Environment | API URL |
|-------------|---------|
| Production | `https://api.yapture.app` |
| Staging | `https://api.staging.yapture.dev` |
| Local | `http://localhost:4728` |

### Required: Register a Dispatch OAuth Client

Before implementing, a new OAuth client must be registered in Yapture's admin portal or fallback config:

```json
{
  "clientId": "dispatch-desktop",
  "name": "Dispatch Desktop",
  "redirectUris": ["dispatch://oauth/callback"],
  "allowedScopes": ["openid", "profile", "email", "api:read", "api:write"],
  "environments": ["production", "staging", "localhost"]
}
```

### Implementation Changes

#### Backend (`src-tauri/src/yapture.rs`)

1. **Update `start_oauth_flow()`** to use correct endpoints:
   - Authorization URL: `{api_url}/authorize` (not `/oauth/authorize`)
   - Include required PKCE params: `code_challenge` (S256), `code_challenge_method=S256`
   - Scopes: `openid profile email api:read api:write`
   - Client ID: `dispatch-desktop`
   - Redirect URI: `dispatch://oauth/callback`

2. **Update `exchange_code()`** to use correct token endpoint:
   - Token URL: `{api_url}/token` (not `/oauth/token`)
   - Include `code_verifier` for PKCE validation
   - Content-Type: `application/x-www-form-urlencoded`
   - No client secret needed (public client)

3. **Update `fetch_userinfo()`**:
   - URL: `{api_url}/api/userinfo` (not `/oauth/userinfo` or `/userinfo`)
   - Response fields: `sub`, `email`, `name`, `preferred_username`, `picture`

4. **Add token refresh support**:
   - Use `grant_type=refresh_token` with stored refresh token
   - Refresh proactively when access token is near expiry
   - Store refresh token persistently in DB settings

#### Frontend (`src/components/YaptureSettings.tsx`)

1. **Fix the "Connecting..." stuck state** — the button shows "Connecting..." indefinitely. Add a timeout and error state.
2. **Environment selector** should update `yapture_api_url` in backend before starting OAuth
3. **Show connection status** after successful OAuth (user name, email, connected badge)
4. **Add disconnect button** that calls `yapture_disconnect` and clears tokens

#### Deep Link Handler (`src-tauri/src/lib.rs`)

The deep link handler at lines 240-393 already handles `dispatch://oauth/callback`. Verify it:
1. Parses `code` and `state` from callback URL
2. Validates state matches pending OAuth flow
3. Exchanges code for tokens (must include `code_verifier`)
4. Stores tokens and fetches user info
5. Emits `yapture-connected` event to frontend

### OAuth Flow Sequence

```
1. User clicks "Connect with Yapture" in Settings
2. Frontend calls yapture_start_oauth command
3. Backend generates code_verifier + code_challenge (S256)
4. Backend stores {state, code_verifier} in oauth_pending
5. Backend returns authorization URL
6. Frontend opens URL in system browser
7. User authenticates on Yapture website
8. Yapture redirects to dispatch://oauth/callback?code=...&state=...
9. Deep link handler catches callback
10. Backend exchanges code + code_verifier for tokens at /token
11. Backend fetches user info at /api/userinfo
12. Backend stores tokens + user info in DB
13. Frontend receives yapture-connected event
14. Settings screen updates to show connected state
```

---

## Item 3: Fix Tmux Window/Pane Focusing

**Priority:** High
**Files:** `src-tauri/src/commands.rs`

### Problem

The `focus_terminal` command (commands.rs:113-143) has two issues:

1. **Terminal app is hardcoded to "kitty"** — `open -a kitty` fails for users with other terminals
2. **Race condition** — no delay between `open -a kitty` and `tmux switch-client`, so tmux may execute before the terminal is ready

### Current Code

```rust
// Bring Kitty to foreground
std::process::Command::new("open")
    .args(&["-a", "kitty"])
    .output()?;

// Immediately switch tmux client (no delay)
let output = std::process::Command::new("tmux")
    .args(&["switch-client", "-t", &target])
    .output()?;
```

### Changes

1. **Make terminal app configurable** — Add a `terminal_app` setting to the DB (default: auto-detect from `$TERM_PROGRAM` env var, fallback to common terminals: kitty, iTerm2, Terminal)
2. **Add delay between open and tmux** — `thread::sleep(Duration::from_millis(200))` after `open -a` to let the terminal activate
3. **Improve tmux targeting** — Use `tmux select-window` + `tmux select-pane` instead of just `switch-client` for more reliable pane focusing
4. **Add error feedback** — Return meaningful errors to the frontend so the toast can show "Terminal not found" or "Tmux session expired"

### Proposed Implementation

```rust
pub async fn focus_terminal(
    state: State<'_, Arc<AppState>>,
    session: String,
    window: Option<String>,
    pane: Option<String>,
) -> Result<(), String> {
    // 1. Detect terminal app (configurable or auto-detect)
    let terminal = db::get_setting(&state.db, "terminal_app")
        .await.ok().flatten()
        .unwrap_or_else(|| {
            std::env::var("TERM_PROGRAM").unwrap_or_else(|_| "kitty".to_string())
        });

    // 2. Bring terminal to foreground
    std::process::Command::new("open")
        .args(&["-a", &terminal])
        .output()
        .map_err(|e| format!("Failed to open {}: {}", terminal, e))?;

    // 3. Wait for terminal to activate
    std::thread::sleep(std::time::Duration::from_millis(200));

    // 4. Switch tmux session
    std::process::Command::new("tmux")
        .args(&["switch-client", "-t", &session])
        .output()
        .map_err(|e| format!("tmux switch-client failed: {}", e))?;

    // 5. Select specific window/pane if provided
    if let Some(w) = &window {
        let _ = std::process::Command::new("tmux")
            .args(&["select-window", "-t", &format!("{}:{}", session, w)])
            .output();
        if let Some(p) = &pane {
            let _ = std::process::Command::new("tmux")
                .args(&["select-pane", "-t", &format!("{}:{}.{}", session, w, p)])
                .output();
        }
    }
    Ok(())
}
```

---

## Item 4: Notification Banner Auto-Dismiss Timer

**Priority:** Medium
**Files:** `src/components/NotificationBanner.tsx`

### Problem

The notification banner auto-dismisses after 6 seconds. The user wants 3 seconds. The timer should only start when the window is focused (already implemented correctly).

### Changes

In `NotificationBanner.tsx` line 58, change:
```typescript
}, 6000);  // Current: 6 seconds
```
to:
```typescript
}, 3000);  // Fixed: 3 seconds
```

---

## Item 5: Clipboard Copy Toast Not Showing

**Priority:** Medium
**Files:** `src/hooks/useToast.ts`, `src/components/Toast.tsx`, `src/components/SnippetManager.tsx`

### Problem

Clicking copy icons in the snippet manager doesn't show any visual feedback. The `showToast("Copied to clipboard")` calls exist in the code (SnippetManager.tsx lines 233, 1003) but the toast either:
- Appears and disappears too fast (2-second auto-dismiss)
- Is not visible due to CSS/z-index issues
- Has a context wiring problem

### Investigation Points

1. **Toast auto-dismiss is 2000ms** (`useToast.ts` line 33) — very fast, could be missed
2. **Toast renders at `fixed bottom-4`** with `z-[100]` — should be visible but needs verification
3. The `navigator.clipboard.writeText()` call is async — if it fails silently in the Tauri WebView, the toast still fires but the copy didn't actually happen

### Changes

1. **Increase toast duration** to 3000ms in `useToast.ts`
2. **Add clipboard fallback** — if `navigator.clipboard.writeText` fails, fall back to the Tauri clipboard plugin or `document.execCommand('copy')`
3. **Verify toast renders** — add a brief console.log in `showToast` for debugging, then remove after confirming

---

## Item 6: Move Toast/Notification Banners to Bottom

**Priority:** Medium
**Files:** `src/components/NotificationBanner.tsx`, `src/components/Toast.tsx`

### Problem

The notification banner renders at `fixed top-14` which overlays the app content and is impossible to ignore. The user wants notifications to come from the bottom so they can be passively dismissed.

### Changes

#### NotificationBanner.tsx

Change the outer div positioning from:
```tsx
className={`fixed top-14 left-2 right-2 z-[90] ...`}
// With: opacity-0 -translate-y-2 (slides up when hidden)
```
to:
```tsx
className={`fixed bottom-2 left-2 right-2 z-[90] ...`}
// With: opacity-0 translate-y-2 (slides down when hidden)
```

#### Toast.tsx

Toast already renders at `fixed bottom-4` — keep it there but increase z-index above the banner:
- Toast: `z-[100]` (already correct, above banner's `z-[90]`)
- Notification banner position: `bottom-12` (above the toast area)

### Final Layout (bottom-up)

```
[Toast - bottom-4, z-100]              "Copied to clipboard"
[NotificationBanner - bottom-14, z-90]  "New notification from..."
```

---

## Item 7: Text Expander Permission Overhaul

**Priority:** Critical
**Files:** `src-tauri/src/macos_listener.rs`, `src-tauri/src/macos_accessibility.rs`, `src-tauri/src/text_injector.rs`, `src-tauri/src/lib.rs`, `src/components/SnippetManager.tsx`

### Problem

Text expansion doesn't work despite Input Monitoring being granted. Analysis of the Espanso installation flow (user's screenshot) reveals the fundamental issue: **Espanso uses Accessibility permission for BOTH detection AND injection**, not Input Monitoring.

### Root Cause Analysis

Our current approach requires **two separate macOS permissions**:

| Component | Permission Required | Current Status |
|-----------|-------------------|----------------|
| CGEventTap (keyboard listener) | Input Monitoring | Granted |
| enigo (text injection) | Accessibility | **NOT granted** |

Espanso's approach requires **one permission**:

| Component | Permission Required |
|-----------|-------------------|
| CocoaSource (keyboard listener) | Accessibility |
| MacInjector (text injection) | Accessibility |

### Additional Issues Discovered

1. **No code signing** — `tauri.conf.json` has no Developer ID signing config. On macOS, unsigned apps can have CGEventTap silently disabled after app restart or when launched from Finder/Dock.

2. **No diagnostic logging** — The listener thread logs when it starts but has NO logging for:
   - Whether events are being received
   - Whether the buffer is being filled
   - Whether trigger matches are being found
   - Whether injection succeeded or failed

3. **Permission names are confusing in code**:
   - `check_accessibility_permission()` actually checks **Input Monitoring** (`CGPreflightListenEventAccess`)
   - `check_accessibility_trusted()` actually checks **Accessibility** (`AXIsProcessTrusted`)

### Recommended Approach: Accessibility-Only (Like Espanso)

**Phase A: Immediate fix (get it working with current architecture)**

1. **Add comprehensive logging** to `macos_listener.rs`:
   - Log every key event received (at debug level)
   - Log buffer state after each keypress
   - Log trigger match attempts and results

2. **Add comprehensive logging** to `text_injector.rs`:
   - Log before and after each enigo call
   - Log clipboard state before/after
   - Catch and log enigo errors explicitly

3. **Fix permission UX** in `SnippetManager.tsx`:
   - When user enables Live Expansion:
     a. Check Input Monitoring → if missing, open `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`
     b. Check Accessibility → if missing, open `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
   - Show separate status indicators for each permission
   - Add a "Test Expansion" button that simulates a trigger match and reports what happened

4. **Add startup permission log** in `lib.rs`:
   ```rust
   let has_input_monitoring = macos_accessibility::check_permission();
   let has_accessibility = macos_accessibility::check_accessibility();
   eprintln!("[live-expansion] permissions: input_monitoring={}, accessibility={}",
             has_input_monitoring, has_accessibility);
   ```

**Phase B: Long-term fix (switch to Accessibility-only approach)**

Replace CGEventTap with Accessibility-based keyboard monitoring:
1. Use `AXObserver` or Cocoa `NSEvent.addGlobalMonitorForEvents` for keyboard events
2. Both approaches only need Accessibility permission
3. Eliminates the need for Input Monitoring entirely
4. Single permission model matches Espanso's proven approach

This is a larger refactor and should be a separate ticket.

### Minimum Viable Fix (Phase A only)

The most likely reason it's not working right now is that **Accessibility permission is not granted**. The user's screenshot shows "Requires Input Monitoring + Accessibility" — both are required but only Input Monitoring was granted.

**The immediate fix is to guide the user to also grant Accessibility:**

1. Update the toggle UI to show checkmarks for each permission individually
2. Add buttons/links to open the correct System Settings pane
3. Add diagnostic logging so we can trace exactly where the pipeline breaks

### Permission Check Display (proposed UI)

```
Live Expansion
  [x] Input Monitoring    [Open Settings]
  [ ] Accessibility       [Open Settings]  <-- THIS IS MISSING

  Status: Listening for keystrokes...
  Last event: 2s ago | Buffer: ":shr" | Matches: 0
```

---

## Implementation Order

1. **Item 1** (hotkey default) — 5 minutes, zero risk
2. **Item 4** (banner timer 6s→3s) — 5 minutes, zero risk
3. **Item 6** (move banners to bottom) — 15 minutes, low risk
4. **Item 5** (clipboard toast fix) — 15 minutes, low risk
5. **Item 3** (tmux focus fix) — 30 minutes, medium risk
6. **Item 7 Phase A** (text expander diagnostics + permission UX) — 1-2 hours, medium risk
7. **Item 2** (Yapture OAuth) — 2-3 hours, high complexity

Items 1-5 can be implemented and tested in a single install cycle. Item 7 Phase A should be next. Item 2 (OAuth) is the largest piece and should be its own focused session.

---

## Verification Checklist

After implementing all items:

- [ ] CMD+SHIFT+D toggles the Dispatch window
- [ ] No `show_expander` shortcut exists in Keyboard Shortcuts settings
- [ ] Yapture Settings shows "Connect with Yapture" button that opens browser
- [ ] After OAuth, Settings shows connected user name/email
- [ ] Clicking "Focus Terminal" on a notification switches to the correct tmux pane
- [ ] Notification banners appear at the bottom and disappear after 3s of focus
- [ ] Clicking copy icon shows "Copied to clipboard" toast at bottom
- [ ] Toast is visible for 3 seconds
- [ ] Live Expansion shows separate Input Monitoring + Accessibility status
- [ ] With both permissions granted, typing `:shrug` produces `¯\_(ツ)_/¯`
- [ ] `bun dispatch --mode=install` succeeds without DMG errors
