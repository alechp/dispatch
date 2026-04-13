//! Discord integration module for Dispatch.
//!
//! Handles OAuth 2.0 with PKCE, user/guild info fetching, channel listing,
//! message history sync, and message sending via Discord's REST API.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// Discord API constants
const DISCORD_API_BASE: &str = "https://discord.com/api/v10";
const DISCORD_OAUTH_AUTHORIZE: &str = "https://discord.com/oauth2/authorize";
const DISCORD_OAUTH_TOKEN: &str = "https://discord.com/api/v10/oauth2/token";

// These would be set during app registration
const DISCORD_CLIENT_ID: &str = "DISPATCH_DISCORD_CLIENT_ID"; // TODO: Replace with actual client ID
const DISCORD_REDIRECT_URI: &str = "dispatch://oauth/discord/callback";
const DISCORD_SCOPES: &str = "identify guilds messages.read";

// --- OAuth Types ---

#[derive(Debug, Clone)]
pub struct DiscordOAuthState {
    pub state: String,
    pub code_verifier: String,
}

#[derive(Debug, Deserialize)]
pub struct DiscordTokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
    pub refresh_token: Option<String>,
    pub scope: String,
}

// --- Discord API Response Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordUser {
    pub id: String,
    pub username: String,
    pub discriminator: String,
    pub avatar: Option<String>,
    pub global_name: Option<String>,
    pub email: Option<String>,
}

impl DiscordUser {
    pub fn display_name(&self) -> String {
        if let Some(ref gn) = self.global_name {
            gn.clone()
        } else if self.discriminator == "0" {
            self.username.clone()
        } else {
            format!("{}#{}", self.username, self.discriminator)
        }
    }

    pub fn avatar_url(&self) -> Option<String> {
        self.avatar.as_ref().map(|hash| {
            format!(
                "https://cdn.discordapp.com/avatars/{}/{}.png?size=128",
                self.id, hash
            )
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordGuild {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub owner: Option<bool>,
    pub permissions: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordChannel {
    pub id: String,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub channel_type: u8,
    pub guild_id: Option<String>,
    pub position: Option<i32>,
    pub topic: Option<String>,
    pub parent_id: Option<String>,
}

impl DiscordChannel {
    /// Returns true if this is a text channel (type 0) or announcement channel (type 5)
    pub fn is_text_channel(&self) -> bool {
        self.channel_type == 0 || self.channel_type == 5
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordMessage {
    pub id: String,
    pub channel_id: String,
    pub author: DiscordMessageAuthor,
    pub content: String,
    pub timestamp: String,
    #[serde(default)]
    pub edited_timestamp: Option<String>,
    #[serde(default)]
    pub tts: bool,
    #[serde(default)]
    pub mention_everyone: bool,
    #[serde(rename = "type")]
    pub message_type: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordMessageAuthor {
    pub id: String,
    pub username: String,
    pub discriminator: String,
    pub avatar: Option<String>,
    pub global_name: Option<String>,
    #[serde(default)]
    pub bot: bool,
}

impl DiscordMessageAuthor {
    pub fn display_name(&self) -> String {
        if let Some(ref gn) = self.global_name {
            gn.clone()
        } else if self.discriminator == "0" {
            self.username.clone()
        } else {
            format!("{}#{}", self.username, self.discriminator)
        }
    }

    pub fn avatar_url(&self) -> Option<String> {
        self.avatar.as_ref().map(|hash| {
            format!(
                "https://cdn.discordapp.com/avatars/{}/{}.png?size=64",
                self.id, hash
            )
        })
    }
}

/// Grouped structure for UI channel picker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuildWithChannels {
    pub guild: DiscordGuild,
    pub channels: Vec<DiscordChannel>,
}

// --- OAuth Flow ---

/// Convert bytes to a hex string (avoids dependency on the `hex` crate).
fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Generate PKCE code verifier and challenge for OAuth
fn generate_pkce() -> (String, String) {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let verifier_bytes: Vec<u8> = (0..32).map(|_| rng.gen()).collect();
    let code_verifier =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&verifier_bytes);

    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let challenge_bytes = hasher.finalize();
    let code_challenge =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&challenge_bytes);

    (code_verifier, code_challenge)
}

/// Start the Discord OAuth flow. Returns (authorization_url, oauth_state).
pub fn start_oauth_flow() -> (String, DiscordOAuthState) {
    use rand::Rng;
    let mut rng = rand::thread_rng();

    // Generate state for CSRF protection
    let state_bytes: Vec<u8> = (0..16).map(|_| rng.gen()).collect();
    let state = bytes_to_hex(&state_bytes);

    // Generate PKCE
    let (code_verifier, code_challenge) = generate_pkce();

    let auth_url = format!(
        "{}?client_id={}&response_type=code&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        DISCORD_OAUTH_AUTHORIZE,
        DISCORD_CLIENT_ID,
        urlencoding::encode(DISCORD_REDIRECT_URI),
        urlencoding::encode(DISCORD_SCOPES),
        state,
        code_challenge,
    );

    let oauth_state = DiscordOAuthState {
        state: state.clone(),
        code_verifier,
    };

    (auth_url, oauth_state)
}

/// Exchange authorization code for tokens.
pub async fn exchange_code(
    http: &reqwest::Client,
    code: &str,
    code_verifier: &str,
) -> Result<DiscordTokenResponse, String> {
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", DISCORD_REDIRECT_URI),
        ("client_id", DISCORD_CLIENT_ID),
        ("code_verifier", code_verifier),
    ];

    let response = http
        .post(DISCORD_OAUTH_TOKEN)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Discord token exchange failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Discord token exchange returned {}: {}",
            status, body
        ));
    }

    response
        .json::<DiscordTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse Discord token response: {}", e))
}

/// Refresh an expired access token.
pub async fn refresh_token(
    http: &reqwest::Client,
    refresh_token_value: &str,
) -> Result<DiscordTokenResponse, String> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token_value),
        ("client_id", DISCORD_CLIENT_ID),
    ];

    let response = http
        .post(DISCORD_OAUTH_TOKEN)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Discord token refresh failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Discord token refresh returned {}: {}",
            status, body
        ));
    }

    response
        .json::<DiscordTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse Discord refresh response: {}", e))
}

// --- API Calls ---

/// Fetch the authenticated user's profile.
pub async fn fetch_current_user(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<DiscordUser, String> {
    let response = http
        .get(&format!("{}/users/@me", DISCORD_API_BASE))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Discord user: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Discord user fetch returned {}: {}", status, body));
    }

    response
        .json::<DiscordUser>()
        .await
        .map_err(|e| format!("Failed to parse Discord user: {}", e))
}

/// Fetch the user's guilds (servers).
pub async fn fetch_guilds(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<Vec<DiscordGuild>, String> {
    let response = http
        .get(&format!("{}/users/@me/guilds", DISCORD_API_BASE))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Discord guilds: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Discord guilds fetch returned {}: {}",
            status, body
        ));
    }

    response
        .json::<Vec<DiscordGuild>>()
        .await
        .map_err(|e| format!("Failed to parse Discord guilds: {}", e))
}

/// Fetch channels for a specific guild.
pub async fn fetch_guild_channels(
    http: &reqwest::Client,
    access_token: &str,
    guild_id: &str,
) -> Result<Vec<DiscordChannel>, String> {
    let response = http
        .get(&format!(
            "{}/guilds/{}/channels",
            DISCORD_API_BASE, guild_id
        ))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch guild channels: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Discord channels fetch returned {}: {}",
            status, body
        ));
    }

    let channels: Vec<DiscordChannel> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Discord channels: {}", e))?;

    // Filter to text channels only
    Ok(channels
        .into_iter()
        .filter(|c| c.is_text_channel())
        .collect())
}

/// Fetch all guilds with their text channels (for the channel picker UI).
pub async fn fetch_all_guild_channels(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<Vec<GuildWithChannels>, String> {
    let guilds = fetch_guilds(http, access_token).await?;
    let mut result = Vec::new();

    for guild in guilds {
        match fetch_guild_channels(http, access_token, &guild.id).await {
            Ok(channels) => {
                result.push(GuildWithChannels { guild, channels });
            }
            Err(e) => {
                // Log but don't fail -- user might not have permission in some guilds
                eprintln!(
                    "[discord] Failed to fetch channels for guild {}: {}",
                    guild.name, e
                );
                result.push(GuildWithChannels {
                    guild,
                    channels: vec![],
                });
            }
        }
    }

    Ok(result)
}

/// Fetch message history for a channel.
pub async fn fetch_channel_messages(
    http: &reqwest::Client,
    access_token: &str,
    channel_id: &str,
    after: Option<&str>,
    limit: u32,
) -> Result<Vec<DiscordMessage>, String> {
    let limit = limit.min(100); // Discord API max
    let mut url = format!(
        "{}/channels/{}/messages?limit={}",
        DISCORD_API_BASE, channel_id, limit
    );
    if let Some(after_id) = after {
        url.push_str(&format!("&after={}", after_id));
    }

    let response = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch channel messages: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Discord messages fetch returned {}: {}",
            status, body
        ));
    }

    response
        .json::<Vec<DiscordMessage>>()
        .await
        .map_err(|e| format!("Failed to parse Discord messages: {}", e))
}

/// Send a message to a Discord channel.
pub async fn send_channel_message(
    http: &reqwest::Client,
    access_token: &str,
    channel_id: &str,
    content: &str,
) -> Result<DiscordMessage, String> {
    let body = serde_json::json!({
        "content": content,
    });

    let response = http
        .post(&format!(
            "{}/channels/{}/messages",
            DISCORD_API_BASE, channel_id
        ))
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to send Discord message: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Discord send message returned {}: {}",
            status, body
        ));
    }

    response
        .json::<DiscordMessage>()
        .await
        .map_err(|e| format!("Failed to parse Discord send response: {}", e))
}

/// Send a message via Discord webhook (for routing pipelines).
pub async fn send_webhook_message(
    http: &reqwest::Client,
    webhook_url: &str,
    content: &str,
    username: Option<&str>,
) -> Result<(), String> {
    let mut body = serde_json::json!({
        "content": content,
    });

    if let Some(name) = username {
        body["username"] = serde_json::Value::String(name.to_string());
    }

    let response = http
        .post(webhook_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to send Discord webhook: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!(
            "Discord webhook returned {}: {}",
            status, body_text
        ));
    }

    Ok(())
}

// --- Connection Test ---

/// Test if an access token is valid by fetching the current user.
pub async fn test_connection(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<DiscordUser, String> {
    fetch_current_user(http, access_token).await
}

/// Check if a token needs refreshing (within 1 hour of expiry).
pub fn token_needs_refresh(expires_at: Option<&str>) -> bool {
    if let Some(exp) = expires_at {
        if let Ok(expiry) = chrono::DateTime::parse_from_rfc3339(exp) {
            let now = chrono::Utc::now();
            let buffer = chrono::Duration::hours(1);
            return now + buffer > expiry;
        }
    }
    false
}

/// Calculate the token expiry timestamp from an expires_in value.
pub fn calculate_token_expiry(expires_in: u64) -> String {
    let expiry = chrono::Utc::now() + chrono::Duration::seconds(expires_in as i64);
    expiry.to_rfc3339()
}

// --- Utility: Discord deep link ---

/// Generate a Discord deep link URL for a specific message.
pub fn message_deep_link(guild_id: &str, channel_id: &str, message_id: &str) -> String {
    format!(
        "discord://discord.com/channels/{}/{}/{}",
        guild_id, channel_id, message_id
    )
}

/// Generate a Discord deep link URL for a channel.
pub fn channel_deep_link(guild_id: &str, channel_id: &str) -> String {
    format!(
        "discord://discord.com/channels/{}/{}",
        guild_id, channel_id
    )
}
