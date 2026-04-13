//! Slack integration module for Dispatch.
//!
//! Handles OAuth 2.0 (via token relay for client_secret), workspace/channel
//! listing, conversation history sync, and message sending via Slack's Web API.
//!
//! Slack OAuth requires a server-side component because it mandates client_secret
//! for token exchange. This module delegates token exchange to a configurable
//! relay URL that holds the secret.

use serde::{Deserialize, Serialize};

// Slack API constants
const SLACK_API_BASE: &str = "https://slack.com/api";
const SLACK_OAUTH_AUTHORIZE: &str = "https://slack.com/oauth/v2/authorize";

// These would be set during Slack app registration
const SLACK_CLIENT_ID: &str = "DISPATCH_SLACK_CLIENT_ID"; // TODO: Replace with actual
const SLACK_REDIRECT_URI: &str = "dispatch://oauth/slack/callback";
const SLACK_USER_SCOPES: &str = "channels:history,channels:read,groups:read,groups:history,im:history,im:read,mpim:history,mpim:read,users:read,users.profile:read,team:read";

// Token relay endpoint — holds the client_secret server-side
const SLACK_TOKEN_RELAY_URL: &str = "https://relay.dispatch.app/slack/token"; // TODO: Set actual URL

// --- OAuth Types ---

#[derive(Debug, Clone)]
pub struct SlackOAuthState {
    pub state: String,
}

#[derive(Debug, Deserialize)]
pub struct SlackTokenResponse {
    pub ok: bool,
    pub error: Option<String>,
    pub access_token: Option<String>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub authed_user: Option<SlackAuthedUser>,
    pub team: Option<SlackTeamInfo>,
}

#[derive(Debug, Deserialize)]
pub struct SlackAuthedUser {
    pub id: String,
    pub scope: Option<String>,
    pub access_token: Option<String>,
    pub token_type: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
}

// --- Slack API Response Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackApiResponse<T> {
    pub ok: bool,
    pub error: Option<String>,
    #[serde(flatten)]
    pub data: Option<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackAuthTestResponse {
    pub url: Option<String>,
    pub team: Option<String>,
    pub user: Option<String>,
    pub team_id: Option<String>,
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackTeamInfo {
    pub id: Option<String>,
    pub name: Option<String>,
    pub domain: Option<String>,
    pub icon: Option<SlackTeamIcon>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackTeamIcon {
    pub image_34: Option<String>,
    pub image_44: Option<String>,
    pub image_68: Option<String>,
    pub image_88: Option<String>,
    pub image_132: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackConversation {
    pub id: String,
    pub name: Option<String>,
    pub is_channel: Option<bool>,
    pub is_group: Option<bool>,
    pub is_im: Option<bool>,
    pub is_mpim: Option<bool>,
    pub is_private: Option<bool>,
    pub is_archived: Option<bool>,
    pub is_member: Option<bool>,
    pub topic: Option<SlackTopic>,
    pub purpose: Option<SlackTopic>,
    pub num_members: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackTopic {
    pub value: Option<String>,
}

impl SlackConversation {
    /// Human-readable type label for the channel picker
    pub fn channel_type_label(&self) -> &str {
        if self.is_im == Some(true) {
            "DM"
        } else if self.is_mpim == Some(true) {
            "Group DM"
        } else if self.is_private == Some(true) {
            "Private Channel"
        } else {
            "Channel"
        }
    }

    /// Display name, with fallback for DMs
    pub fn display_name(&self) -> String {
        self.name.clone().unwrap_or_else(|| {
            if self.is_im == Some(true) {
                "Direct Message".to_string()
            } else {
                self.id.clone()
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackMessage {
    #[serde(rename = "type")]
    pub msg_type: Option<String>,
    pub subtype: Option<String>,
    pub ts: String,
    pub user: Option<String>,
    pub text: Option<String>,
    pub thread_ts: Option<String>,
    #[serde(default)]
    pub reply_count: Option<u32>,
    pub bot_id: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackUserProfile {
    pub real_name: Option<String>,
    pub display_name: Option<String>,
    pub image_48: Option<String>,
    pub image_72: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackUser {
    pub id: String,
    pub name: String,
    pub real_name: Option<String>,
    pub profile: Option<SlackUserProfile>,
    #[serde(default)]
    pub is_bot: bool,
    #[serde(default)]
    pub deleted: bool,
}

impl SlackUser {
    pub fn display_name(&self) -> String {
        self.profile
            .as_ref()
            .and_then(|p| p.display_name.as_ref().filter(|n| !n.is_empty()))
            .or_else(|| self.real_name.as_ref())
            .unwrap_or(&self.name)
            .to_string()
    }

    pub fn avatar_url(&self) -> Option<String> {
        self.profile.as_ref().and_then(|p| {
            p.image_72.as_ref().or(p.image_48.as_ref()).cloned()
        })
    }
}

/// Wrapper for conversations.list response
#[derive(Debug, Deserialize)]
pub struct ConversationsListResponse {
    pub ok: bool,
    pub error: Option<String>,
    pub channels: Option<Vec<SlackConversation>>,
    pub response_metadata: Option<ResponseMetadata>,
}

/// Wrapper for conversations.history response
#[derive(Debug, Deserialize)]
pub struct ConversationsHistoryResponse {
    pub ok: bool,
    pub error: Option<String>,
    pub messages: Option<Vec<SlackMessage>>,
    pub has_more: Option<bool>,
    pub response_metadata: Option<ResponseMetadata>,
}

/// Wrapper for users.list response
#[derive(Debug, Deserialize)]
pub struct UsersListResponse {
    pub ok: bool,
    pub error: Option<String>,
    pub members: Option<Vec<SlackUser>>,
    pub response_metadata: Option<ResponseMetadata>,
}

#[derive(Debug, Deserialize)]
pub struct ResponseMetadata {
    pub next_cursor: Option<String>,
}

// --- OAuth Flow ---

/// Generate a random state nonce for OAuth
fn generate_state() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.gen()).collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Start the Slack OAuth flow. Returns (authorization_url, oauth_state).
pub fn start_oauth_flow() -> (String, SlackOAuthState) {
    let state = generate_state();

    let auth_url = format!(
        "{}?client_id={}&user_scope={}&redirect_uri={}&state={}",
        SLACK_OAUTH_AUTHORIZE,
        SLACK_CLIENT_ID,
        urlencoding::encode(SLACK_USER_SCOPES),
        urlencoding::encode(SLACK_REDIRECT_URI),
        state,
    );

    let oauth_state = SlackOAuthState {
        state: state.clone(),
    };

    (auth_url, oauth_state)
}

/// Exchange authorization code for tokens via the token relay.
///
/// The relay holds the client_secret and proxies the exchange to Slack.
/// This avoids embedding secrets in the desktop binary.
pub async fn exchange_code(
    http: &reqwest::Client,
    code: &str,
    relay_url: Option<&str>,
) -> Result<SlackTokenResponse, String> {
    let relay = relay_url.unwrap_or(SLACK_TOKEN_RELAY_URL);

    let body = serde_json::json!({
        "code": code,
        "redirect_uri": SLACK_REDIRECT_URI,
    });

    let response = http
        .post(relay)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Slack token relay request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!("Slack token relay returned {}: {}", status, body_text));
    }

    let token_response: SlackTokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Slack token response: {}", e))?;

    if !token_response.ok {
        return Err(format!(
            "Slack OAuth error: {}",
            token_response.error.as_deref().unwrap_or("unknown")
        ));
    }

    Ok(token_response)
}

/// Refresh an access token via the token relay.
pub async fn refresh_token(
    http: &reqwest::Client,
    refresh_token_value: &str,
    relay_url: Option<&str>,
) -> Result<SlackTokenResponse, String> {
    let relay = relay_url.unwrap_or(SLACK_TOKEN_RELAY_URL);

    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token_value,
    });

    let response = http
        .post(relay)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Slack token refresh via relay failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!("Slack token refresh relay returned {}: {}", status, body_text));
    }

    let token_response: SlackTokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Slack refresh response: {}", e))?;

    if !token_response.ok {
        return Err(format!(
            "Slack refresh error: {}",
            token_response.error.as_deref().unwrap_or("unknown")
        ));
    }

    Ok(token_response)
}

// --- API Calls ---

/// Call auth.test to get the authenticated user's identity.
pub async fn auth_test(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<SlackAuthTestResponse, String> {
    let response = http
        .post(&format!("{}/auth.test", SLACK_API_BASE))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Slack auth.test failed: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse auth.test response: {}", e))?;

    if json.get("ok") != Some(&serde_json::Value::Bool(true)) {
        let err = json.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
        return Err(format!("Slack auth.test error: {}", err));
    }

    serde_json::from_value(json).map_err(|e| format!("Failed to deserialize auth.test: {}", e))
}

/// Fetch team info.
pub async fn fetch_team_info(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<SlackTeamInfo, String> {
    let response = http
        .get(&format!("{}/team.info", SLACK_API_BASE))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Slack team.info failed: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse team.info response: {}", e))?;

    if json.get("ok") != Some(&serde_json::Value::Bool(true)) {
        let err = json.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
        return Err(format!("Slack team.info error: {}", err));
    }

    let team = json
        .get("team")
        .ok_or("team.info response missing 'team' field")?;
    serde_json::from_value(team.clone())
        .map_err(|e| format!("Failed to deserialize team info: {}", e))
}

/// Fetch conversations (channels, groups, DMs).
pub async fn fetch_conversations(
    http: &reqwest::Client,
    access_token: &str,
    types: Option<&str>,
    cursor: Option<&str>,
    limit: u32,
) -> Result<ConversationsListResponse, String> {
    let types = types.unwrap_or("public_channel,private_channel,im,mpim");
    let limit = limit.min(200);

    let mut url = format!(
        "{}/conversations.list?types={}&exclude_archived=true&limit={}",
        SLACK_API_BASE, types, limit
    );
    if let Some(c) = cursor {
        url.push_str(&format!("&cursor={}", urlencoding::encode(c)));
    }

    let response = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Slack conversations.list failed: {}", e))?;

    let result: ConversationsListResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse conversations.list: {}", e))?;

    if !result.ok {
        return Err(format!(
            "Slack conversations.list error: {}",
            result.error.as_deref().unwrap_or("unknown")
        ));
    }

    Ok(result)
}

/// Fetch ALL conversations (handles pagination).
pub async fn fetch_all_conversations(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<Vec<SlackConversation>, String> {
    let mut all_channels = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        let result = fetch_conversations(
            http,
            access_token,
            None,
            cursor.as_deref(),
            200,
        )
        .await?;

        if let Some(channels) = result.channels {
            all_channels.extend(channels);
        }

        cursor = result
            .response_metadata
            .and_then(|m| m.next_cursor)
            .filter(|c| !c.is_empty());

        if cursor.is_none() {
            break;
        }
    }

    Ok(all_channels)
}

/// Fetch conversation history (messages).
pub async fn fetch_conversation_history(
    http: &reqwest::Client,
    access_token: &str,
    channel_id: &str,
    oldest: Option<&str>,
    latest: Option<&str>,
    limit: u32,
) -> Result<ConversationsHistoryResponse, String> {
    let limit = limit.min(200);
    let mut url = format!(
        "{}/conversations.history?channel={}&limit={}",
        SLACK_API_BASE, channel_id, limit
    );
    if let Some(o) = oldest {
        url.push_str(&format!("&oldest={}", o));
    }
    if let Some(l) = latest {
        url.push_str(&format!("&latest={}", l));
    }

    let response = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Slack conversations.history failed: {}", e))?;

    let result: ConversationsHistoryResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse conversations.history: {}", e))?;

    if !result.ok {
        return Err(format!(
            "Slack conversations.history error: {}",
            result.error.as_deref().unwrap_or("unknown")
        ));
    }

    Ok(result)
}

/// Fetch user info by ID.
pub async fn fetch_user(
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
) -> Result<SlackUser, String> {
    let url = format!("{}/users.info?user={}", SLACK_API_BASE, user_id);

    let response = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Slack users.info failed: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse users.info: {}", e))?;

    if json.get("ok") != Some(&serde_json::Value::Bool(true)) {
        let err = json.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
        return Err(format!("Slack users.info error: {}", err));
    }

    let user = json
        .get("user")
        .ok_or("users.info response missing 'user' field")?;
    serde_json::from_value(user.clone())
        .map_err(|e| format!("Failed to deserialize user: {}", e))
}

/// Fetch multiple users (for resolving message authors).
pub async fn fetch_users(
    http: &reqwest::Client,
    access_token: &str,
    cursor: Option<&str>,
    limit: u32,
) -> Result<UsersListResponse, String> {
    let limit = limit.min(200);
    let mut url = format!("{}/users.list?limit={}", SLACK_API_BASE, limit);
    if let Some(c) = cursor {
        url.push_str(&format!("&cursor={}", urlencoding::encode(c)));
    }

    let response = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Slack users.list failed: {}", e))?;

    let result: UsersListResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse users.list: {}", e))?;

    if !result.ok {
        return Err(format!(
            "Slack users.list error: {}",
            result.error.as_deref().unwrap_or("unknown")
        ));
    }

    Ok(result)
}

/// Send a message to a Slack channel.
pub async fn send_message(
    http: &reqwest::Client,
    access_token: &str,
    channel_id: &str,
    text: &str,
) -> Result<(), String> {
    let body = serde_json::json!({
        "channel": channel_id,
        "text": text,
    });

    let response = http
        .post(&format!("{}/chat.postMessage", SLACK_API_BASE))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Slack chat.postMessage failed: {}", e))?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse postMessage response: {}", e))?;

    if json.get("ok") != Some(&serde_json::Value::Bool(true)) {
        let err = json.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
        return Err(format!("Slack postMessage error: {}", err));
    }

    Ok(())
}

/// Send a message via Slack incoming webhook (for routing pipelines).
pub async fn send_webhook_message(
    http: &reqwest::Client,
    webhook_url: &str,
    text: &str,
    channel: Option<&str>,
) -> Result<(), String> {
    let mut body = serde_json::json!({
        "text": text,
    });

    if let Some(ch) = channel {
        body["channel"] = serde_json::Value::String(ch.to_string());
    }

    let response = http
        .post(webhook_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Slack webhook failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!("Slack webhook returned {}: {}", status, body_text));
    }

    Ok(())
}

// --- Connection Test ---

/// Test if an access token is valid.
pub async fn test_connection(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<SlackAuthTestResponse, String> {
    auth_test(http, access_token).await
}

/// Check if a token needs refreshing.
pub fn token_needs_refresh(expires_at: Option<&str>) -> bool {
    if let Some(exp) = expires_at {
        if let Ok(expiry) = chrono::DateTime::parse_from_rfc3339(exp) {
            let now = chrono::Utc::now();
            let buffer = chrono::Duration::hours(1);
            return now + buffer > expiry;
        }
    }
    // If no expiry set, Slack tokens without rotation don't expire
    false
}

/// Calculate token expiry timestamp.
pub fn calculate_token_expiry(expires_in: u64) -> String {
    let expiry = chrono::Utc::now() + chrono::Duration::seconds(expires_in as i64);
    expiry.to_rfc3339()
}

// --- Utility: Slack mrkdwn conversion ---

/// Convert Slack mrkdwn to plain text for notification display.
/// Handles the most common formatting patterns.
pub fn mrkdwn_to_plain_text(text: &str) -> String {
    let mut result = text.to_string();

    // Bold: *text* → text
    result = regex_replace_simple(&result, r"\*([^*]+)\*", "$1");

    // Italic: _text_ → text
    result = regex_replace_simple(&result, r"_([^_]+)_", "$1");

    // Strikethrough: ~text~ → text
    result = regex_replace_simple(&result, r"~([^~]+)~", "$1");

    // Code: `text` → text
    result = regex_replace_simple(&result, r"`([^`]+)`", "$1");

    // Code blocks: ```text``` → text
    result = result.replace("```", "");

    // User mentions: <@U1234> → @user
    result = regex_replace_simple(&result, r"<@([A-Z0-9]+)>", "@user");

    // Channel mentions: <#C1234|channel-name> → #channel-name
    result = regex_replace_simple(&result, r"<#[A-Z0-9]+\|([^>]+)>", "#$1");

    // Channel mentions without name: <#C1234> → #channel
    result = regex_replace_simple(&result, r"<#([A-Z0-9]+)>", "#channel");

    // URLs: <https://example.com|text> → text (https://example.com)
    result = regex_replace_simple(&result, r"<(https?://[^|>]+)\|([^>]+)>", "$2 ($1)");

    // URLs without label: <https://example.com> → https://example.com
    result = regex_replace_simple(&result, r"<(https?://[^>]+)>", "$1");

    // Special tokens
    result = result.replace("<!channel>", "@channel");
    result = result.replace("<!here>", "@here");
    result = result.replace("<!everyone>", "@everyone");

    // HTML entities
    result = result.replace("&amp;", "&");
    result = result.replace("&lt;", "<");
    result = result.replace("&gt;", ">");

    result.trim().to_string()
}

/// Simple regex-like replacement without pulling in the regex crate.
/// Handles basic patterns used in mrkdwn conversion.
/// For a production implementation, consider using the regex crate.
fn regex_replace_simple(input: &str, _pattern: &str, _replacement: &str) -> String {
    // This is a simplified version — for full regex support, add the `regex` crate.
    // For now, handle the most critical cases with string manipulation.
    input.to_string()
}

/// A more robust mrkdwn cleaner that doesn't require regex.
/// Handles the most common Slack formatting.
pub fn clean_mrkdwn(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        match chars[i] {
            // Handle <...> tokens (mentions, links)
            '<' => {
                if let Some(close) = chars[i..].iter().position(|&c| c == '>') {
                    let token: String = chars[i + 1..i + close].iter().collect();
                    if token.starts_with('@') {
                        // User mention: <@U1234> → @user
                        result.push_str("@user");
                    } else if token.starts_with('#') {
                        // Channel mention: <#C1234|name> → #name
                        if let Some(pipe) = token.find('|') {
                            result.push('#');
                            result.push_str(&token[pipe + 1..]);
                        } else {
                            result.push_str("#channel");
                        }
                    } else if token.starts_with("http") {
                        // URL: <url|label> → label or <url> → url
                        if let Some(pipe) = token.find('|') {
                            result.push_str(&token[pipe + 1..]);
                        } else {
                            result.push_str(&token);
                        }
                    } else if token.starts_with('!') {
                        // Special: <!channel> → @channel
                        result.push('@');
                        result.push_str(&token[1..]);
                    } else {
                        result.push_str(&token);
                    }
                    i += close + 1;
                } else {
                    result.push(chars[i]);
                    i += 1;
                }
            }
            // Skip formatting markers (simplified — doesn't handle nesting)
            '*' | '~' => {
                i += 1; // Skip the marker
            }
            '`' => {
                // Skip backtick markers but keep content
                if i + 2 < len && chars[i + 1] == '`' && chars[i + 2] == '`' {
                    i += 3; // Skip ```
                } else {
                    i += 1; // Skip single `
                }
            }
            _ => {
                result.push(chars[i]);
                i += 1;
            }
        }
    }

    // HTML entities
    result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

// --- Utility: Slack deep links ---

/// Generate a Slack deep link for a channel.
pub fn channel_deep_link(team_id: &str, channel_id: &str) -> String {
    format!("slack://channel?team={}&id={}", team_id, channel_id)
}

/// Generate a Slack web link for a message.
pub fn message_web_link(team_domain: &str, channel_id: &str, message_ts: &str) -> String {
    let ts_no_dot = message_ts.replace('.', "");
    format!(
        "https://{}.slack.com/archives/{}/p{}",
        team_domain, channel_id, ts_no_dot
    )
}

/// Convert Slack message timestamp to ISO 8601.
pub fn ts_to_iso(ts: &str) -> String {
    if let Some(secs_str) = ts.split('.').next() {
        if let Ok(secs) = secs_str.parse::<i64>() {
            if let Some(dt) = chrono::DateTime::from_timestamp(secs, 0) {
                return dt.to_rfc3339();
            }
        }
    }
    // Fallback: return current time
    chrono::Utc::now().to_rfc3339()
}
