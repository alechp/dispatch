# Notification Integration Setup Guide

Step-by-step instructions to enable Discord and Slack notifications in Dispatch.

---

## Prerequisites

- Dispatch built and running (`cargo tauri dev` or production build)
- Deep link scheme `dispatch://` registered (already configured in `tauri.conf.json`)

---

## Part 1: Discord Integration

### Step 1: Create a Discord Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**, give it a name (e.g. "Dispatch Notifications")
3. Copy the **Application ID** (this is your Client ID)

### Step 2: Configure OAuth2

1. In your Discord app, go to **OAuth2 > General**
2. Add a redirect URL: `dispatch://oauth/discord/callback`
3. Under **OAuth2 > URL Generator**, verify these scopes are available:
   - `identify` -- read your user info
   - `guilds` -- list your servers
   - `messages.read` -- read messages in channels you have access to

### Step 3: Update the Client ID in Source

The Discord Client ID is currently hardcoded as a placeholder. Update it:

**File:** `src-tauri/src/discord.rs` line 16
```rust
// Change this:
const DISCORD_CLIENT_ID: &str = "DISPATCH_DISCORD_CLIENT_ID";
// To your actual Application ID:
const DISCORD_CLIENT_ID: &str = "1234567890123456789";
```

> **Future improvement:** Move this to a runtime setting stored in the DB so users can enter it in the UI without recompiling.

### Step 4: Connect in Dispatch

1. Open Dispatch > **Settings > Accounts** tab
2. Click **Connect Discord**
3. Enter your Discord Application Client ID
4. Click **Authorize** -- this opens your browser
5. In the browser, authorize the Discord app
6. The browser redirects to `dispatch://oauth/discord/callback`
7. Dispatch captures the callback, exchanges the code for tokens (using PKCE), and creates the account
8. The account appears in the Accounts list

### Step 5: Select Channels to Monitor

1. Expand your Discord account card in Settings > Accounts
2. Click **Fetch Channels** -- this loads all channels from your guilds
3. Check the channels you want notifications from
4. Click **Save Channels**

### Step 6: Configure Visibility

- Use the per-screen toggles to control where this account's notifications appear
- Toggle the account on/off with the main enable switch

---

## Part 2: Slack Integration

### Step 1: Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App > From scratch**
3. Name it (e.g. "Dispatch") and select your workspace
4. Copy the **Client ID** and **Client Secret**

### Step 2: Configure OAuth & Permissions

1. In your Slack app, go to **OAuth & Permissions**
2. Add a redirect URL: `dispatch://oauth/slack/callback`
3. Under **User Token Scopes**, add:
   - `channels:history` -- read public channel messages
   - `channels:read` -- list public channels
   - `groups:read` -- list private channels
   - `groups:history` -- read private channel messages
   - `im:history` -- read DMs
   - `im:read` -- list DMs
   - `mpim:history` -- read group DMs
   - `mpim:read` -- list group DMs
   - `users:read` -- read user info
   - `users.profile:read` -- read user profiles
   - `team:read` -- read workspace info

### Step 3: Deploy a Token Relay Server

Slack OAuth requires a `client_secret` for token exchange, which cannot be embedded in a desktop binary. You need a small server-side relay.

**The relay must:**
1. Accept POST requests with `{ "code": "...", "redirect_uri": "..." }`
2. Forward the token exchange to `https://slack.com/api/oauth.v2.access` with the `client_id`, `client_secret`, `code`, and `redirect_uri`
3. Return the Slack token response as JSON

**Minimal example (Node.js/Express):**

```javascript
const express = require("express");
const app = express();
app.use(express.json());

const SLACK_CLIENT_ID = "your-client-id";
const SLACK_CLIENT_SECRET = "your-client-secret";

app.post("/slack/token", async (req, res) => {
  const { code, redirect_uri } = req.body;
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri,
    }),
  });
  const data = await response.json();
  res.json(data);
});

app.listen(3456, () => console.log("Slack relay on :3456"));
```

**Or deploy to Cloudflare Workers / Vercel / any serverless platform.**

### Step 4: Update the Relay URL in Source

**File:** `src-tauri/src/slack.rs` line 22
```rust
// Change this:
const SLACK_TOKEN_RELAY_URL: &str = "https://relay.dispatch.app/slack/token";
// To your actual relay URL:
const SLACK_TOKEN_RELAY_URL: &str = "https://your-relay.example.com/slack/token";
```

### Step 5: Update the Client ID in Source

**File:** `src-tauri/src/slack.rs` line 17
```rust
// Change this:
const SLACK_CLIENT_ID: &str = "DISPATCH_SLACK_CLIENT_ID";
// To your actual Slack Client ID:
const SLACK_CLIENT_ID: &str = "1234567890.1234567890123";
```

### Step 6: Connect in Dispatch

1. Open Dispatch > **Settings > Accounts** tab
2. Click **Connect Slack**
3. Enter your Slack Client ID and Relay URL
4. Click **Authorize** -- opens browser
5. Authorize the Slack app for your workspace
6. Browser redirects to `dispatch://oauth/slack/callback`
7. Dispatch sends the auth code to your relay, which exchanges it for tokens
8. The account appears in the Accounts list

### Step 7: Select Conversations to Monitor

1. Expand your Slack account card
2. Click **Fetch Channels** -- loads all conversations (channels, DMs, groups)
3. Select conversations to monitor
4. Click **Save Channels**

---

## Part 3: Notification Routing

Once accounts are connected, you can route notifications between them.

### Create a Routing Rule

1. Go to **Settings > Routing** tab
2. Click **New Rule**
3. Configure:
   - **Name:** e.g. "Slack alerts to Discord"
   - **Source:** Select source type (provider, account, event type, etc.) and value
   - **Destination:** Choose webhook, account, macOS push, or chain to another rule
   - **Template:** Optionally customize the message with `{{title}}`, `{{body}}`, `{{source}}`, `{{provider}}`, `{{channel}}`, `{{author}}`, `{{created_at}}`
   - **Filters:** Optionally filter by event types or keywords
   - **Priority:** Higher priority rules are evaluated first
   - **Stop on match:** Stop evaluating further rules if this one matches
4. Click **Save**
5. Use **Test** to verify the rule matches a sample notification

### Example: Slack to Discord Webhook

1. Create a Discord webhook in your target channel (Channel Settings > Integrations > Webhooks)
2. Create a routing rule:
   - Source: `provider` = `slack`
   - Destination: `webhook`
   - URL: your Discord webhook URL
   - Template: `**{{author}}** in #{{channel}}: {{body}}`

### Chain Rules

Rules can chain: Rule A's destination can be `routing_rule` pointing to Rule B. Use **Validate Chain** to check for cycles.

---

## Part 4: macOS Push Notifications

1. Go to **Settings > Accounts** tab
2. Scroll to **macOS Push Notifications** section
3. Enable push notifications
4. Configure:
   - **Sound:** Toggle notification sound on/off
   - **Quiet hours:** Set start/end times to silence notifications
   - **Suppress when focused:** Skip push when Dispatch window is active
5. Click **Send Test Notification** to verify

---

## Part 5: Remaining TODOs

These items need to be completed before the integration is fully production-ready:

### Must-do (code changes required)

| Item | File | Description |
|------|------|-------------|
| Move Client IDs to runtime config | `discord.rs:16`, `slack.rs:17` | Store in DB settings instead of compile-time constants so users can configure via UI without recompiling |
| Move Relay URL to runtime config | `slack.rs:22` | Same as above -- let users enter relay URL in the UI |
| Deploy token relay | (new service) | Host the Slack token relay server somewhere accessible |
| Background polling | (new module) | Poll Discord/Slack APIs for new messages and create notifications in DB |
| Webhook execution | `routing.rs` | Wire `webhook::deliver()` into the routing engine's rule execution path |
| Push notification execution | `macos_notifications.rs` | Wire `prepare_push()` into the notification pipeline to actually send native pushes |

### Nice-to-have

| Item | Description |
|------|-------------|
| Token refresh | Automatically refresh expired Discord/Slack tokens before API calls |
| Real-time WebSocket | Use Discord Gateway / Slack Socket Mode for instant notifications instead of polling |
| Account re-authorization | UI flow to re-authorize an account if tokens are revoked |
| Notification deduplication | Prevent duplicate notifications when polling overlaps |
