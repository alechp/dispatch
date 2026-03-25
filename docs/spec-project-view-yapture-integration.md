# Spec: Project View Enhancements + Yapture Integration

## Overview

Two features for Dispatch:

1. **Project View Toggle** — Add list/card view toggle to the Sessions screen. Card view surfaces richer project metadata (directory, git info).
2. **Yapture Integration** — Push incoming Dispatch notifications to Yapture as tasks + notifications via API, authenticated with a service token.

---

## Part 1: Project View — List/Card Toggle

### Current State

`SessionTracker.tsx` renders projects as a flat list of `SessionRow` components. Each row shows: project name, last event title, source badge, status dot, notification/unread/error counts, and a time-ago timestamp. The data comes from the `project_sessions` table via `useProjectSessions()`.

**Available fields on `ProjectSession`:**
- `project`, `source`, `first_seen_at`, `last_seen_at`
- `last_event_type`, `last_title`, `last_body`, `last_metadata`
- `last_tmux_session`, `last_tmux_window`, `last_tmux_pane`
- `notification_count`, `unread_count`, `error_count`

### What's Missing

The `ProjectSession` model has no `directory` or `git_repo` field. Notifications carry a `metadata` JSON field that _could_ contain this data, but nothing enforces it today. We need to:

1. Extend the schema to store project directory + git remote URL.
2. Populate these fields when notifications arrive (from `metadata`), or allow manual override via the UI / a new command.

### Schema Changes

#### Migration `006_project_metadata.sql`

```sql
ALTER TABLE project_sessions ADD COLUMN directory TEXT;
ALTER TABLE project_sessions ADD COLUMN git_remote TEXT;
```

#### Rust Model — `models.rs`

Add to `ProjectSession`:

```rust
pub directory: Option<String>,
pub git_remote: Option<String>,
```

#### TypeScript Type — `types.ts`

```typescript
export interface ProjectSession {
  // ... existing fields ...
  directory: string | null;
  git_remote: string | null;
}
```

### Data Population Strategy

**Automatic (from notification metadata):**
When `upsert_project_session()` runs and the notification has `metadata`, parse it as JSON. If the JSON contains `"directory"` or `"git_remote"`, write those values to the session (only if the session's current values are NULL — don't overwrite).

Example notification metadata payload:
```json
{
  "directory": "/Users/alechp/Code/yapture/app",
  "git_remote": "git@github.com:capswan/yapture.git"
}
```

**Manual (Tauri command):**
Add a `update_project_metadata` command:
```rust
#[tauri::command]
pub async fn update_project_metadata(
    state: State<'_, Arc<AppState>>,
    project: String,
    source: String,
    directory: Option<String>,
    git_remote: Option<String>,
) -> Result<(), String>
```

This lets the card view's edit UI (or future CLI integrations) set the fields directly.

### Frontend Changes

#### `SessionTracker.tsx`

**State:**
```typescript
type ViewMode = "list" | "cards";
const [viewMode, setViewMode] = useState<ViewMode>("cards");
```

Persist preference in `localStorage` under key `dispatch:session-view-mode`.

**Top Bar — Add toggle buttons:**

Place a two-button toggle group between the search input and any action buttons:

```
[ <Back ]  [ Search..._________________ ]  [ ☰ | ▦ ]
```

- `☰` = list icon (current behavior)
- `▦` = grid/card icon

Use `aria-pressed` for accessibility. Active button gets `bg-accent text-white`, inactive gets `bg-surface-overlay text-text-secondary`.

**List View (existing):**
No changes. Render `SessionRow` components exactly as they are today.

**Card View (new):**

Render a responsive CSS grid of `ProjectCard` components:

```
grid grid-cols-1 sm:grid-cols-2 gap-3 p-4
```

Each card renders inside a `div` with:
```
bg-surface-raised border border-border-subtle rounded-lg p-4
hover:border-accent/30 transition-colors cursor-pointer
```

#### `ProjectCard` Component — Layout

```
┌──────────────────────────────────────┐
│  [●] project-name              2m ago│  ← status dot + name + time
│  source-badge                        │
├──────────────────────────────────────┤
│  📁 /Users/alechp/Code/myapp        │  ← directory (if set)
│  🔗 github.com/user/repo            │  ← git remote (if set, show short form)
├──────────────────────────────────────┤
│  Last: "Build failed in module X"    │  ← last_title, truncated
├──────────────────────────────────────┤
│  12 total  · 3 unread  · 1 error    │  ← stat pills
└──────────────────────────────────────┘
```

**Git remote display:** Parse the `git_remote` URL to extract `github.com/user/repo` (strip `git@`, `.git`, protocol prefixes). Show as a clickable link that opens in the default browser via `tauri_plugin_opener`.

**Directory display:** Show the last 3 path segments (e.g., `~/Code/yapture/app`). Truncate with `...` if needed.

**Empty state for directory/git:** If both are null, omit the metadata section entirely (card is shorter). Optionally show a subtle "Set project directory..." link that triggers the manual metadata update flow.

**Click behavior:** Same as list view — if `last_tmux_session` exists, focus terminal. Otherwise, no-op.

#### Frontend API — `api.ts`

```typescript
export async function updateProjectMetadata(
  project: string,
  source: string,
  directory?: string,
  gitRemote?: string,
): Promise<void> {
  return invoke("update_project_metadata", {
    project,
    source,
    directory: directory ?? null,
    gitRemote: gitRemote ?? null,
  });
}
```

### DB Layer Changes — `db.rs`

1. **`upsert_project_session()`** — Extend the INSERT/UPDATE to include `directory` and `git_remote`. On insert, attempt to extract from notification metadata JSON. On conflict, only update if the incoming value is non-null and the existing value is null (`COALESCE`).

2. **`get_project_sessions()`** — Add `directory, git_remote` to the SELECT columns.

3. **`update_project_metadata()`** — New function:
   ```rust
   pub async fn update_project_metadata(
       pool: &SqlitePool,
       project: &str,
       source: &str,
       directory: Option<&str>,
       git_remote: Option<&str>,
   ) -> Result<(), sqlx::Error>
   ```
   Updates `directory` and/or `git_remote` on the matching `(project, source)` row.

### Files to Create / Modify

| File | Action | Description |
|------|--------|-------------|
| `migrations/006_project_metadata.sql` | Create | Add directory + git_remote columns |
| `src-tauri/src/models.rs` | Modify | Add fields to `ProjectSession` |
| `src-tauri/src/db.rs` | Modify | Migration, upsert, query, new update fn |
| `src-tauri/src/commands.rs` | Modify | Add `update_project_metadata` command |
| `src-tauri/src/lib.rs` | Modify | Register new command |
| `src/lib/types.ts` | Modify | Add fields to `ProjectSession` |
| `src/lib/api.ts` | Modify | Add `updateProjectMetadata()` |
| `src/components/SessionTracker.tsx` | Modify | Add view toggle, card grid, `ProjectCard` |

---

## Part 2: Yapture Integration

### Goal

When Dispatch receives a notification (via the HTTP API or WebSocket), automatically push it to Yapture as both a **task** and a **notification**, tagged with the Dispatch project name.

### Yapture API Summary

**Base URL:** `https://api.yapture.app` (prod) / `https://api.yapture.dev` (staging)

**Authentication:** Service token via header:
```
Authorization: ServiceToken {YAPTURE_SERVICE_TOKEN}
X-User-ID: {yapture_user_id}
```

**Create Task — `POST /api/tasks`**
```json
{
  "text": "string (required)",
  "parentId": "string (optional)",
  "skipNLP": true
}
```
Response includes `id`, `text`, `tags`, `createdAt`, etc.

**Notification Types available:**
`CAPSWAN_TASK_CREATED`, `CAPSWAN_TASK_COMPLETED`, `CAPSWAN_ORG_LINKED`, and others. For Dispatch integration, the best fit is reusing the Capswan webhook pattern since Dispatch is a sibling product.

**Capswan Webhook — `POST /api/webhooks/capswan/task.created`**
```json
{
  "capswanTaskId": "dispatch-notif-{id}",
  "yaptureTaskId": "{id from task creation}",
  "organizationId": "dispatch",
  "organizationName": "Dispatch",
  "taskTitle": "{notification title}",
  "taskStatus": "open",
  "userId": "{yapture_user_id}",
  "createdAt": "{ISO 8601}"
}
```
This creates a Yapture notification of type `CAPSWAN_TASK_CREATED` linked to the task.

### Architecture

```
Dispatch Notification Arrives (HTTP POST or broadcast)
  │
  ├── Existing: insert_notification() → broadcast → UI
  │
  └── New: if yapture integration enabled
        │
        ├── 1. POST /api/tasks  (creates Yapture task)
        │     body: { text: "[{project}] {title}: {body}", skipNLP: true }
        │     auth: ServiceToken + X-User-ID
        │
        └── 2. POST /api/webhooks/capswan/task.created
              body: { capswanTaskId, yaptureTaskId, ... }
              auth: ServiceToken
              → This creates a CAPSWAN_TASK_CREATED notification in Yapture
```

Both calls are fire-and-forget (spawned as async tasks). Failures are logged but don't block notification delivery.

### Configuration — Settings & Secrets

#### New settings keys (in existing `settings` table):

| Key | Value | Description |
|-----|-------|-------------|
| `yapture_enabled` | `"0"` or `"1"` | Master toggle |
| `yapture_api_url` | `"https://api.yapture.app"` | API base URL |
| `yapture_user_id` | `"{uuid}"` | Yapture user ID to attribute tasks to |

#### Service token storage:

The `YAPTURE_SERVICE_TOKEN` is a secret and should NOT be stored in the SQLite `settings` table (plaintext, no encryption). Instead:

- **macOS:** Store in the system keychain via `security` CLI or the `keyring` crate.
- **Fallback:** Read from environment variable `YAPTURE_SERVICE_TOKEN`.
- **UI flow:** User pastes the token in a settings panel. Dispatch writes it to the keychain. On startup, Dispatch reads it from keychain → env var fallback → disabled.

For the initial implementation, use **environment variable only** (`YAPTURE_SERVICE_TOKEN`). Keychain integration can follow later.

### Migration — `007_yapture_settings.sql`

```sql
INSERT OR IGNORE INTO settings (key, value) VALUES ('yapture_enabled', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('yapture_api_url', 'https://api.yapture.app');
INSERT OR IGNORE INTO settings (key, value) VALUES ('yapture_user_id', '');
```

### Rust Module — `src-tauri/src/yapture.rs`

```rust
pub struct YaptureConfig {
    pub enabled: bool,
    pub api_url: String,
    pub user_id: String,
    pub service_token: String,  // from env var
}
```

**Functions:**

```rust
/// Load config from DB settings + env var.
/// Returns None if disabled or misconfigured.
pub async fn load_config(pool: &SqlitePool) -> Option<YaptureConfig>

/// Push a Dispatch notification to Yapture as a task + notification.
/// Fire-and-forget — logs errors, never panics.
pub async fn push_notification(
    config: &YaptureConfig,
    notification: &Notification,
)
```

**`push_notification` flow:**

1. Build task text: `"[{project}] {title}"` (append body if present, truncate to 500 chars).
2. `POST {api_url}/api/tasks` with `ServiceToken` auth + `X-User-ID` header.
   - Body: `{ "text": "...", "skipNLP": true }`
3. If task creation succeeds, extract the returned task `id`.
4. `POST {api_url}/api/webhooks/capswan/task.created` with `ServiceToken` auth.
   - Body maps Dispatch fields to Capswan webhook shape.
5. Log success or failure for each step.

**HTTP client:** Use `reqwest` (add to `Cargo.toml`). It's already commonly used with Tokio and supports async.

### Integration Point — `server.rs`

In the notification creation handler (`POST /api/notifications`), after `insert_notification()` succeeds and the notification is broadcast, add:

```rust
// Push to Yapture (fire-and-forget)
let yapture_pool = state.db.clone();
let yapture_notification = notification.clone();
tokio::spawn(async move {
    if let Some(config) = yapture::load_config(&yapture_pool).await {
        yapture::push_notification(&config, &yapture_notification).await;
    }
});
```

### Tagging in Yapture

Yapture supports tags with hierarchical structure. The integration should:

1. Include the Dispatch `project` name as a `#dispatch:{project}` hashtag in the task text. Yapture's NLP parser auto-extracts `#tags` from text.
2. Since we pass `skipNLP: true`, manually tag after task creation is an option for a future iteration. For now, embed the project name in the text prefix (`[project-name]`).

### Tauri Commands — Settings UI

Add commands to manage Yapture configuration:

```rust
#[tauri::command]
pub async fn get_yapture_config(state: ...) -> Result<YaptureConfigResponse, String>
// Returns { enabled, api_url, user_id, has_token: bool }
// Never returns the actual token to the frontend.

#[tauri::command]
pub async fn set_yapture_config(
    state: ...,
    enabled: Option<bool>,
    api_url: Option<String>,
    user_id: Option<String>,
    service_token: Option<String>,  // written to env/keychain, not DB
) -> Result<(), String>

#[tauri::command]
pub async fn test_yapture_connection(state: ...) -> Result<bool, String>
// Calls GET {api_url}/api/webhooks/capswan/health
// Returns true if 200 OK.
```

### Frontend — Settings Panel

Add a "Yapture" section to the settings/configuration area (or a new screen accessible from the header/tray):

```
┌─ Yapture Integration ────────────────────┐
│                                          │
│  Enabled          [  toggle  ]           │
│                                          │
│  API URL          [https://api.yaptu...] │
│  User ID          [paste yapture UUID  ] │
│  Service Token    [••••••••••••••••••• ] │
│                                          │
│  [ Test Connection ]    ✓ Connected      │
│                                          │
└──────────────────────────────────────────┘
```

### Frontend Files

| File | Action | Description |
|------|--------|-------------|
| `src/lib/yapture.ts` | Create | API wrappers: `getYaptureConfig`, `setYaptureConfig`, `testYaptureConnection` |
| `src/components/YaptureSettings.tsx` | Create | Settings panel component |
| `src/App.tsx` | Modify | Add navigation to Yapture settings (new screen or section in existing settings) |

### Cargo.toml

Add:
```toml
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
```

### Files to Create / Modify (Yapture)

| File | Action | Description |
|------|--------|-------------|
| `migrations/007_yapture_settings.sql` | Create | Default settings |
| `src-tauri/src/yapture.rs` | Create | Config loading + push logic |
| `src-tauri/src/commands.rs` | Modify | Add 3 yapture commands |
| `src-tauri/src/lib.rs` | Modify | Register module + commands |
| `src-tauri/src/server.rs` | Modify | Add push hook after notification insert |
| `src-tauri/Cargo.toml` | Modify | Add `reqwest` |
| `src/lib/yapture.ts` | Create | Frontend API wrappers |
| `src/components/YaptureSettings.tsx` | Create | Settings UI |
| `src/App.tsx` | Modify | Navigation to settings |

---

## Part 3: OAuth "Connect" Login

### Goal

Replace manual service token configuration with a one-click OAuth "Connect with Yapture" flow. The user clicks a button in Dispatch, authenticates in their browser, and Dispatch receives tokens automatically. This provides the `user_id` and access token needed for Part 2, eliminating manual UUID and token pasting.

### Yapture OAuth Details

Yapture implements OAuth 2.0 Authorization Code with PKCE (S256 mandatory). Key endpoints:

| Endpoint | URL |
|----------|-----|
| Authorization | `GET {api_url}/authorize` |
| Token | `POST {api_url}/token` |
| UserInfo | `GET {api_url}/api/userinfo` |
| Discovery | `GET {api_url}/.well-known/oauth-authorization-server` |

**Scopes:** `openid profile email api:read api:write`

**Token format:** Access tokens = `yap_at_*` (1 hour TTL), Refresh tokens = `yap_rt_*` (no expiry).

**PKCE:** `code_challenge_method=S256` is mandatory. Plain is rejected.

### Client Registration

Yapture maintains an allowlist of OAuth clients. Dispatch needs to be registered:

```
Client ID:     dispatch-desktop
Redirect URI:  dispatch://oauth/callback
Client Name:   Dispatch
```

This registration happens in Yapture's `ALLOWED_CLIENTS_FALLBACK` array (server-side). Coordinate with Yapture team to add the client before shipping.

### Flow

```
User clicks "Connect with Yapture"
  │
  ├── 1. Dispatch generates PKCE code_verifier (random 43-128 chars)
  │      and code_challenge = BASE64URL(SHA256(code_verifier))
  │
  ├── 2. Opens browser to:
  │      {api_url}/authorize?
  │        client_id=dispatch-desktop&
  │        redirect_uri=dispatch://oauth/callback&
  │        response_type=code&
  │        scope=openid+profile+email+api:read+api:write&
  │        code_challenge={challenge}&
  │        code_challenge_method=S256&
  │        state={random_state}
  │
  ├── 3. User logs in / approves in browser
  │
  ├── 4. Yapture redirects to: dispatch://oauth/callback?code={code}&state={state}
  │
  ├── 5. Tauri deep link handler receives the callback
  │      Validates state matches, then exchanges code for tokens:
  │
  │      POST {api_url}/token
  │      Content-Type: application/x-www-form-urlencoded
  │      Body: grant_type=authorization_code&
  │            code={code}&
  │            redirect_uri=dispatch://oauth/callback&
  │            client_id=dispatch-desktop&
  │            code_verifier={verifier}
  │
  ├── 6. Receives: { access_token, refresh_token, token_type, expires_in, scope }
  │
  ├── 7. Fetches user info:
  │      GET {api_url}/api/userinfo
  │      Authorization: Bearer {access_token}
  │      → { sub, name, email, picture }
  │
  └── 8. Stores tokens + user info:
         - access_token → keychain (or env fallback)
         - refresh_token → keychain (or env fallback)
         - yapture_user_id → settings table (from sub field)
         - yapture_user_name → settings table (for display)
         - yapture_enabled → "1"
```

### Token Refresh

Access tokens expire after 1 hour. Before making API calls (task creation, webhook), check token age and refresh if needed:

```rust
POST {api_url}/token
Content-Type: application/x-www-form-urlencoded
Body: grant_type=refresh_token&
      refresh_token={refresh_token}&
      client_id=dispatch-desktop
```

Refresh tokens have no expiry, so this should always work unless the user revokes access.

### Tauri Deep Link Setup

Tauri 2 supports deep links via `tauri-plugin-deep-link`. Register the `dispatch://` URI scheme:

**`tauri.conf.json`:**
```json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["dispatch"]
      }
    }
  }
}
```

**`Cargo.toml`:**
```toml
tauri-plugin-deep-link = "2"
```

**`lib.rs` setup:**
```rust
.plugin(tauri_plugin_deep_link::init())
```

Handle incoming URLs in the deep link event listener, routing `dispatch://oauth/callback?...` to the token exchange logic.

### Rust Changes

#### `src-tauri/src/yapture.rs` — Extend with OAuth

```rust
pub struct OAuthState {
    pub code_verifier: String,
    pub state: String,
}

/// Generate PKCE challenge pair + state, return authorization URL.
pub fn start_oauth_flow(api_url: &str) -> (String, OAuthState)

/// Exchange authorization code for tokens.
pub async fn exchange_code(
    api_url: &str,
    code: &str,
    oauth_state: &OAuthState,
) -> Result<TokenResponse, String>

/// Fetch user info using access token.
pub async fn fetch_userinfo(
    api_url: &str,
    access_token: &str,
) -> Result<UserInfo, String>

/// Refresh an expired access token.
pub async fn refresh_access_token(
    api_url: &str,
    refresh_token: &str,
) -> Result<TokenResponse, String>
```

#### `src-tauri/src/state.rs` — Add OAuth state

```rust
pub oauth_pending: Mutex<Option<yapture::OAuthState>>,
```

Holds the PKCE verifier + state between initiating the flow and receiving the callback.

#### `src-tauri/src/commands.rs` — New commands

```rust
#[tauri::command]
pub async fn yapture_start_oauth(state: ...) -> Result<String, String>
// Generates PKCE, stores OAuthState, returns authorization URL.
// Frontend opens this URL in the default browser.

#[tauri::command]
pub async fn yapture_disconnect(state: ...) -> Result<(), String>
// Clears tokens from keychain/env, resets settings, sets enabled = "0".

#[tauri::command]
pub async fn get_yapture_connection_status(state: ...) -> Result<YaptureConnectionStatus, String>
// Returns { connected: bool, user_name: Option<String>, user_email: Option<String> }
```

#### Deep link handler (in `lib.rs` setup)

```rust
// In setup, register deep link handler:
app.listen("deep-link://new-url", |event| {
    // Parse URL, extract code + state params
    // Validate state matches oauth_pending
    // Exchange code → tokens
    // Fetch userinfo
    // Store everything
    // Emit "yapture-connected" event to frontend
});
```

### Frontend Changes

#### `src/components/YaptureSettings.tsx` — Update settings panel

Replace the manual token/UUID inputs with a Connect flow:

```
┌─ Yapture Integration ────────────────────┐
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  ✓ Connected as Alec H.           │  │
│  │  alec@example.com                  │  │
│  │                        [Disconnect]│  │
│  └────────────────────────────────────┘  │
│                                          │
│  Enabled          [  toggle  ]           │
│  API URL          [https://api.yaptu...] │
│                                          │
│  [ Test Connection ]    ✓ Connected      │
│                                          │
└──────────────────────────────────────────┘
```

**Disconnected state:**
```
┌─ Yapture Integration ────────────────────┐
│                                          │
│  Push notifications to Yapture as tasks. │
│                                          │
│  [ Connect with Yapture ]                │
│                                          │
│  API URL          [https://api.yaptu...] │
│                                          │
└──────────────────────────────────────────┘
```

"Connect with Yapture" calls `yapture_start_oauth`, then opens the returned URL via `tauri_plugin_opener`. On receiving the `yapture-connected` event, the UI refreshes to show the connected state.

#### `src/lib/yapture.ts` — New API wrappers

```typescript
export async function yaptureStartOAuth(): Promise<string>  // returns auth URL
export async function yaptureDisconnect(): Promise<void>
export async function getYaptureConnectionStatus(): Promise<{
  connected: boolean;
  userName: string | null;
  userEmail: string | null;
}>
```

### Migration — `008_yapture_oauth.sql`

```sql
INSERT OR IGNORE INTO settings (key, value) VALUES ('yapture_user_name', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('yapture_user_email', '');
-- access_token and refresh_token stored in keychain, not DB
```

### Fallback: Service Token

The existing service token flow (Part 2) remains as a fallback for headless / CI environments where browser OAuth isn't practical. The settings panel shows "Connect with Yapture" as the primary flow, with an "Advanced: Use Service Token" collapsible section for manual configuration.

### Files to Create / Modify (OAuth)

| File | Action | Description |
|------|--------|-------------|
| `migrations/008_yapture_oauth.sql` | Create | User name/email settings |
| `src-tauri/src/yapture.rs` | Modify | Add OAuth flow functions (PKCE, token exchange, refresh, userinfo) |
| `src-tauri/src/state.rs` | Modify | Add `oauth_pending: Mutex<Option<OAuthState>>` |
| `src-tauri/src/commands.rs` | Modify | Add `yapture_start_oauth`, `yapture_disconnect`, `get_yapture_connection_status` |
| `src-tauri/src/lib.rs` | Modify | Add deep-link plugin, register handler, register new commands |
| `src-tauri/Cargo.toml` | Modify | Add `tauri-plugin-deep-link`, `sha2`, `base64` |
| `tauri.conf.json` | Modify | Add deep-link plugin config with `dispatch://` scheme |
| `src/lib/yapture.ts` | Modify | Add OAuth API wrappers |
| `src/components/YaptureSettings.tsx` | Modify | Replace manual token UI with Connect/Disconnect flow |

---

## Implementation Order

1. **Part 1A** — Schema + backend for project metadata (migration, model, db, commands)
2. **Part 1B** — Frontend view toggle + card component
3. **Part 2A** — Yapture backend (migration, yapture.rs, reqwest, integration in server.rs)
4. **Part 2B** — Yapture frontend settings panel (service token flow)
5. **Part 3A** — OAuth backend (deep-link plugin, PKCE, token exchange, refresh, userinfo)
6. **Part 3B** — OAuth frontend (Connect/Disconnect UI, event listener)
7. **Verify** — `cargo check`, `tsc --noEmit`, manual testing

## Verification Checklist

- [ ] `cargo check` passes
- [ ] `npx tsc --noEmit` passes
- [ ] View toggle persists across sessions (localStorage)
- [ ] Card view renders directory + git remote when available
- [ ] Card view gracefully omits metadata section when fields are null
- [ ] Click on card focuses terminal (same as list row)
- [ ] Yapture toggle off → no HTTP calls on notification
- [ ] Yapture toggle on + valid config → task appears in Yapture after Dispatch notification
- [ ] Yapture toggle on + invalid token → error logged, notification delivery not blocked
- [ ] "Test Connection" button shows success/failure state
- [ ] Service token is never returned to the frontend (only `has_token: bool`)
- [ ] "Connect with Yapture" opens browser to authorization URL with PKCE
- [ ] Deep link callback (`dispatch://oauth/callback`) exchanges code for tokens
- [ ] Connected state shows user name + email from `/api/userinfo`
- [ ] "Disconnect" clears tokens and resets to disconnected state
- [ ] Token refresh works transparently when access token expires
- [ ] Service token fallback still works when OAuth is not used
