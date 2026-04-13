# Batch 3: UX Enhancements Spec

## 1. CMD+N Page Navigation Hotkeys

### Problem
No keyboard shortcut to switch between screens (Feed, Sessions, Telemetry, Expander, Settings). Users must click header icons.

### Solution
Add **in-app** hotkeys CMD+1 through CMD+5 that map to screens in header order. These are **app-scope only** (not global shortcuts — they only fire while the Dispatch window is focused).

### Screen Mapping
| Shortcut | Screen | Header Icon |
|----------|--------|-------------|
| CMD+1 | Feed (home) | — |
| CMD+2 | Sessions | Grid |
| CMD+3 | Telemetry | Bar chart |
| CMD+4 | Expander | Code arrows |
| CMD+5 | Settings | Gear |

### Changes

**`src/hooks/useHotkeys.ts`**
- Add `navigateTo: (screen: string) => void` to `HotkeyActions` interface
- Add `navigate_feed`, `navigate_sessions`, `navigate_telemetry`, `navigate_expander`, `navigate_settings` to `ACTION_MAP`
- In the keydown handler, detect `e.metaKey && e.key === "1"` (etc.) **before** the normal key lookup. CMD+key combos must `e.preventDefault()` to avoid browser defaults.

**`src/App.tsx`**
- Add `navigateTo` action to `hotkeyActions` that calls `setActiveScreen(screen)`
- The mapping: `"1" → "feed"`, `"2" → "sessions"`, `"3" → "telemetry"`, `"4" → "expander"`, `"5" → "settings"`

**Hotkey config (optional)**
- These are hardcoded in-app shortcuts, NOT part of the configurable hotkey system. They use CMD modifier which separates them from the rebindable single-key shortcuts.

### Behavior
- Only fires when Dispatch window is focused (standard DOM keydown)
- CMD+1 always goes to Feed regardless of current screen (not a toggle)
- Does nothing if user is typing in an input field

---

## 2. Command Palette (CMD+K)

### Problem
No quick way to navigate between screens or trigger actions without memorizing all hotkeys.

### Solution
Add a CMD+K command palette overlay (similar to VS Code, Raycast, etc.). App-focused only.

### New File: `src/components/CommandPalette.tsx`

**UI Design**
- Full-screen overlay with centered modal (same style as `ExpanderPalette`)
- Search input auto-focused on open
- List of commands filtered by search query
- Keyboard navigation: Arrow keys / j/k, Enter to select, Escape to close

**Command List**
| Command | Action | Category |
|---------|--------|----------|
| Go to Feed | `setActiveScreen("feed")` | Navigation |
| Go to Sessions | `setActiveScreen("sessions")` | Navigation |
| Go to Analytics | `setActiveScreen("telemetry")` | Navigation |
| Go to Text Expander | `setActiveScreen("expander")` | Navigation |
| Go to Settings | `setActiveScreen("settings")` | Navigation |
| Mark All Read | `markAllRead()` | Actions |
| Clear All Notifications | `clearAll()` | Actions |
| Toggle Keyboard Shortcuts | `setShowHelp(true)` | Help |

**Fuzzy matching**: Simple `includes()` substring match on command label (no need for a library).

### Changes

**`src/components/CommandPalette.tsx`** (new)
- Props: `onClose`, `onAction: (action: string) => void`
- Renders overlay → search input → filtered command list
- Keyboard: ArrowDown/Up navigate, Enter selects, Escape closes

**`src/App.tsx`**
- Add `const [showCommandPalette, setShowCommandPalette] = useState(false)`
- Listen for CMD+K in a `useEffect` (separate from `useHotkeys` since this needs CMD modifier)
- Render `<CommandPalette>` when open
- Handle `onAction` callback with switch over action names

---

## 3. Project Cards Show Local File Path

### Problem
The card view in SessionTracker shows `directory` (via `formatDirectory()`) but this is only shown when `session.directory !== null`. Looking at the screenshot, directory is showing on cards that have it. The issue is that `last_tmux_session` could indicate a local path context that isn't being surfaced.

### Current State
`ProjectCard` already shows `session.directory` when present (folder icon + truncated path). `SessionRow` (list view) does **not** show directory.

### Solution
1. **Show directory in `SessionRow`** (list view) — add a line showing the directory path below the stats, matching the card view style
2. **Ensure tmux session name is shown** — if `session.last_tmux_session` is set, show it as a small badge (e.g., `tmux: render`) so the user knows which tmux session the project occupies

### Changes

**`src/components/SessionTracker.tsx`**

In `SessionRow`:
- After the stats row, add a directory line (folder icon + `formatDirectory(session.directory)`) when `session.directory` is present
- Add tmux session badge showing `session.last_tmux_session` when present

In `ProjectCard`:
- Add tmux session badge (small chip: `tmux: {session_name}`) next to the source badge when `session.last_tmux_session` is present

---

## 4. Chart Tooltip Stats on Hover

### Problem
The Activity bar chart in TelemetryScreen only shows a plain `title` attribute on bars. No rich tooltip appears when hovering.

### Current State
Each bar has `title={`${day}: ${count}`}` — this renders as a native browser tooltip (delayed, plain text, no styling).

### Solution
Replace the native `title` with a custom positioned tooltip that appears instantly on hover, showing date and count with styled presentation.

### New Component: Inline in `TelemetryScreen.tsx`

**`ChartTooltip`**
- Positioned absolutely above the hovered bar
- Shows: date (formatted nicely, e.g. "Mar 23") and count (e.g. "42 events")
- Dark background, light text, small rounded container
- Appears on mouseEnter, disappears on mouseLeave
- Uses state: `hoveredBar: { day: string, count: number, x: number } | null`

### Changes

**`src/components/TelemetryScreen.tsx`**
- Add `hoveredBar` state to the Activity chart section
- Replace `title` attribute on bar `<div>` with `onMouseEnter` / `onMouseLeave` handlers
- Render a positioned tooltip `<div>` when `hoveredBar` is set
- The tooltip is absolute positioned relative to the chart container, centered above the hovered bar

---

## 5. Fix Live Expansion macOS Assessment

### Problem
The current UI says "Not available on macOS" which is incorrect. Tools like Espanso work on macOS by using the Accessibility API (not `rdev`). The `rdev` listener crashes because it calls `TSMGetInputSourceProperty` from a background thread, but there are alternative approaches.

### Current State (lib.rs lines 84-108)
The `rdev::listen` call is disabled on macOS with a compile-time `#[cfg(not(target_os = "macos"))]` gate. The comment explains the TSM crash.

### Root Cause
`rdev` uses Carbon's Text Services Manager from a non-main thread, which causes `_dispatch_assert_queue_fail`. This is a `rdev` limitation, not a macOS limitation.

### Solution: Two-Phase Approach

**Phase 1 (This batch): Fix the UI messaging**
- Change text from "Not available on macOS" to "Requires Input Monitoring permission" (which is what Espanso also requires)
- Add a note: "Live expansion uses system-level keyboard monitoring. Grant access in System Settings > Privacy & Security > Input Monitoring."
- Keep the toggle functional — let users enable it (the backend will store the setting)
- The backend listener is still disabled, but don't tell users the feature is impossible

**Phase 2 (Future): Replace rdev with CGEventTap**
- Use `core-graphics` crate's `CGEventTapCreate` which works correctly on macOS
- This runs on the main thread / dispatch queue correctly
- Espanso uses this exact approach
- Out of scope for this batch but the UI should not claim impossibility

### Changes

**`src/components/SnippetManager.tsx`** — `LiveExpansionToggle`
- Remove `isMacOS` gating that disables the toggle
- Change the subtitle text to: "Requires Input Monitoring permission in System Settings"
- Keep the toggle interactive (saves setting to DB)
- Add a small info icon that links to or explains the permission requirement

---

## 6. Toast Confirmation on Clipboard Copy

### Problem
When copying text to clipboard (snippets, field values), there's no visual confirmation. User can't tell if the copy succeeded.

### Solution
Create a global toast notification system. Show a brief toast ("Copied to clipboard") on every clipboard write.

### New File: `src/components/Toast.tsx`

**Toast Component**
- Fixed position: bottom-center of the window
- Auto-dismisses after 2 seconds
- Slides up on appear, fades out on dismiss
- Minimal: icon + text, dark bg, light text, rounded

**Toast Context/Hook: `src/hooks/useToast.ts`**
- `ToastProvider` wraps the app
- `useToast()` returns `{ showToast: (message: string) => void }`
- Manages a queue of toasts with auto-dismiss timers
- Maximum 1 toast visible at a time (new toast replaces old)

### Changes

**`src/App.tsx`**
- Wrap app content with `<ToastProvider>`

**`src/components/SnippetManager.tsx`**
- In `SnippetRow.handleCopy`: call `showToast("Copied to clipboard")`
- In `FieldLabel.handleCopy`: call `showToast("Copied to clipboard")`

**`src/components/ExpanderPalette.tsx`**
- After `navigator.clipboard.writeText(text)`: show toast

**`src/App.tsx`**
- In `handleExpand`: show toast after clipboard write

---

## 7. Terminal Focus Tooltip

### Problem
When clicking a session/notification to focus a terminal window, there's no visual feedback that the action was triggered (the terminal window opens in the background via tmux).

### Solution
Show a toast notification when focusing a terminal. Use the toast system from item 6.

### Changes

**`src/App.tsx`** — `handleFocusTerminal`
- After the `focusTerminal()` call, show toast: `"Focused terminal: {session}"`
- Include the tmux session name in the message

**`src/components/SessionTracker.tsx`**
- No changes needed — it already calls `onFocusTerminal` which is handled in App.tsx

---

## 8. Fix Yapture OAuth Integration

### Problem
Clicking "Connect with Yapture" opens `api.yapture.app/authorize?client_id=dispatch-desktop&redirect_uri=dispatch://oauth/callback...` which returns "Authorization Error: Invalid client_id or redirect_uri." The `dispatch-desktop` client is not registered on the Yapture platform.

### Root Cause Analysis
From the Yapture marketplace codebase (`~/Code/yapture/market`):
1. OAuth clients must be **registered** in Yapture's admin system (`.yapture/oauth.json` defines known clients)
2. The marketplace uses `client_id=yapture-market` which is pre-registered
3. `dispatch-desktop` was never registered as an OAuth client
4. The redirect URI `dispatch://` (deep link) must also be registered in the client config

### Correct Integration Pattern
Yapture marketplace apps integrate via:
1. **Registration**: App must be registered in Yapture admin with a `client_id`, `redirect_uri`, and allowed `scopes`
2. **OAuth endpoints**: `{apiUrl}/authorize` (GET), `{apiUrl}/token` (POST), `{apiUrl}/api/userinfo` (GET)
3. **PKCE**: Required — code_challenge + code_verifier (the Rust code already implements this correctly)
4. **Scopes**: `openid profile email api:read api:write`

### Solution

**Step 1: Register `dispatch-desktop` as an OAuth client**
- This must be done in the Yapture admin system, not in Dispatch code
- Client config needed:
  ```json
  {
    "id": "dispatch-desktop",
    "name": "Dispatch Desktop",
    "redirectUris": ["dispatch://oauth/callback"],
    "scopes": ["openid", "profile", "email", "api:read", "api:write"]
  }
  ```
- **Action**: Register this client in the Yapture admin portal. This is a Yapture-side change.

**Step 2: Verify/fix the OAuth URL construction**

**`src-tauri/src/yapture.rs`** — `start_oauth_flow()`
- The current code constructs the URL correctly: `{api_url}/authorize?client_id=dispatch-desktop&...`
- The PKCE flow is correctly implemented (code_verifier, code_challenge, S256)
- The redirect_uri `dispatch://oauth/callback` is correct for a Tauri deep-link app
- **No code changes needed once the client is registered**

**Step 3: Fix the default API URL**

The default API URL `https://api.yapture.app` is correct per the Yapture environment config:
- Production: `https://api.yapture.app`
- Staging: `https://api.yapture.dev`
- Local: `http://localhost:4728`

**Step 4: Clean up the Settings UI**

**`src/components/YaptureSettings.tsx`** — `YaptureTab`
- When not connected, show ONLY the "Connect with Yapture" button
- Remove the "Advanced: Manual Configuration" section entirely from the non-connected view
- The API URL, User ID, and Service Token fields are irrelevant for OAuth-based connection
- When connected, show: connection status, enabled toggle, test connection, disconnect
- Add an environment selector (Production / Staging / Local) that sets the correct API URL behind the scenes, instead of exposing a raw URL field

**`src-tauri/src/yapture.rs`**
- No code changes to OAuth flow (it's correct)
- The `test_connection` function uses ServiceToken auth which won't work with OAuth tokens — update to use Bearer token auth with the stored access_token instead

### Verification Checklist
- [ ] `dispatch-desktop` client registered in Yapture admin
- [ ] OAuth flow opens correct URL (no error page)
- [ ] Authorization code exchange works
- [ ] User info is fetched and displayed
- [ ] Access token is stored and used for API calls
- [ ] Token refresh works when access token expires
- [ ] Disconnect clears all stored tokens
- [ ] Environment selector works (prod/staging/local)

---

## Implementation Order

1. **Toast system** (item 6) — foundation for items 7 and clipboard feedback
2. **CMD+N navigation** (item 1) — quick win, no new components
3. **Command palette** (item 2) — depends on navigation actions being wired
4. **Chart tooltips** (item 4) — self-contained
5. **Project card paths** (item 3) — self-contained
6. **Live expansion messaging** (item 5) — UI text change only
7. **Clipboard toast integration** (item 6 continued) — wire toast into all copy actions
8. **Terminal focus toast** (item 7) — uses toast system
9. **Yapture OAuth** (item 8) — requires Yapture-side client registration first
