# Spec: Notification Integrations, Native Push & Routing Pipelines

## Status: Draft
## Branch: `spec/notification-integrations`
## Depends on: None (builds on existing notification infrastructure)

---

## Overview

This spec adds three major capabilities to Dispatch's notification system:

1. **External notification sources** — Discord and Slack integrations with full OAuth, multi-account support, and per-account/per-page toggles
2. **macOS native push notifications** — All notification sources can push to the system Notification Center
3. **Notification routing pipelines** — A visual pipeline builder that routes notifications from any source to any destination (e.g., Slack → Discord webhook, Discord → macOS push, or chained A → B → C)

---

## Table of Contents

- [1. Data Model & Schema](#1-data-model--schema)
- [2. Discord Integration](#2-discord-integration)
- [3. Slack Integration](#3-slack-integration)
- [4. Multi-Account Settings UI](#4-multi-account-settings-ui)
- [5. Notification Feed — Per-Provider Styling](#5-notification-feed--per-provider-styling)
- [6. macOS Native Push Notifications](#6-macos-native-push-notifications)
- [7. Notification Routing Pipelines](#7-notification-routing-pipelines)
- [8. Routing Pipeline UI](#8-routing-pipeline-ui)
- [9. Implementation Phases](#9-implementation-phases)
- [10. Acceptance Criteria](#10-acceptance-criteria)

---

## 1. Data Model & Schema

**Priority:** High
**Complexity:** Large
**Files:** `src-tauri/migrations/014_notification_accounts.sql`, `src-tauri/src/models.rs`, `src/lib/types.ts`

### 1.1 New Tables

#### `notification_accounts`

Stores connected external accounts (Discord, Slack, or future providers). Each row represents one authenticated account.

```sql
CREATE TABLE notification_accounts (
    id TEXT PRIMARY KEY,                          -- UUID
    provider TEXT NOT NULL,                        -- "discord" | "slack"
    account_label TEXT NOT NULL,                   -- User-chosen display name ("Work Slack", "Personal Discord")
    provider_user_id TEXT,                         -- Provider's user ID (Discord snowflake, Slack member ID)
    provider_username TEXT,                        -- Display name from provider ("john#1234", "john.doe")
    provider_avatar_url TEXT,                      -- Avatar URL for display
    provider_team_id TEXT,                         -- Slack workspace ID or Discord guild ID (nullable)
    provider_team_name TEXT,                       -- "Acme Corp" workspace/server name

    -- OAuth tokens
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expires_at TEXT,                         -- ISO 8601 timestamp
    scopes TEXT,                                   -- Space-separated granted scopes

    -- Sync settings
    is_enabled INTEGER NOT NULL DEFAULT 1,         -- Global on/off for this account
    sync_channels TEXT,                            -- JSON array of channel IDs to monitor (null = all)
    last_sync_at TEXT,                             -- Last successful poll/websocket event timestamp
    sync_cursor TEXT,                              -- Provider-specific pagination cursor for incremental sync

    -- Metadata
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_notification_accounts_provider ON notification_accounts(provider);
```

#### `notification_account_screen_toggles`

Per-account, per-screen visibility toggles. Controls whether notifications from a given account appear on each Dispatch screen.

```sql
CREATE TABLE notification_account_screen_toggles (
    account_id TEXT NOT NULL REFERENCES notification_accounts(id) ON DELETE CASCADE,
    screen_key TEXT NOT NULL,                      -- "feed/notifications" | "feed/sessions" | "telemetry" | "expander" | "settings"
    is_enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, screen_key)
);
```

#### `notification_routing_rules`

Defines routing pipelines. Each rule says: "when a notification matches `source_filter`, send it to `destination_type`/`destination_config`."

```sql
CREATE TABLE notification_routing_rules (
    id TEXT PRIMARY KEY,                            -- UUID
    name TEXT NOT NULL,                             -- User-facing label ("Slack → Discord #alerts")
    is_enabled INTEGER NOT NULL DEFAULT 1,

    -- Source filter
    source_type TEXT NOT NULL,                      -- "account" | "provider" | "any" | "event_type" | "project"
    source_value TEXT,                              -- Account ID, provider name, event_type, project name (null for "any")

    -- Destination
    destination_type TEXT NOT NULL,                 -- "account" | "webhook" | "macos_push" | "routing_rule"
    destination_config TEXT NOT NULL,               -- JSON: webhook URL, account ID, push settings, or chained rule ID

    -- Transform (optional)
    template TEXT,                                  -- Notification body template with {{title}}, {{body}}, {{source}} vars

    -- Filtering
    filter_event_types TEXT,                        -- JSON array of event_types to match (null = all)
    filter_keywords TEXT,                           -- JSON array of keywords — match if any keyword appears in title/body (null = all)

    -- Ordering and chaining
    priority INTEGER NOT NULL DEFAULT 0,            -- Higher = evaluated first
    stop_on_match INTEGER NOT NULL DEFAULT 0,       -- If 1, stop evaluating further rules after this one fires
    chain_rule_id TEXT REFERENCES notification_routing_rules(id) ON DELETE SET NULL,  -- Next rule in chain (for A → B → C)

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_routing_rules_source ON notification_routing_rules(source_type, source_value);
CREATE INDEX idx_routing_rules_enabled ON notification_routing_rules(is_enabled);
```

#### `notification_routing_log`

Audit log for routed notifications — useful for debugging pipelines.

```sql
CREATE TABLE notification_routing_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL REFERENCES notification_routing_rules(id) ON DELETE CASCADE,
    notification_id TEXT NOT NULL,                   -- Source notification UUID
    destination_type TEXT NOT NULL,
    status TEXT NOT NULL,                            -- "success" | "failed" | "skipped"
    error_message TEXT,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_routing_log_rule ON notification_routing_log(rule_id);
CREATE INDEX idx_routing_log_notification ON notification_routing_log(notification_id);
```

### 1.2 Extend Existing `notifications` Table

Add columns to track the originating external account:

```sql
ALTER TABLE notifications ADD COLUMN account_id TEXT REFERENCES notification_accounts(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD COLUMN provider TEXT;              -- "discord" | "slack" | "yapture" | "terminal" | null (legacy)
ALTER TABLE notifications ADD COLUMN provider_message_id TEXT;   -- Discord message ID / Slack ts for dedup and linking
ALTER TABLE notifications ADD COLUMN provider_channel_name TEXT;  -- "#general", "DMs with Alice" — for display
ALTER TABLE notifications ADD COLUMN provider_channel_id TEXT;    -- Channel ID for deep-linking back to provider
ALTER TABLE notifications ADD COLUMN provider_avatar_url TEXT;    -- Author's avatar for per-message display
ALTER TABLE notifications ADD COLUMN provider_author TEXT;        -- "Alice", "deploy-bot" — the message author

CREATE INDEX idx_notifications_account ON notifications(account_id);
CREATE INDEX idx_notifications_provider ON notifications(provider);
```

### 1.3 Rust Models

**New File:** `src-tauri/src/notification_account.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct NotificationAccount {
    pub id: String,
    pub provider: String,                    // "discord" | "slack"
    pub account_label: String,
    pub provider_user_id: Option<String>,
    pub provider_username: Option<String>,
    pub provider_avatar_url: Option<String>,
    pub provider_team_id: Option<String>,
    pub provider_team_name: Option<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_expires_at: Option<String>,
    pub scopes: Option<String>,
    pub is_enabled: i32,
    pub sync_channels: Option<String>,       // JSON array
    pub last_sync_at: Option<String>,
    pub sync_cursor: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountScreenToggle {
    pub account_id: String,
    pub screen_key: String,
    pub is_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct RoutingRule {
    pub id: String,
    pub name: String,
    pub is_enabled: i32,
    pub source_type: String,
    pub source_value: Option<String>,
    pub destination_type: String,
    pub destination_config: String,          // JSON
    pub template: Option<String>,
    pub filter_event_types: Option<String>,  // JSON array
    pub filter_keywords: Option<String>,     // JSON array
    pub priority: i32,
    pub stop_on_match: i32,
    pub chain_rule_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingDestinationConfig {
    // For "webhook"
    pub url: Option<String>,
    pub method: Option<String>,              // "POST" (default)
    pub headers: Option<HashMap<String, String>>,

    // For "account" — send to a connected account's channel
    pub account_id: Option<String>,
    pub channel_id: Option<String>,

    // For "macos_push"
    pub sound: Option<String>,               // "default", "none", or system sound name
    pub subtitle: Option<String>,            // Extra context line

    // For "routing_rule" — chaining
    pub rule_id: Option<String>,
}
```

### 1.4 TypeScript Types

**Update File:** `src/lib/types.ts`

```typescript
// --- Notification Account Types ---

export type NotificationProvider = "discord" | "slack" | "yapture" | "terminal";

export interface NotificationAccount {
  id: string;
  provider: NotificationProvider;
  account_label: string;
  provider_user_id: string | null;
  provider_username: string | null;
  provider_avatar_url: string | null;
  provider_team_id: string | null;
  provider_team_name: string | null;
  is_enabled: boolean;
  sync_channels: string[] | null;       // Parsed from JSON
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountScreenToggles {
  account_id: string;
  screens: Record<BannerScreenKey, boolean>;
}

// --- Routing Rule Types ---

export type RoutingSourceType = "account" | "provider" | "any" | "event_type" | "project";
export type RoutingDestinationType = "account" | "webhook" | "macos_push" | "routing_rule";

export interface RoutingRule {
  id: string;
  name: string;
  is_enabled: boolean;
  source_type: RoutingSourceType;
  source_value: string | null;
  destination_type: RoutingDestinationType;
  destination_config: RoutingDestinationConfig;
  template: string | null;
  filter_event_types: string[] | null;
  filter_keywords: string[] | null;
  priority: number;
  stop_on_match: boolean;
  chain_rule_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoutingDestinationConfig {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  account_id?: string;
  channel_id?: string;
  sound?: string;
  subtitle?: string;
  rule_id?: string;
}

export interface RoutingLogEntry {
  id: number;
  rule_id: string;
  notification_id: string;
  destination_type: RoutingDestinationType;
  status: "success" | "failed" | "skipped";
  error_message: string | null;
  executed_at: string;
}

// --- Extended Notification (with provider fields) ---

export interface Notification {
  id: string;
  source: string;
  event_type: string;
  title: string;
  body: string | null;
  metadata: string | null;
  project: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  is_read: number;
  created_at: string;
  read_at: string | null;
  yapture_task_id: string | null;
  // New provider fields
  account_id: string | null;
  provider: NotificationProvider | null;
  provider_message_id: string | null;
  provider_channel_name: string | null;
  provider_channel_id: string | null;
  provider_avatar_url: string | null;
  provider_author: string | null;
}
```

---

## 2. Discord Integration

**Priority:** High
**Complexity:** Large
**Files:** `src-tauri/src/discord.rs` (new), `src-tauri/src/commands.rs`, `src/components/DiscordAccountSettings.tsx` (new)

### 2.1 Discord App Setup (Prerequisite)

A Discord Application must be registered at https://discord.com/developers/applications:

| Field | Value |
|-------|-------|
| Application Name | Dispatch Desktop |
| OAuth2 Redirect URI | `dispatch://oauth/discord/callback` |
| Bot | Not required (user token only) |
| OAuth2 Scopes | `identify`, `guilds`, `messages.read` |
| Privileged Intents | `MESSAGE_CONTENT` (if reading message bodies via Gateway) |

**Client ID and redirect URI** will be compiled into the binary as constants (no client secret for public PKCE clients).

> **Note on Gateway vs. REST polling:** Discord's Gateway (WebSocket) provides real-time message events but requires the `MESSAGE_CONTENT` privileged intent and is connection-heavy. REST polling via `/channels/{id}/messages` is simpler but introduces latency. This spec uses **Gateway for connected accounts** with a **REST fallback** for initial history sync.

### 2.2 OAuth Flow

Discord uses standard OAuth 2.0 with PKCE.

```
1. User clicks "Add Discord Account" in Settings > Integrations
2. Frontend calls `discord_start_oauth` Tauri command
3. Backend generates state + code_verifier + code_challenge (S256)
4. Backend stores {state, code_verifier} in memory (oauth_pending map)
5. Backend returns authorization URL:
   https://discord.com/oauth2/authorize
     ?client_id=DISPATCH_DISCORD_CLIENT_ID
     &response_type=code
     &redirect_uri=dispatch://oauth/discord/callback
     &scope=identify+guilds+messages.read
     &state={state}
     &code_challenge={code_challenge}
     &code_challenge_method=S256
6. Frontend opens URL in system browser via tauri-plugin-opener
7. User authorizes on Discord
8. Discord redirects to dispatch://oauth/discord/callback?code=...&state=...
9. Deep link handler catches callback
10. Backend exchanges code + code_verifier for tokens:
    POST https://discord.com/api/v10/oauth2/token
    Content-Type: application/x-www-form-urlencoded
    Body: grant_type=authorization_code&code={code}&redirect_uri={redirect_uri}
          &client_id={client_id}&code_verifier={code_verifier}
11. Backend fetches user info:
    GET https://discord.com/api/v10/users/@me
    Authorization: Bearer {access_token}
12. Backend fetches guilds:
    GET https://discord.com/api/v10/users/@me/guilds
    Authorization: Bearer {access_token}
13. Backend creates NotificationAccount row with:
    - provider: "discord"
    - provider_user_id: user.id
    - provider_username: user.username + "#" + user.discriminator
    - provider_avatar_url: https://cdn.discordapp.com/avatars/{id}/{avatar}.png
    - provider_team_name: (selected guild name, or "Personal" for DMs)
14. Backend initializes default screen toggles (all enabled)
15. Frontend receives `discord-account-connected` event
16. Settings UI refreshes to show the new account
```

### 2.3 Token Refresh

Discord access tokens expire after ~7 days. Refresh flow:

```
POST https://discord.com/api/v10/oauth2/token
Content-Type: application/x-www-form-urlencoded
Body: grant_type=refresh_token&refresh_token={refresh_token}&client_id={client_id}
```

- Proactively refresh when `token_expires_at` is within 1 hour
- On 401 response from any API call, attempt refresh before failing

### 2.4 Message Polling

**New File:** `src-tauri/src/discord.rs`

Two sync modes:

#### Real-time: Discord Gateway (WebSocket)

```rust
/// Connects to Discord Gateway for real-time events.
/// Used when the account is enabled and the app is running.
pub async fn connect_gateway(account: &NotificationAccount) -> Result<()> {
    // 1. GET https://discord.com/api/v10/gateway → { url: "wss://gateway.discord.gg" }
    // 2. Connect WebSocket, send Identify payload with token
    // 3. Handle READY event → cache guild/channel list
    // 4. Listen for MESSAGE_CREATE events
    // 5. For each message in monitored channels:
    //    a. Create Notification with provider fields populated
    //    b. Insert into DB
    //    c. Emit "notification-created" event to frontend
    //    d. Run routing pipeline (§7)
    // 6. Handle heartbeat, reconnect on disconnect
}
```

#### Batch: REST History Sync

Used on first connect and to backfill missed messages:

```rust
/// Fetches recent messages from specified channels via REST.
pub async fn sync_channel_history(
    account: &NotificationAccount,
    channel_id: &str,
    after: Option<&str>,  // Message ID cursor
    limit: u32,           // Max 100 per Discord API
) -> Result<Vec<Notification>> {
    // GET https://discord.com/api/v10/channels/{channel_id}/messages
    //   ?after={after}&limit={limit}
    // Authorization: Bearer {access_token}
}
```

### 2.5 Channel Selection

After connecting an account, the user selects which channels/servers to monitor:

```rust
/// Returns the user's accessible guilds and channels.
pub async fn fetch_guild_channels(
    account: &NotificationAccount,
) -> Result<Vec<GuildWithChannels>> {
    // 1. GET /users/@me/guilds → list of guilds
    // 2. For each guild: GET /guilds/{id}/channels → text channels only
    // 3. Return structured list for the UI channel picker
}
```

The selected channel IDs are stored in `notification_accounts.sync_channels` as a JSON array.

### 2.6 Notification Mapping

| Discord Field | Notification Column |
|--------------|-------------------|
| `message.id` | `provider_message_id` |
| `message.content` | `body` |
| `message.author.username` | `provider_author`, part of `title` |
| `message.author.avatar` | `provider_avatar_url` |
| `channel.name` | `provider_channel_name` |
| `channel.id` | `provider_channel_id` |
| `guild.name` | maps to `source` as `"discord:{guild_name}"` |
| — | `event_type` = `"notification"` (or `"error"` if bot error channel) |
| — | `provider` = `"discord"` |
| — | `account_id` = account's UUID |

### 2.7 Tauri Commands

```rust
#[tauri::command] async fn discord_start_oauth(state: ...) -> Result<String, String>;
#[tauri::command] async fn discord_exchange_code(state: ..., code: String, verifier: String) -> Result<NotificationAccount, String>;
#[tauri::command] async fn discord_list_accounts(state: ...) -> Result<Vec<NotificationAccount>, String>;
#[tauri::command] async fn discord_remove_account(state: ..., account_id: String) -> Result<(), String>;
#[tauri::command] async fn discord_update_account(state: ..., account_id: String, updates: AccountUpdate) -> Result<(), String>;
#[tauri::command] async fn discord_fetch_channels(state: ..., account_id: String) -> Result<Vec<GuildWithChannels>, String>;
#[tauri::command] async fn discord_set_monitored_channels(state: ..., account_id: String, channel_ids: Vec<String>) -> Result<(), String>;
#[tauri::command] async fn discord_test_connection(state: ..., account_id: String) -> Result<ConnectionStatus, String>;
#[tauri::command] async fn discord_sync_history(state: ..., account_id: String) -> Result<SyncResult, String>;
```

---

## 3. Slack Integration

**Priority:** High
**Complexity:** Large
**Files:** `src-tauri/src/slack.rs` (new), `src-tauri/src/commands.rs`, `src/components/SlackAccountSettings.tsx` (new)

### 3.1 Slack App Setup (Prerequisite)

A Slack App must be created at https://api.slack.com/apps:

| Field | Value |
|-------|-------|
| App Name | Dispatch Desktop |
| OAuth Redirect URL | `dispatch://oauth/slack/callback` |
| Bot Token Scopes | Not required (user token) |
| User Token Scopes | `channels:history`, `channels:read`, `groups:read`, `groups:history`, `im:history`, `im:read`, `mpim:history`, `mpim:read`, `users:read`, `users.profile:read`, `team:read` |
| Socket Mode | Enabled (for real-time events without a public server) |

> **Why Socket Mode:** Slack's Events API requires a publicly accessible HTTP endpoint. Socket Mode uses WebSocket connections initiated from the client side, which is ideal for a desktop app that can't expose a server. The app receives events in real-time without needing ngrok or a relay server.

### 3.2 OAuth Flow

Slack uses OAuth 2.0 V2 (not PKCE — Slack requires client_secret for the token exchange).

**Important:** Because Slack requires a `client_secret` for token exchange, and we can't embed secrets in a desktop binary, we need a lightweight token exchange relay:

#### Option A: Dispatch Token Relay (Recommended)

Host a minimal serverless function (Cloudflare Worker / Vercel Edge) that performs the token exchange:

```
Client → Relay: POST /slack/token { code, redirect_uri }
Relay → Slack: POST /api/oauth.v2.access { code, client_id, client_secret, redirect_uri }
Relay → Client: { access_token, refresh_token, ... }
```

The relay only holds the client_secret. No user data is stored.

#### Option B: Proxy Through Yapture

If Yapture's API already runs a server, add a `/dispatch/slack/token-exchange` endpoint there to proxy the token exchange. This avoids deploying a new service.

#### OAuth Flow Sequence

```
1. User clicks "Add Slack Account" in Settings > Integrations
2. Frontend calls `slack_start_oauth` Tauri command
3. Backend generates state nonce, stores in oauth_pending
4. Backend returns authorization URL:
   https://slack.com/oauth/v2/authorize
     ?client_id=DISPATCH_SLACK_CLIENT_ID
     &user_scope=channels:history,channels:read,groups:read,groups:history,...
     &redirect_uri=dispatch://oauth/slack/callback
     &state={state}
5. Frontend opens URL in system browser
6. User authorizes in Slack
7. Slack redirects to dispatch://oauth/slack/callback?code=...&state=...
8. Deep link handler catches callback
9. Backend sends code to token relay:
   POST https://relay.dispatch.app/slack/token
   Body: { code, redirect_uri: "dispatch://oauth/slack/callback" }
10. Relay exchanges with Slack, returns tokens
11. Backend fetches user identity:
    GET https://slack.com/api/auth.test
    Authorization: Bearer {access_token}
12. Backend fetches team info:
    GET https://slack.com/api/team.info
    Authorization: Bearer {access_token}
13. Backend creates NotificationAccount row:
    - provider: "slack"
    - provider_user_id: auth.test.user_id
    - provider_username: auth.test.user
    - provider_team_id: auth.test.team_id
    - provider_team_name: team.info.team.name
    - provider_avatar_url: (from users.profile.get)
14. Backend initializes default screen toggles (all enabled)
15. Frontend receives `slack-account-connected` event
```

### 3.3 Token Refresh

Slack token rotation (if enabled on the app):

```
POST https://slack.com/api/oauth.v2.access (via relay)
Body: grant_type=refresh_token&refresh_token={token}&client_id={id}&client_secret={secret}
```

If the Slack app does not use token rotation, tokens don't expire and no refresh is needed. Dispatch should handle both cases.

### 3.4 Message Sync

#### Real-time: Socket Mode (WebSocket)

```rust
/// Connects to Slack via Socket Mode for real-time events.
pub async fn connect_socket_mode(account: &NotificationAccount, app_token: &str) -> Result<()> {
    // 1. POST https://slack.com/api/apps.connections.open
    //    Authorization: Bearer {app_level_token}
    //    → { url: "wss://wss-primary.slack.com/..." }
    // 2. Connect WebSocket
    // 3. Listen for `message` events in subscribed channels
    // 4. For each message:
    //    a. Resolve author name via users cache
    //    b. Create Notification with Slack-specific fields
    //    c. Insert into DB, emit event, run routing pipeline
    // 5. Acknowledge events within 3 seconds (Slack requirement)
}
```

#### Batch: Conversations History

```rust
/// Fetches recent messages from a Slack channel.
pub async fn sync_conversation_history(
    account: &NotificationAccount,
    channel_id: &str,
    oldest: Option<&str>,  // Unix timestamp
    limit: u32,            // Max 200 per Slack API
) -> Result<Vec<Notification>> {
    // GET https://slack.com/api/conversations.history
    //   ?channel={channel_id}&oldest={oldest}&limit={limit}
    // Authorization: Bearer {user_access_token}
}
```

### 3.5 Channel Selection

```rust
/// Returns the user's Slack channels (public, private, DMs, group DMs).
pub async fn fetch_conversations(
    account: &NotificationAccount,
) -> Result<Vec<SlackConversation>> {
    // GET https://slack.com/api/conversations.list
    //   ?types=public_channel,private_channel,im,mpim
    //   &exclude_archived=true
    // Authorization: Bearer {user_access_token}
}
```

### 3.6 Notification Mapping

| Slack Field | Notification Column |
|------------|-------------------|
| `message.ts` | `provider_message_id` |
| `message.text` (rendered) | `body` |
| `message.user` → resolved name | `provider_author`, part of `title` |
| user profile image | `provider_avatar_url` |
| `conversation.name` | `provider_channel_name` |
| `conversation.id` | `provider_channel_id` |
| `team.name` | maps to `source` as `"slack:{team_name}"` |
| — | `event_type` = `"notification"` |
| — | `provider` = `"slack"` |
| — | `account_id` = account's UUID |

**Slack-specific rendering:** Slack messages use mrkdwn syntax (`*bold*`, `<@U1234>` user mentions, `<#C1234>` channel links). The body should be converted to plain text for the notification card, with rich rendering optional in the expanded view.

### 3.7 Tauri Commands

```rust
#[tauri::command] async fn slack_start_oauth(state: ...) -> Result<String, String>;
#[tauri::command] async fn slack_exchange_code(state: ..., code: String) -> Result<NotificationAccount, String>;
#[tauri::command] async fn slack_list_accounts(state: ...) -> Result<Vec<NotificationAccount>, String>;
#[tauri::command] async fn slack_remove_account(state: ..., account_id: String) -> Result<(), String>;
#[tauri::command] async fn slack_update_account(state: ..., account_id: String, updates: AccountUpdate) -> Result<(), String>;
#[tauri::command] async fn slack_fetch_conversations(state: ..., account_id: String) -> Result<Vec<SlackConversation>, String>;
#[tauri::command] async fn slack_set_monitored_channels(state: ..., account_id: String, channel_ids: Vec<String>) -> Result<(), String>;
#[tauri::command] async fn slack_test_connection(state: ..., account_id: String) -> Result<ConnectionStatus, String>;
#[tauri::command] async fn slack_sync_history(state: ..., account_id: String) -> Result<SyncResult, String>;
```

---

## 4. Multi-Account Settings UI

**Priority:** High
**Complexity:** Medium
**Files:** `src/components/YaptureSettings.tsx`, `src/components/IntegrationSettings.tsx` (new), `src/components/AccountCard.tsx` (new)

### 4.1 Settings Tab Restructure

Add an **Integrations** tab to the existing Settings screen (alongside Yapture, Hotkeys, Notifications, Sources):

```
Settings Tabs:
  [Yapture] [Integrations] [Hotkeys] [Notifications] [Sources]
```

The **Integrations** tab contains:

```
┌─────────────────────────────────────────────────────────────┐
│  Integrations                                                │
│                                                              │
│  Discord                                          [+ Add]   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  🟢 Personal Discord  (alechp#0001)        [···]     │   │
│  │     Server: Dispatch Dev · 3 channels monitored       │   │
│  │     Last sync: 2 minutes ago                          │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │  🟢 Work Discord  (alechp-work#5678)       [···]     │   │
│  │     Server: Acme Corp · 5 channels monitored          │   │
│  │     Last sync: 30 seconds ago                         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Slack                                            [+ Add]   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  🟡 Acme Workspace  (john.doe)             [···]     │   │
│  │     Workspace: Acme Corp · 12 channels monitored      │   │
│  │     Last sync: 1 minute ago                           │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │  🔴 Side Project  (john)                   [···]     │   │
│  │     Workspace: Indie Devs · Disconnected              │   │
│  │     Token expired — click to re-authenticate          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  macOS Notifications                                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  [x] Enable native push notifications                 │   │
│  │  Sound: [Default ▾]                                   │   │
│  │  Show previews: [When Unlocked ▾]                     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Account Card — Expanded View

Clicking an account card or its `[···]` menu expands an inline detail panel:

```
┌──────────────────────────────────────────────────────────────┐
│  🟢 Personal Discord  (alechp#0001)                          │
│                                                               │
│  Status: Connected                    [Test Connection]       │
│  Token expires: in 6 days             [Disconnect]            │
│                                                               │
│  Monitored Channels                   [Edit Channels]         │
│    ✓ #general        ✓ #alerts        ✓ #deployments          │
│                                                               │
│  Screen Visibility                                            │
│    [x] Notifications   [x] Projects   [x] Analytics          │
│    [x] Text Expander   [x] Settings                          │
│                                                               │
│  Account Label: [Personal Discord___________] [Save]          │
│                                                               │
│  Danger Zone                                                  │
│  [Remove Account]                                             │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 Per-Account, Per-Screen Toggles

Each account has independent toggles for each Dispatch screen. This controls whether notifications from that account:

1. Appear in the notification feed on that screen
2. Trigger the notification banner on that screen
3. Are included in telemetry/analytics for that screen

**Interaction model:**

- Toggling a screen off for an account does NOT delete existing notifications — it only hides them from the feed and suppresses new banners
- The filter is applied at query time via the `notification_account_screen_toggles` table
- The existing `FilterBar` component gains a provider/account filter dropdown

### 4.4 Channel Picker Modal

When user clicks "Edit Channels", show a modal with a searchable channel list:

```
┌─────────────────────────────────────────────────┐
│  Select Channels — Personal Discord              │
│  ┌─────────────────────────────────────────┐    │
│  │ 🔍 Search channels...                   │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  Dispatch Dev                                    │
│    [x] # general                                 │
│    [x] # alerts                                  │
│    [ ] # random                                  │
│    [x] # deployments                             │
│    [ ] # off-topic                               │
│                                                  │
│  Another Server                                  │
│    [ ] # main                                    │
│    [ ] # dev                                     │
│                                                  │
│  [Cancel]                            [Save]      │
└─────────────────────────────────────────────────┘
```

---

## 5. Notification Feed — Per-Provider Styling

**Priority:** Medium
**Complexity:** Medium
**Files:** `src/components/NotificationCard.tsx`, `src/components/NotificationFeed.tsx`, `src/hooks/useNotifications.ts`

### 5.1 Provider-Aware NotificationCard

Each notification card renders differently based on its `provider` field. The card layout is the same, but visual treatment varies:

#### Color Coding (Left Border + Accent)

| Provider | Border Color | Icon | Badge BG |
|----------|-------------|------|----------|
| `terminal` | `border-l-zinc-500` | Terminal icon (existing) | `bg-zinc-700` |
| `yapture` | `border-l-violet-500` | Yapture logo | `bg-violet-900` |
| `discord` | `border-l-indigo-500` | Discord logo (SVG) | `bg-indigo-900` |
| `slack` | `border-l-emerald-500` | Slack logo (SVG) | `bg-emerald-900` |

#### Card Layout — Discord

```
┌─ indigo border ──────────────────────────────────────────┐
│  [avatar]  Alice · #alerts · Dispatch Dev    2m ago      │
│            Build failed on main — see CI logs for...     │
│            [discord] [notification] [Dispatch Dev]       │
│                                         [Open in Discord]│
└──────────────────────────────────────────────────────────┘
```

#### Card Layout — Slack

```
┌─ emerald border ─────────────────────────────────────────┐
│  [avatar]  deploy-bot · #deployments · Acme   5m ago     │
│            Production deploy v2.4.1 completed ✓          │
│            [slack] [notification] [Acme Corp]            │
│                                            [Open in Slack]│
└──────────────────────────────────────────────────────────┘
```

### 5.2 Provider Filter in Feed

Extend the existing `FilterBar` with a provider dropdown:

```
[🔍 Search...] [All ▾] [Read/Unread/All]  [Provider: All ▾]
                                            ├─ All
                                            ├─ Terminal
                                            ├─ Yapture
                                            ├─ Discord (2 accounts)
                                            │   ├─ Personal Discord
                                            │   └─ Work Discord
                                            ├─ Slack (2 accounts)
                                            │   ├─ Acme Workspace
                                            │   └─ Side Project
                                            └─ ──────────
                                               Manage Integrations →
```

### 5.3 Query Changes

Update `useNotifications.ts` to support provider/account filtering:

```typescript
export interface QueryFilters {
  source?: string;
  project?: string;
  is_read?: number;
  search?: string;
  limit?: number;
  offset?: number;
  // New
  provider?: NotificationProvider;
  account_id?: string;
  exclude_accounts?: string[];  // Derived from screen toggles
}
```

The backend query in `db.rs` adds:

```sql
-- Filter by provider
AND (:provider IS NULL OR provider = :provider)
-- Filter by specific account
AND (:account_id IS NULL OR account_id = :account_id)
-- Exclude disabled accounts for current screen
AND (account_id IS NULL OR account_id NOT IN (
    SELECT account_id FROM notification_account_screen_toggles
    WHERE screen_key = :current_screen AND is_enabled = 0
))
```

### 5.4 "Open in Provider" Action

Each provider-sourced notification card gains a contextual action button:

| Provider | Button Label | Action |
|----------|-------------|--------|
| Discord | "Open in Discord" | `tauri::plugin::opener::open_url("discord://discord.com/channels/{guild_id}/{channel_id}/{message_id}")` |
| Slack | "Open in Slack" | `tauri::plugin::opener::open_url("slack://channel?team={team_id}&id={channel_id}")` |
| Terminal | "Focus Terminal" | Existing tmux focus flow |
| Yapture | "View in Yapture" | Opens Yapture web UI |

---

## 6. macOS Native Push Notifications

**Priority:** Medium
**Complexity:** Medium
**Files:** `src-tauri/src/macos_notifications.rs` (new), `src-tauri/src/lib.rs`, `src/components/IntegrationSettings.tsx`

### 6.1 Architecture

Use the `tauri-plugin-notification` (Tauri 2) or native `NSUserNotificationCenter` via the existing Objective-C bridge to deliver macOS system notifications.

**New File:** `src-tauri/src/macos_notifications.rs`

```rust
use tauri::plugin::notification::NotificationExt;

pub struct MacOSNotificationConfig {
    pub enabled: bool,
    pub sound: String,            // "default" | "none" | system sound name
    pub show_body_preview: bool,  // Show notification body or just title
    pub group_by_provider: bool,  // Group notifications by provider in Notification Center
}

/// Send a macOS native push notification.
pub fn send_push(
    app: &tauri::AppHandle,
    title: &str,
    body: Option<&str>,
    subtitle: Option<&str>,     // Provider/channel context
    sound: &str,
    group_id: Option<&str>,     // For grouping: "dispatch.discord.{account_id}"
    action_url: Option<&str>,   // Deep link for click action
) -> Result<()> {
    let mut notification = app.notification()
        .builder()
        .title(title)
        .group(group_id.unwrap_or("dispatch"));

    if let Some(b) = body {
        notification = notification.body(b);
    }
    if let Some(s) = subtitle {
        notification = notification.subtitle(s);
    }
    if sound != "none" {
        notification = notification.sound(sound);
    }
    if let Some(url) = action_url {
        notification = notification.action_type_id("open")
            .extra(vec![("url".into(), url.into())]);
    }

    notification.show()?;
    Ok(())
}
```

### 6.2 Push Triggers

macOS push notifications fire when ALL of these are true:

1. `macos_push_enabled` setting is `true`
2. The notification's provider/account is not disabled
3. The notification matches at least one routing rule with `destination_type = "macos_push"`, **OR** global push is enabled and no routing rules suppress it
4. The Dispatch window is **not** focused (don't push when user is already looking at Dispatch)

### 6.3 Notification Grouping

Group by provider and account to keep Notification Center organized:

| Group ID | Thread ID | Example |
|----------|----------|---------|
| `dispatch.discord.{account_id}` | `{channel_id}` | Groups all Discord messages from one account, threads by channel |
| `dispatch.slack.{account_id}` | `{channel_id}` | Same for Slack |
| `dispatch.terminal` | `{project}` | Terminal notifications grouped by project |
| `dispatch.yapture` | — | Yapture notifications in one group |

### 6.4 Click-to-Open

When user clicks a macOS notification:

1. Dispatch window focuses (`app.get_window("main").set_focus()`)
2. Navigate to the notification feed
3. Scroll to and select the clicked notification
4. If the notification has a deep link (`action_url`), optionally open in the provider app

### 6.5 Settings

Stored in DB `settings` table as `macos_push_config` (JSON):

```typescript
interface MacOSPushConfig {
  enabled: boolean;
  sound: "default" | "none" | string;
  showBodyPreview: boolean;
  groupByProvider: boolean;
  suppressWhenFocused: boolean;  // Don't push when Dispatch is in foreground
  quietHours: {
    enabled: boolean;
    start: string;  // "22:00"
    end: string;    // "08:00"
  };
}
```

### 6.6 Tauri Commands

```rust
#[tauri::command] async fn get_macos_push_config(state: ...) -> Result<MacOSPushConfig, String>;
#[tauri::command] async fn set_macos_push_config(state: ..., config: MacOSPushConfig) -> Result<(), String>;
#[tauri::command] async fn send_test_push(state: ...) -> Result<(), String>;
```

---

## 7. Notification Routing Pipelines

**Priority:** High
**Complexity:** Large
**Files:** `src-tauri/src/routing.rs` (new), `src-tauri/src/commands.rs`, `src-tauri/src/webhook.rs` (new)

### 7.1 Routing Engine

The routing engine evaluates rules whenever a new notification is created (from any source). It runs asynchronously to avoid blocking the notification insert.

**New File:** `src-tauri/src/routing.rs`

```rust
/// Evaluate all enabled routing rules against a notification.
/// Rules are evaluated in priority order (highest first).
/// If a rule has stop_on_match=true, no further rules are evaluated after it fires.
pub async fn evaluate_routing(
    db: &SqlitePool,
    http_client: &reqwest::Client,
    app: &tauri::AppHandle,
    notification: &Notification,
) -> Vec<RoutingLogEntry> {
    let rules = db::get_enabled_routing_rules(db).await;
    let mut results = Vec::new();
    let mut visited_rules: HashSet<String> = HashSet::new();  // Cycle detection

    for rule in rules.iter().sorted_by(|a, b| b.priority.cmp(&a.priority)) {
        if !matches_source_filter(rule, notification) {
            continue;
        }
        if !matches_event_filter(rule, notification) {
            continue;
        }
        if !matches_keyword_filter(rule, notification) {
            continue;
        }

        let result = execute_destination(db, http_client, app, rule, notification, &mut visited_rules).await;
        results.push(RoutingLogEntry {
            rule_id: rule.id.clone(),
            notification_id: notification.id.clone(),
            destination_type: rule.destination_type.clone(),
            status: if result.is_ok() { "success" } else { "failed" },
            error_message: result.err().map(|e| e.to_string()),
        });

        if rule.stop_on_match == 1 {
            break;
        }
    }

    // Persist log entries
    db::insert_routing_log_batch(db, &results).await;
    results
}
```

### 7.2 Source Matching

```rust
fn matches_source_filter(rule: &RoutingRule, notification: &Notification) -> bool {
    match rule.source_type.as_str() {
        "any" => true,
        "provider" => notification.provider.as_deref() == rule.source_value.as_deref(),
        "account" => notification.account_id.as_deref() == rule.source_value.as_deref(),
        "event_type" => notification.event_type == rule.source_value.as_deref().unwrap_or(""),
        "project" => notification.project.as_deref() == rule.source_value.as_deref(),
        _ => false,
    }
}
```

### 7.3 Destination Execution

```rust
async fn execute_destination(
    db: &SqlitePool,
    http: &reqwest::Client,
    app: &tauri::AppHandle,
    rule: &RoutingRule,
    notification: &Notification,
    visited: &mut HashSet<String>,
) -> Result<()> {
    let config: RoutingDestinationConfig = serde_json::from_str(&rule.destination_config)?;

    match rule.destination_type.as_str() {
        "webhook" => {
            let body = render_template(rule.template.as_deref(), notification);
            let url = config.url.ok_or("Missing webhook URL")?;
            let method = config.method.as_deref().unwrap_or("POST");

            let mut req = match method {
                "POST" => http.post(&url),
                "PUT" => http.put(&url),
                _ => http.post(&url),
            };

            // Apply custom headers
            if let Some(headers) = &config.headers {
                for (k, v) in headers {
                    req = req.header(k, v);
                }
            }

            // Send as JSON
            req.json(&serde_json::json!({
                "content": body,  // Discord webhook format
                "text": body,     // Slack webhook format
                "notification": {
                    "id": notification.id,
                    "title": notification.title,
                    "body": notification.body,
                    "source": notification.source,
                    "event_type": notification.event_type,
                    "provider": notification.provider,
                    "created_at": notification.created_at,
                }
            }))
            .send().await?
            .error_for_status()?;

            Ok(())
        }

        "account" => {
            // Send to a connected account's channel
            let account_id = config.account_id.ok_or("Missing account_id")?;
            let channel_id = config.channel_id.ok_or("Missing channel_id")?;
            let account = db::get_notification_account(db, &account_id).await?;
            let body = render_template(rule.template.as_deref(), notification);

            match account.provider.as_str() {
                "discord" => discord::send_message(&account, &channel_id, &body).await,
                "slack" => slack::send_message(&account, &channel_id, &body).await,
                _ => Err("Unsupported provider for send".into()),
            }
        }

        "macos_push" => {
            let sound = config.sound.as_deref().unwrap_or("default");
            let subtitle = config.subtitle.as_deref()
                .unwrap_or_else(|| notification.source.as_str());
            macos_notifications::send_push(
                app,
                &notification.title,
                notification.body.as_deref(),
                Some(subtitle),
                sound,
                notification.provider.as_deref()
                    .map(|p| format!("dispatch.{}", p))
                    .as_deref(),
                None,
            )
        }

        "routing_rule" => {
            // Chain to another rule — with cycle detection
            let next_rule_id = config.rule_id.ok_or("Missing chained rule_id")?;
            if visited.contains(&next_rule_id) {
                return Err("Cycle detected in routing chain".into());
            }
            visited.insert(next_rule_id.clone());
            let next_rule = db::get_routing_rule(db, &next_rule_id).await?;
            execute_destination(db, http, app, &next_rule, notification, visited).await
        }

        _ => Err(format!("Unknown destination type: {}", rule.destination_type).into()),
    }
}
```

### 7.4 Template Rendering

Rules can optionally define a template that transforms the notification body before sending:

```rust
fn render_template(template: Option<&str>, notification: &Notification) -> String {
    match template {
        None => format!("[{}] {}: {}",
            notification.source,
            notification.title,
            notification.body.as_deref().unwrap_or("")
        ),
        Some(tpl) => tpl
            .replace("{{title}}", &notification.title)
            .replace("{{body}}", notification.body.as_deref().unwrap_or(""))
            .replace("{{source}}", &notification.source)
            .replace("{{event_type}}", &notification.event_type)
            .replace("{{provider}}", notification.provider.as_deref().unwrap_or("unknown"))
            .replace("{{project}}", notification.project.as_deref().unwrap_or(""))
            .replace("{{author}}", notification.provider_author.as_deref().unwrap_or(""))
            .replace("{{channel}}", notification.provider_channel_name.as_deref().unwrap_or(""))
            .replace("{{timestamp}}", &notification.created_at),
    }
}
```

### 7.5 Webhook Destinations

**New File:** `src-tauri/src/webhook.rs`

Common webhook formats with presets:

| Preset | Format | Example |
|--------|--------|---------|
| Discord Webhook | `{ "content": "...", "username": "Dispatch" }` | `https://discord.com/api/webhooks/{id}/{token}` |
| Slack Webhook | `{ "text": "...", "channel": "#channel" }` | `https://hooks.slack.com/services/T.../B.../xxx` |
| Generic JSON | `{ "notification": { ... } }` | Any HTTP endpoint |
| Ntfy | `POST body as plain text, title in header` | `https://ntfy.sh/dispatch-alerts` |

The UI lets users select a preset or configure a custom webhook with arbitrary URL, method, and headers.

### 7.6 Chaining (A → B → C)

Routing rules can chain via `chain_rule_id`. When rule A fires, it executes its destination, then also triggers rule B (identified by `chain_rule_id`). Rule B can chain to C, and so on.

**Safeguards:**
- **Cycle detection:** The `visited` set in `execute_destination` prevents infinite loops (A → B → A)
- **Max chain depth:** Hard limit of 10 hops to prevent runaway chains
- **Chain validation on save:** When creating/editing a rule with `chain_rule_id`, validate that it doesn't create a cycle

Example chain:

```
Rule: "Slack errors to Discord + Push"
  Source: provider = "slack", filter_event_types = ["error"]
  Destination: webhook (Discord webhook URL)
  Chain → Rule: "Also push to macOS"
    Source: any (ignored for chained rules — inherits parent match)
    Destination: macos_push
    Chain → null (end of chain)
```

### 7.7 Tauri Commands

```rust
#[tauri::command] async fn list_routing_rules(state: ...) -> Result<Vec<RoutingRule>, String>;
#[tauri::command] async fn get_routing_rule(state: ..., rule_id: String) -> Result<RoutingRule, String>;
#[tauri::command] async fn create_routing_rule(state: ..., rule: CreateRoutingRule) -> Result<RoutingRule, String>;
#[tauri::command] async fn update_routing_rule(state: ..., rule_id: String, updates: UpdateRoutingRule) -> Result<RoutingRule, String>;
#[tauri::command] async fn delete_routing_rule(state: ..., rule_id: String) -> Result<(), String>;
#[tauri::command] async fn toggle_routing_rule(state: ..., rule_id: String, enabled: bool) -> Result<(), String>;
#[tauri::command] async fn test_routing_rule(state: ..., rule_id: String) -> Result<RoutingLogEntry, String>;
#[tauri::command] async fn get_routing_log(state: ..., rule_id: Option<String>, limit: u32) -> Result<Vec<RoutingLogEntry>, String>;
#[tauri::command] async fn validate_routing_chain(state: ..., rule_id: String, chain_rule_id: String) -> Result<bool, String>;
```

---

## 8. Routing Pipeline UI

**Priority:** High
**Complexity:** Large
**Files:** `src/components/RoutingPipelines.tsx` (new), `src/components/RoutingRuleEditor.tsx` (new), `src/components/RoutingFlowDiagram.tsx` (new)

### 8.1 Navigation

Add a new top-level screen or sub-tab accessible from the feed:

```
Feed Tabs:
  [Notifications] [Projects] [Routing]
```

Alternatively, routing can live under Settings as a dedicated sub-section, but given its complexity and the fact that users will interact with it as a standalone feature, a top-level tab is recommended.

### 8.2 Routing Dashboard

The main routing view shows all rules as a list with a visual flow indicator:

```
┌──────────────────────────────────────────────────────────────┐
│  Notification Routing                           [+ New Rule] │
│                                                               │
│  Active Rules (3)                                             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  🟢 Slack errors → Discord #alerts                     │  │
│  │  ┌──────────┐      ┌──────────┐      ┌──────────┐     │  │
│  │  │  Slack    │  →   │ Discord  │  →   │ macOS    │     │  │
│  │  │ errors   │      │ webhook  │      │  push    │     │  │
│  │  └──────────┘      └──────────┘      └──────────┘     │  │
│  │  Last fired: 3 min ago · 47 total · 2 failed           │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  🟢 All terminal → macOS push                          │  │
│  │  ┌──────────┐      ┌──────────┐                        │  │
│  │  │ Terminal  │  →   │ macOS    │                        │  │
│  │  │   all     │      │  push    │                        │  │
│  │  └──────────┘      └──────────┘                        │  │
│  │  Last fired: 1 min ago · 203 total · 0 failed          │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  🟢 Discord deploys → Slack + Webhook                  │  │
│  │  ┌──────────┐      ┌──────────┐      ┌──────────┐     │  │
│  │  │ Discord  │  →   │  Slack   │  →   │ Custom   │     │  │
│  │  │ #deploys │      │ #status  │      │ webhook  │     │  │
│  │  └──────────┘      └──────────┘      └──────────┘     │  │
│  │  Last fired: 2 hrs ago · 12 total · 0 failed           │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  Disabled Rules (1)                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ⚪ Old Yapture → email relay          [Enable] [Edit] │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  Recent Activity                               [View Log →]  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ✓ 14:23 — "Slack errors → Discord" — success          │  │
│  │  ✓ 14:22 — "All terminal → macOS push" — success       │  │
│  │  ✗ 14:20 — "Slack errors → Discord" — 403 Forbidden    │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 8.3 Rule Editor

Clicking "+ New Rule" or editing an existing rule opens the rule editor:

```
┌──────────────────────────────────────────────────────────────┐
│  Edit Routing Rule                                            │
│                                                               │
│  Name: [Slack errors → Discord #alerts______________]         │
│                                                               │
│  ── SOURCE ──────────────────────────────────────────         │
│  Match: [Provider ▾]  Value: [Slack ▾]                        │
│                                                               │
│  Filter by event type:                                        │
│    [x] error  [ ] warning  [ ] notification  [ ] stop         │
│                                                               │
│  Filter by keywords (optional):                               │
│    [deploy, build, ci______________________________]          │
│    Match if any keyword appears in title or body              │
│                                                               │
│  ── DESTINATION ─────────────────────────────────────         │
│  Type: [Webhook ▾]                                            │
│                                                               │
│  Preset: [Discord Webhook ▾]                                  │
│  URL: [https://discord.com/api/webhooks/1234/abcd__]          │
│                                                               │
│  Custom Headers (optional):                                   │
│    [+ Add Header]                                             │
│                                                               │
│  ── MESSAGE TEMPLATE ────────────────────────────────         │
│  ┌─────────────────────────────────────────────────┐         │
│  │ 🔴 **{{source}}** — {{title}}                    │         │
│  │ {{body}}                                         │         │
│  │                                                  │         │
│  │ _Channel: {{channel}} · Author: {{author}}_      │         │
│  └─────────────────────────────────────────────────┘         │
│  Variables: {{title}} {{body}} {{source}} {{event_type}}      │
│             {{provider}} {{project}} {{author}} {{channel}}   │
│             {{timestamp}}                                     │
│                                                               │
│  ── CHAINING ────────────────────────────────────────         │
│  Chain to: [Also push to macOS ▾]  (optional)                 │
│  Stop after this rule: [ ]                                    │
│  Priority: [0___]                                             │
│                                                               │
│  ── PREVIEW ─────────────────────────────────────────         │
│  ┌─────────────────────────────────────────────────┐         │
│  │  Sample output with last matching notification:   │         │
│  │  🔴 **slack:Acme Corp** — Build failed            │         │
│  │  Exit code 1 on main branch                       │         │
│  │  _Channel: #deployments · Author: deploy-bot_     │         │
│  └─────────────────────────────────────────────────┘         │
│                                                               │
│  [Cancel]     [Test Rule]     [Save]                          │
└──────────────────────────────────────────────────────────────┘
```

### 8.4 Flow Diagram Component

Each rule displays an inline flow diagram showing the pipeline visually. For chained rules, the diagram extends:

```typescript
// src/components/RoutingFlowDiagram.tsx

interface FlowNode {
  type: "source" | "destination";
  label: string;
  sublabel: string;
  icon: "slack" | "discord" | "terminal" | "yapture" | "webhook" | "macos" | "rule";
  status?: "active" | "error" | "disabled";
}

interface FlowDiagramProps {
  nodes: FlowNode[];           // [source, dest1, dest2, ...]
  lastFired?: string;          // ISO timestamp
  totalExecutions: number;
  failedExecutions: number;
}
```

The diagram renders as a horizontal chain of rounded boxes connected by arrows (`→`), using Tailwind for styling. Each node has a small icon (provider logo or generic webhook/push icon) and a label.

For complex chains, the diagram wraps and indents:

```
┌──────────┐      ┌──────────┐
│  Slack    │  →   │ Discord  │
│ errors    │      │ webhook  │
└──────────┘      └──────────┘
                       ↓
                  ┌──────────┐      ┌──────────┐
                  │ macOS    │  →   │ Custom   │
                  │  push    │      │ webhook  │
                  └──────────┘      └──────────┘
```

### 8.5 Routing Log View

Accessible from "View Log →" in the routing dashboard:

```
┌──────────────────────────────────────────────────────────────┐
│  Routing Log                        [Clear Log] [Export CSV]  │
│                                                               │
│  Filter: [All Rules ▾]  [All Statuses ▾]  [Last 24h ▾]      │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ✓  14:23:45  "Slack errors → Discord"                 │  │
│  │     Notification: "Build failed on main"               │  │
│  │     Destination: webhook → discord.com/api/webhooks/...│  │
│  │     Duration: 234ms                                     │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  ✗  14:20:12  "Slack errors → Discord"                 │  │
│  │     Notification: "CI timeout on feature/auth"         │  │
│  │     Destination: webhook → discord.com/api/webhooks/...│  │
│  │     Error: 403 Forbidden — invalid webhook token       │  │
│  │     [Retry]                                             │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  ✓  14:18:33  "All terminal → macOS push"              │  │
│  │     Notification: "tests passed (42/42)"               │  │
│  │     Destination: macos_push                             │  │
│  │     Duration: 12ms                                      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 9. Implementation Phases

### Phase A: Data Model & Account Infrastructure

**Complexity:** Medium
**Scope:** Backend-only foundation

1. Create migration `014_notification_accounts.sql` with all new tables
2. Add `notification_account.rs` with Rust models
3. Extend `Notification` model with provider fields
4. Add generic account CRUD commands (create, list, update, delete, toggle)
5. Add screen toggle CRUD commands
6. Update notification queries to support provider/account filtering
7. Update TypeScript types in `types.ts`

### Phase B: Discord OAuth & Sync

**Complexity:** Large
**Scope:** Full Discord integration

1. Register Discord Application and configure redirect URI
2. Implement `discord.rs` — OAuth flow, token refresh, user info fetch
3. Add deep link handler for `dispatch://oauth/discord/callback`
4. Implement Discord Gateway connection (WebSocket) for real-time events
5. Implement REST history sync for backfill
6. Add channel selection UI (guild/channel picker)
7. Wire up Discord account settings in the Integrations tab
8. Add Discord-styled notification cards

### Phase C: Slack OAuth & Sync

**Complexity:** Large
**Scope:** Full Slack integration

1. Register Slack App with required scopes
2. Deploy token exchange relay (Cloudflare Worker or Yapture endpoint)
3. Implement `slack.rs` — OAuth flow (via relay), user/team info fetch
4. Add deep link handler for `dispatch://oauth/slack/callback`
5. Implement Socket Mode connection for real-time events
6. Implement conversations.history sync for backfill
7. Add Slack mrkdwn → plain text converter
8. Add channel selection UI (conversation picker)
9. Wire up Slack account settings in the Integrations tab
10. Add Slack-styled notification cards

### Phase D: macOS Native Push

**Complexity:** Medium
**Scope:** System notification integration

1. Add `tauri-plugin-notification` dependency or implement via Obj-C bridge
2. Implement `macos_notifications.rs` — send_push, grouping, click handling
3. Add push config settings (sound, preview, quiet hours)
4. Wire push into notification creation pipeline
5. Handle notification click → focus Dispatch + navigate to notification
6. Add push settings UI in Integrations tab

### Phase E: Routing Engine & Pipelines

**Complexity:** Large
**Scope:** Rule evaluation, webhook delivery, chaining

1. Implement `routing.rs` — rule evaluation, source matching, destination execution
2. Implement `webhook.rs` — HTTP delivery with presets
3. Add cycle detection and chain depth limits
4. Add template rendering
5. Wire routing engine into notification creation pipeline (post-insert hook)
6. Add routing rule CRUD commands
7. Add routing log insert/query
8. Implement test-rule command (dry-run with sample notification)

### Phase F: Routing UI

**Complexity:** Large
**Scope:** Full routing dashboard and rule editor

1. Add Routing tab to Feed screen
2. Implement `RoutingPipelines.tsx` — rule list with flow diagrams
3. Implement `RoutingRuleEditor.tsx` — full rule creation/editing form
4. Implement `RoutingFlowDiagram.tsx` — visual chain rendering
5. Implement routing log viewer with filters
6. Add "Test Rule" button that sends a sample notification through the pipeline
7. Add rule import/export (JSON)

### Phase Dependencies

```
Phase A ──→ Phase B ──→ Phase C
   │                       │
   └──→ Phase D            │
   │                       │
   └──→ Phase E ──→ Phase F
```

Phases B, C, D, and E can be parallelized after Phase A is complete. Phase F depends on Phase E.

---

## 10. Acceptance Criteria

### Discord Integration
- [ ] Can add multiple Discord accounts via OAuth
- [ ] Each account shows connection status, username, and avatar
- [ ] Can select which servers/channels to monitor per account
- [ ] Discord messages appear in the notification feed with Discord styling (indigo border, avatar, channel name)
- [ ] Can remove and re-authenticate Discord accounts independently
- [ ] Token refresh works automatically before expiry
- [ ] "Open in Discord" deep-links to the correct message

### Slack Integration
- [ ] Can add multiple Slack accounts via OAuth (with token relay)
- [ ] Each account shows workspace name, username, and connection status
- [ ] Can select which channels/conversations to monitor per account
- [ ] Slack messages appear in the notification feed with Slack styling (emerald border, avatar, channel name)
- [ ] Slack mrkdwn is rendered as readable plain text
- [ ] Can remove and re-authenticate Slack accounts independently
- [ ] "Open in Slack" deep-links to the correct channel

### Multi-Account Settings
- [ ] Integrations tab shows all connected accounts grouped by provider
- [ ] Each account has independent enable/disable toggle
- [ ] Each account has per-screen visibility toggles (5 screens)
- [ ] Disabling an account's screen toggle immediately hides its notifications from that screen
- [ ] Notification feed has a provider/account filter dropdown
- [ ] Can rename account labels

### macOS Native Push
- [ ] Push notifications appear in macOS Notification Center
- [ ] Notifications are grouped by provider/account
- [ ] Clicking a push notification focuses Dispatch and navigates to the notification
- [ ] Push is suppressed when Dispatch window is focused
- [ ] Quiet hours setting suppresses push during configured time range
- [ ] Can disable push globally or configure sound
- [ ] Test push button sends a sample notification

### Routing Pipelines
- [ ] Can create routing rules with source filters (provider, account, event_type, project, any)
- [ ] Can route to: webhook (custom URL), connected account (send message), macOS push, or another rule
- [ ] Webhook presets work for Discord webhooks, Slack webhooks, and generic JSON
- [ ] Template variables ({{title}}, {{body}}, etc.) render correctly
- [ ] Rule chaining works (A → B → C) with cycle detection
- [ ] Routing log shows execution history with success/failure status
- [ ] Can test a rule against the most recent matching notification
- [ ] Rules can be enabled/disabled independently
- [ ] Stop-on-match flag prevents lower-priority rules from firing
- [ ] Max chain depth (10) is enforced

### Routing UI
- [ ] Routing tab shows all rules with inline flow diagrams
- [ ] Flow diagram visually represents the source → destination chain
- [ ] Rule editor supports all source types, destination types, and template editing
- [ ] Live preview shows rendered template with sample data
- [ ] Routing log viewer supports filtering by rule, status, and time range
- [ ] Can reorder rules by priority

---

## Open Questions

1. **Discord Gateway vs. REST polling:** Gateway provides real-time delivery but requires maintaining a persistent WebSocket per account. For users with many accounts, this could be resource-heavy. Should we cap at N concurrent Gateway connections and fall back to REST polling for additional accounts?

2. **Slack token relay hosting:** Should the relay be a standalone Cloudflare Worker, or proxied through the existing Yapture API? The Yapture route avoids a new deployment target but couples Dispatch to Yapture availability.

3. **Notification deduplication:** If a user has both Slack and Discord monitoring the same CI pipeline (which posts to both), the same build failure could generate two notifications. Should routing rules support dedup by content hash within a time window?

4. **Routing rule versioning:** Should rule changes be tracked (undo/redo)? Or is create/edit/delete sufficient?

5. **Webhook retry policy:** On transient failures (5xx, timeout), should the routing engine retry? If so, how many times and with what backoff? Suggested: 3 retries with exponential backoff (1s, 5s, 25s), configurable per rule.

6. **Rate limiting:** Discord and Slack both have API rate limits. The sync/send functions need rate limit awareness. Should this be per-account or global?

7. **End-to-end encryption:** Should webhook payloads support HMAC signing so the receiving endpoint can verify the sender? If so, where is the signing secret stored?
