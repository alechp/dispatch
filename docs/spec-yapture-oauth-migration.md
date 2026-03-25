# Spec: Migrate Yapture Auth to @yapture/auth + Environment Presets

## Overview

Replace Dispatch's custom Rust-side OAuth PKCE flow with `@yapture/auth` (a TypeScript library that runs in the WebView), and replace the free-text API URL field with environment presets (localhost / staging / production). All Yapture API calls switch from `ServiceToken` to `Bearer` auth using the OAuth access token.

### Why

1. **Single source of truth** — `@yapture/auth` already implements PKCE, token refresh, and environment config. Duplicating this in Rust is maintenance overhead.
2. **Token refresh** — `@yapture/auth` handles auto-refresh transparently via `getAccessToken()`. The current Rust implementation has `refresh_access_token()` but nothing calls it automatically.
3. **Environment presets** — Users shouldn't need to know or type API URLs. The three environments (localhost, staging, production) are fixed and known.

---

## Part 1: Environment Presets

### Current State

The `yapture_api_url` setting is a free-text string stored in the `settings` table, defaulting to `"https://api.yapture.app"`. The user manually types or pastes the URL.

### Target State

Replace `yapture_api_url` with `yapture_environment`, an enum of three values:

| Environment | API URL (resolved by `@yapture/auth`) |
|-------------|---------------------------------------|
| `localhost` | `http://localhost:4728` |
| `staging` | `https://api-staging.yapture.com` |
| `production` | `https://api.yapture.com` |

URL resolution is handled by `@yapture/auth`'s `ENVIRONMENT_CONFIGS` on the frontend. The Rust backend needs a parallel mapping for server-side API calls (push_notification).

### Migration — `009_yapture_environment.sql`

```sql
-- Replace free-text URL with environment preset
-- Default to 'production' for existing installs
INSERT OR IGNORE INTO settings (key, value) VALUES ('yapture_environment', 'production');
-- Note: yapture_api_url rows are left in place (harmless), not deleted
```

### Rust Changes

**`yapture.rs`** — Add environment-to-URL resolver:

```rust
pub fn environment_to_api_url(environment: &str) -> &'static str {
    match environment {
        "localhost" => "http://localhost:4728",
        "staging" => "https://api-staging.yapture.com",
        _ => "https://api.yapture.com", // "production" or any unknown value
    }
}
```

Update `load_config()` to read `yapture_environment` instead of `yapture_api_url`, then resolve via `environment_to_api_url()`.

**`commands.rs`** — New commands:

```rust
#[tauri::command]
pub async fn get_yapture_environment(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String>
// Returns current environment string ("localhost" | "staging" | "production")

#[tauri::command]
pub async fn set_yapture_environment(
    state: State<'_, Arc<AppState>>,
    environment: String,
) -> Result<(), String>
// Validates input is one of the three values, saves to settings table
```

### Frontend Changes

**`YaptureSettings.tsx`** — Replace the API URL text input with a dropdown:

```
┌─ Environment ─────────────────────────────┐
│  [  Production  ▾ ]                       │
│                                           │
│  Options:                                 │
│    - localhost  (http://localhost:4728)    │
│    - staging                              │
│    - production                           │
└───────────────────────────────────────────┘
```

**`yapture.ts`** — New API wrappers:

```typescript
export async function getYaptureEnvironment(): Promise<string> {
  return invoke("get_yapture_environment");
}

export async function setYaptureEnvironment(environment: string): Promise<void> {
  return invoke("set_yapture_environment", { environment });
}
```

---

## Part 2: Frontend OAuth via @yapture/auth

### Current State

OAuth is implemented entirely in Rust:
- `yapture.rs` contains `start_oauth_flow()` (PKCE generation), `exchange_code()`, `fetch_userinfo()`, `refresh_access_token()`
- `state.rs` holds `oauth_pending: Mutex<Option<OAuthState>>` and `YaptureTokens { service_token, access_token, refresh_token }`
- `lib.rs` has a deep-link handler that parses the callback URL, validates state, exchanges the code, fetches userinfo, and stores everything
- `commands.rs` exposes `yapture_start_oauth` which generates PKCE and returns an auth URL
- Cargo.toml includes `sha2`, `base64`, `rand`, `urlencoding` for PKCE support

### Target State

Move the entire OAuth flow to the frontend using `@yapture/auth`:

1. Frontend creates a `YaptureAuthClient` configured with the selected environment
2. Frontend calls `buildAuthorizationUrl()` to get the auth URL (PKCE handled internally)
3. Auth URL opens in the system browser
4. Deep link `dispatch://oauth/callback` fires in Rust
5. Rust simply relays the raw URL to the frontend via `emit("oauth-callback-url", url)`
6. Frontend calls `handleCallback(url)` — `@yapture/auth` validates state, exchanges code, stores tokens in localStorage
7. Frontend syncs the access token to Rust via a new `set_yapture_access_token` command (Rust needs it for server-side `push_notification` calls)
8. Token auto-refresh is handled by `@yapture/auth`'s `getAccessToken()` — returns a valid token, refreshing if needed

### Install @yapture/auth

```json
// package.json
"dependencies": {
  "@yapture/auth": "file:../yapture/packages/auth"  // or GitHub Packages registry
}
```

The library exports:
- `YaptureAuthClient` — class managing OAuth + token lifecycle
- `ENVIRONMENT_CONFIGS` — environment name → { apiUrl, authUrl } mapping
- `buildAuthorizationUrl()` → `{ url, state, codeVerifier }`
- `handleCallback(url)` → exchanges code for tokens
- `getAccessToken()` → returns valid token (auto-refreshes)

### Frontend Implementation

**`src/lib/yapture-auth.ts`** (new file):

```typescript
import { YaptureAuthClient, ENVIRONMENT_CONFIGS } from "@yapture/auth";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let authClient: YaptureAuthClient | null = null;

export function initAuthClient(environment: string) {
  const config = ENVIRONMENT_CONFIGS[environment];
  authClient = new YaptureAuthClient({
    clientId: "dispatch-desktop",
    redirectUri: "dispatch://oauth/callback",
    ...config,
  });
}

export async function startOAuthFlow(): Promise<string> {
  if (!authClient) throw new Error("Auth client not initialized");
  const { url } = authClient.buildAuthorizationUrl();
  return url;
}

export function setupCallbackListener() {
  return listen<string>("oauth-callback-url", async (event) => {
    if (!authClient) return;
    await authClient.handleCallback(event.payload);
    // Sync token to Rust for server-side API calls
    const token = await authClient.getAccessToken();
    if (token) {
      await invoke("set_yapture_access_token", { token });
    }
  });
}

export async function getAccessToken(): Promise<string | null> {
  if (!authClient) return null;
  return authClient.getAccessToken();
}

export async function logout() {
  authClient?.logout();
  await invoke("set_yapture_access_token", { token: null });
}
```

**`src/components/YaptureSettings.tsx`** — Update the Connect flow:

```typescript
// Before (Rust-based):
const url = await yaptureStartOAuth();  // Rust generates PKCE
await openUrl(url);
// Listen for "yapture-connected" event (Rust does everything)

// After (frontend-based):
initAuthClient(environment);
const url = await startOAuthFlow();     // @yapture/auth generates PKCE
await openUrl(url);
// Listen for "oauth-callback-url" event (Rust just relays the URL)
// handleCallback() does code exchange + stores tokens
```

**`src/App.tsx`** — On mount:
1. Read `yapture_environment` from Rust
2. Call `initAuthClient(environment)`
3. Call `setupCallbackListener()`
4. If previously connected, sync token to Rust: `set_yapture_access_token(await getAccessToken())`

### Token Sync Strategy

`@yapture/auth` stores tokens in `localStorage`. On app startup:
1. Frontend reads token from localStorage via `getAccessToken()` (auto-refreshes if expired)
2. Frontend sends valid token to Rust via `set_yapture_access_token`
3. Rust stores it in `AppState.yapture_access_token: Mutex<Option<String>>`
4. Server-side `push_notification()` uses this token with `Bearer` auth

Re-sync happens:
- On app startup
- After OAuth callback
- After token refresh (if `@yapture/auth` exposes a refresh event, or poll periodically)

---

## Part 3: Rust Backend Simplification

### Code to Remove

**`yapture.rs`** — Delete these items:
- `OAuthState` struct
- `TokenResponse` struct
- `UserInfo` struct
- `start_oauth_flow()` function
- `exchange_code()` function
- `fetch_userinfo()` function
- `refresh_access_token()` function

**`state.rs`** — Remove/simplify:
```rust
// Remove:
pub oauth_pending: std::sync::Mutex<Option<crate::yapture::OAuthState>>,
pub yapture_tokens: std::sync::Mutex<YaptureTokens>,

// Remove:
pub struct YaptureTokens { ... }

// Add:
pub yapture_access_token: std::sync::Mutex<Option<String>>,
```

**`commands.rs`** — Remove:
- `yapture_start_oauth` command (OAuth now handled in frontend)

**`lib.rs`** — Simplify deep link handler:
```rust
// Before: Parse URL, validate state, exchange code, fetch userinfo, store tokens
// After: Just relay the URL to the frontend
app.listen("deep-link://new-url", move |event| {
    let urls: Vec<String> = match serde_json::from_str(event.payload()) {
        Ok(u) => u,
        Err(_) => return,
    };
    if let Some(url) = urls.first() {
        if url.starts_with("dispatch://oauth/callback") {
            if let Some(window) = deep_link_handle.get_webview_window("main") {
                let _ = window.emit("oauth-callback-url", url);
            }
        }
    }
});
```

**`Cargo.toml`** — Remove unused deps:
```toml
# Remove these (only used by Rust OAuth):
sha2 = "0.10"
base64 = "0.22"
rand = "0.8"
urlencoding = "2"
```

Keep `url = "2"` (still used for URL parsing in deep link handler, if needed — or remove if the handler becomes a simple string relay).

### New Commands

```rust
#[tauri::command]
pub async fn set_yapture_access_token(
    state: State<'_, Arc<AppState>>,
    token: Option<String>,
) -> Result<(), String>
// Frontend syncs the OAuth Bearer token to Rust.
// Stored in AppState.yapture_access_token.

#[tauri::command]
pub async fn set_yapture_user_info(
    state: State<'_, Arc<AppState>>,
    user_id: String,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<(), String>
// Frontend syncs user info (from @yapture/auth userinfo endpoint) to Rust settings DB.
// Writes yapture_user_id, yapture_user_name, yapture_user_email.
```

### Auth Header Change

**`yapture.rs` — `push_notification()`**:

```rust
// Before:
.header("Authorization", format!("ServiceToken {}", config.service_token))
.header("X-User-ID", &config.user_id)

// After:
.header("Authorization", format!("Bearer {}", config.access_token))
```

The `X-User-ID` header is no longer needed — the Bearer token identifies the user.

Update `YaptureConfig`:
```rust
pub struct YaptureConfig {
    pub enabled: bool,
    pub api_url: String,    // resolved from environment
    pub access_token: String, // OAuth Bearer token from frontend
}
```

Update `load_config()`:
```rust
pub async fn load_config(
    pool: &sqlx::SqlitePool,
    access_token: Option<String>,
) -> Option<YaptureConfig> {
    let enabled = crate::db::get_setting(pool, "yapture_enabled").await.ok()?;
    if enabled.as_deref() != Some("1") {
        return None;
    }
    let environment = crate::db::get_setting(pool, "yapture_environment")
        .await.ok()?
        .unwrap_or_else(|| "production".to_string());
    let api_url = environment_to_api_url(&environment).to_string();
    let access_token = access_token?;
    if access_token.is_empty() {
        return None;
    }
    Some(YaptureConfig {
        enabled: true,
        api_url,
        access_token,
    })
}
```

**`server.rs`** — Update token source:
```rust
// Before:
let yapture_token = state.yapture_tokens.lock()
    .ok()
    .and_then(|t| t.service_token.clone());

// After:
let yapture_token = state.yapture_access_token.lock()
    .ok()
    .and_then(|t| t.clone());
```

### Service Token Fallback

The "Advanced: Use Service Token" section in YaptureSettings is **removed**. All auth goes through OAuth. If a user needs headless/CI access, that's a separate concern handled at the Yapture API level (API keys), not in Dispatch.

### Updated `get_yapture_config` response

```rust
pub struct YaptureConfigResponse {
    pub enabled: bool,
    pub environment: String,  // was: api_url
    pub has_token: bool,
}
```

Remove `user_id` from the response — frontend gets user info from `@yapture/auth` directly.

---

## Files to Create / Modify

### New Files

| File | Description |
|------|-------------|
| `src-tauri/migrations/009_yapture_environment.sql` | Add `yapture_environment` setting |
| `src/lib/yapture-auth.ts` | Frontend OAuth wrapper using `@yapture/auth` |

### Modified Files

| File | Changes |
|------|---------|
| `package.json` | Add `@yapture/auth` dependency |
| `src/lib/yapture.ts` | Remove `yaptureStartOAuth()`, add `get/setYaptureEnvironment()`, `setYaptureAccessToken()`, `setYaptureUserInfo()` |
| `src/components/YaptureSettings.tsx` | Replace API URL input with environment dropdown, remove service token section, use `@yapture/auth` for Connect flow |
| `src/App.tsx` | Init auth client on mount, setup callback listener, sync token on startup |
| `src-tauri/src/yapture.rs` | Remove all PKCE/OAuth code, add `environment_to_api_url()`, update `YaptureConfig` + `load_config()` + `push_notification()` to use Bearer auth |
| `src-tauri/src/state.rs` | Remove `oauth_pending` + `YaptureTokens`, add `yapture_access_token: Mutex<Option<String>>` |
| `src-tauri/src/commands.rs` | Remove `yapture_start_oauth`, update `get/set_yapture_config`, add `get/set_yapture_environment`, `set_yapture_access_token`, `set_yapture_user_info` |
| `src-tauri/src/lib.rs` | Simplify deep link handler to URL relay, update command registrations |
| `src-tauri/src/server.rs` | Update Yapture token source from `yapture_tokens` to `yapture_access_token` |
| `src-tauri/Cargo.toml` | Remove `sha2`, `base64`, `rand`, `urlencoding` |

### Commands Summary

| Command | Action |
|---------|--------|
| `get_yapture_environment` | **New** — returns current environment string |
| `set_yapture_environment` | **New** — saves environment to settings |
| `set_yapture_access_token` | **New** — frontend syncs Bearer token to Rust |
| `set_yapture_user_info` | **New** — frontend syncs user info to Rust settings |
| `get_yapture_config` | **Modified** — returns `environment` instead of `apiUrl`, removes `userId` |
| `set_yapture_config` | **Modified** — removes `apiUrl`, `userId`, `serviceToken` params |
| `test_yapture_connection` | **Modified** — uses Bearer token instead of ServiceToken |
| `yapture_start_oauth` | **Removed** — OAuth handled by frontend |
| `yapture_disconnect` | **Kept** — clears settings + tells frontend to logout |
| `get_yapture_connection_status` | **Kept** — unchanged |

---

## Implementation Order

1. **Install `@yapture/auth`** — add to `package.json`, verify it resolves
2. **Migration + environment commands** — `009_yapture_environment.sql`, `get/set_yapture_environment`
3. **Frontend auth wrapper** — `yapture-auth.ts` using `@yapture/auth`
4. **Simplify Rust state** — remove `OAuthState`, `YaptureTokens`, add `yapture_access_token`
5. **Simplify Rust yapture.rs** — remove PKCE functions, update `load_config` + `push_notification` to Bearer auth
6. **Simplify deep link handler** — thin URL relay in `lib.rs`
7. **Update commands** — remove `yapture_start_oauth`, add new commands, update existing ones
8. **Update frontend** — `YaptureSettings.tsx` with environment dropdown + `@yapture/auth` Connect flow
9. **Update `App.tsx`** — init auth client, setup listener, token sync on startup
10. **Remove Cargo deps** — `sha2`, `base64`, `rand`, `urlencoding`
11. **Verify** — `cargo check`, `npx tsc --noEmit`, manual testing

## Verification Checklist

- [ ] `cargo check` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Environment dropdown shows three options and persists selection
- [ ] "Connect with Yapture" opens browser to correct auth URL (per environment)
- [ ] Deep link callback relays URL to frontend (check via console log)
- [ ] `@yapture/auth` handles code exchange + token storage in localStorage
- [ ] Access token syncs from frontend to Rust on connect + on startup
- [ ] `push_notification()` uses `Bearer {token}` header (not `ServiceToken`)
- [ ] Token auto-refreshes when expired (via `getAccessToken()`)
- [ ] "Disconnect" clears localStorage tokens + Rust state + settings
- [ ] Removed Cargo deps don't break build (`sha2`, `base64`, `rand`, `urlencoding`)
- [ ] No `ServiceToken` references remain in codebase (except comments/docs)
