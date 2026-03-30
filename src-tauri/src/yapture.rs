use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum YaptureVersion {
    V1,
    V2,
}

impl std::fmt::Display for YaptureVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            YaptureVersion::V1 => write!(f, "v1"),
            YaptureVersion::V2 => write!(f, "v2"),
        }
    }
}

/// Decode user info from a JWT access token (v2 auth service).
/// v2 tokens include custom claims: yap_user_id, email, name.
pub fn decode_jwt_claims(token: &str) -> Option<UserInfo> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 { return None; }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    Some(UserInfo {
        sub: claims.get("yap_user_id")
            .or_else(|| claims.get("sub"))
            .and_then(|v| v.as_str())?.to_string(),
        name: claims.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
        email: claims.get("email").and_then(|v| v.as_str()).map(|s| s.to_string()),
        picture: claims.get("picture").and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}

// --- Part 2: Config + Push ---

#[derive(Debug, Clone)]
pub struct YaptureConfig {
    pub enabled: bool,
    pub api_url: String,
    pub user_id: String,
    pub service_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YaptureConfigResponse {
    pub enabled: bool,
    pub api_url: String,
    pub user_id: String,
    pub has_token: bool,
}

/// Load config from DB settings + in-memory token. Returns None if disabled or misconfigured.
pub async fn load_config(pool: &sqlx::SqlitePool, service_token: Option<String>) -> Option<YaptureConfig> {
    let enabled = crate::db::get_setting(pool, "yapture_enabled").await.ok()?;
    if enabled.as_deref() != Some("1") {
        crate::log::log(&format!("[yapture] load_config: not enabled (yapture_enabled={:?})", enabled));
        return None;
    }
    let api_url = match crate::db::get_setting(pool, "yapture_api_url").await.ok()? {
        Some(url) if !url.is_empty() => url,
        other => {
            crate::log::log(&format!("[yapture] load_config: no api_url ({:?})", other));
            return None;
        }
    };
    let user_id = match crate::db::get_setting(pool, "yapture_user_id").await.ok()? {
        Some(uid) if !uid.is_empty() => uid,
        other => {
            crate::log::log(&format!("[yapture] load_config: no user_id ({:?})", other));
            return None;
        }
    };
    let service_token = match service_token {
        Some(t) if !t.is_empty() => t,
        _ => {
            crate::log::log("[yapture] load_config: no access token in memory");
            return None;
        }
    };
    crate::log::log(&format!("[yapture] load_config: OK — api_url={}, user_id={}, token={}...",
        api_url, user_id, &service_token[..service_token.len().min(12)]));
    Some(YaptureConfig {
        enabled: true,
        api_url,
        user_id,
        service_token,
    })
}

/// Push a Dispatch notification to Yapture as a task + notification. Fire-and-forget.
pub async fn push_notification(
    config: &YaptureConfig,
    notification: &crate::models::Notification,
    db: Option<&sqlx::SqlitePool>,
) {
    crate::log::log(&format!(
        "[yapture] push_notification: id={}, has_session={}, project={}",
        notification.id,
        notification.tmux_session.is_some(),
        notification.project.as_deref().unwrap_or(&notification.source)
    ));

    let client = reqwest::Client::new();
    let project = notification
        .project
        .as_deref()
        .unwrap_or(&notification.source);

    // Build task text: "[project] title" (append body if present)
    let mut text = format!("#@dispatch [{}] {}", project, notification.title);
    if let Some(body) = &notification.body {
        text.push_str(": ");
        text.push_str(body);
    }

    // Append deep link (clickable from Yapture)
    match &notification.tmux_session {
        Some(session) => {
            let mut deep_link = format!("dispatch://focus-terminal?session={}&nid={}", urlencoding::encode(session), urlencoding::encode(&notification.id));
            if let Some(w) = &notification.tmux_window {
                deep_link.push_str(&format!("&window={}", urlencoding::encode(w)));
            }
            if let Some(p) = &notification.tmux_pane {
                deep_link.push_str(&format!("&pane={}", urlencoding::encode(p)));
            }
            text.push(' ');
            text.push_str(&deep_link);
        }
        None => {
            // Fallback: deep link to notifications screen
            let deep_link = format!("dispatch://notifications?nid={}", urlencoding::encode(&notification.id));
            text.push(' ');
            text.push_str(&deep_link);
        }
    }

    if text.len() > 800 {
        text.truncate(800);
    }

    // Use Bearer token (OAuth access token)
    let auth_header = format!("Bearer {}", config.service_token);

    // 1. Create task
    let task_url = format!("{}/api/tasks", config.api_url);
    let task_body = serde_json::json!({
        "text": text,
        "skipNLP": true
    });

    let task_result = client
        .post(&task_url)
        .header("Authorization", &auth_header)
        .header("X-User-ID", &config.user_id)
        .json(&task_body)
        .send()
        .await;

    let task_id = match task_result {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(v) => {
                let id = v
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .to_string();
                crate::log::log(&format!("[yapture] task created: {}", id));
                // Store yapture task ID for bidirectional sync
                if let Some(pool) = db {
                    if !id.is_empty() {
                        if let Err(e) = crate::db::set_yapture_task_id(pool, &notification.id, &id).await {
                            crate::log::log(&format!("[yapture] failed to store task_id: {}", e));
                        }
                    }
                }
                id
            }
            Err(e) => {
                crate::log::log(&format!("[yapture] failed to parse task response: {}", e));
                return;
            }
        },
        Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED => {
            crate::log::log("[yapture] push: 401 — token may be expired, attempting refresh");
            // Try to refresh and retry once
            if let Some(pool) = db {
                if let Ok(Some(rt)) = crate::db::get_setting(pool, "yapture_refresh_token").await {
                    if let Ok(new_tokens) = refresh_access_token(&config.api_url, &rt).await {
                        crate::log::log("[yapture] push: token refreshed, retrying");
                        // Persist the new token
                        let _ = crate::db::set_setting(pool, "yapture_access_token", &new_tokens.access_token).await;
                        if let Some(ref new_rt) = new_tokens.refresh_token {
                            let _ = crate::db::set_setting(pool, "yapture_refresh_token", new_rt).await;
                        }
                        // Retry with new token
                        let new_auth = format!("Bearer {}", new_tokens.access_token);
                        match client.post(&task_url).header("Authorization", &new_auth)
                            .header("X-User-ID", &config.user_id).json(&task_body).send().await {
                            Ok(retry_resp) if retry_resp.status().is_success() => {
                                match retry_resp.json::<serde_json::Value>().await {
                                    Ok(v) => {
                                        let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                                        crate::log::log(&format!("[yapture] task created (after refresh): {}", id));
                                        if !id.is_empty() {
                                            if let Err(e) = crate::db::set_yapture_task_id(pool, &notification.id, &id).await {
                                                crate::log::log(&format!("[yapture] failed to store task_id: {}", e));
                                            }
                                        }
                                        id
                                    }
                                    Err(e) => {
                                        crate::log::log(&format!("[yapture] failed to parse retry response: {}", e));
                                        return;
                                    }
                                }
                            }
                            Ok(retry_resp) => {
                                let status = retry_resp.status();
                                let body = retry_resp.text().await.unwrap_or_default();
                                crate::log::log(&format!("[yapture] retry also failed ({}): {}", status, body));
                                return;
                            }
                            Err(e) => {
                                crate::log::log(&format!("[yapture] retry error: {}", e));
                                return;
                            }
                        }
                    } else {
                        crate::log::log("[yapture] push: token refresh failed");
                        return;
                    }
                } else {
                    crate::log::log("[yapture] push: no refresh token available");
                    return;
                }
            } else {
                crate::log::log("[yapture] push: 401 but no DB pool for refresh");
                return;
            }
        }
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            crate::log::log(&format!("[yapture] task creation failed ({}): {}", status, body));
            return;
        }
        Err(e) => {
            crate::log::log(&format!("[yapture] task creation error: {}", e));
            return;
        }
    };

    // 2. Post webhook notification
    let webhook_url = format!("{}/api/webhooks/capswan/task.created", config.api_url);
    let webhook_body = serde_json::json!({
        "capswanTaskId": format!("dispatch-notif-{}", notification.id),
        "yaptureTaskId": task_id,
        "organizationId": "dispatch",
        "organizationName": "Dispatch",
        "taskTitle": notification.title,
        "taskStatus": "open",
        "userId": config.user_id,
        "createdAt": notification.created_at
    });

    match client
        .post(&webhook_url)
        .header("Authorization", &auth_header)
        .json(&webhook_body)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            crate::log::log("[yapture] webhook notification sent");
        }
        Ok(resp) => {
            crate::log::log(&format!("[yapture] webhook failed: {}", resp.status()));
        }
        Err(e) => {
            crate::log::log(&format!("[yapture] webhook error: {}", e));
        }
    }
}

/// Complete a Yapture task (bidirectional sync). Fire-and-forget safe.
pub async fn complete_yapture_task(config: &YaptureConfig, yapture_task_id: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/tasks/{}", config.api_url, yapture_task_id);
    let auth = format!("Bearer {}", config.service_token);

    let resp = client
        .patch(&url)
        .header("Authorization", &auth)
        .header("X-User-ID", &config.user_id)
        .json(&serde_json::json!({ "completed": true }))
        .send()
        .await
        .map_err(|e| format!("Yapture PATCH failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Yapture returned {} completing task: {}", status, body));
    }
    crate::log::log(&format!("[yapture-sync] completed task {}", yapture_task_id));
    Ok(())
}

/// Test connection to Yapture API using the OAuth access token.
/// Calls /api/userinfo which requires a valid Bearer token.
pub async fn test_connection(api_url: &str, access_token: &str) -> bool {
    if access_token.is_empty() {
        return false;
    }
    let client = reqwest::Client::new();
    let url = format!("{}/api/userinfo", api_url);
    match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

// --- Part 3: OAuth PKCE Flow ---

#[derive(Debug, Clone)]
pub struct OAuthState {
    pub code_verifier: String,
    pub state: String,
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub expires_in: Option<u64>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub sub: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub picture: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YaptureConnectionStatus {
    pub connected: bool,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
}

/// Generate PKCE challenge pair + state, return authorization URL.
pub fn start_oauth_flow(api_url: &str) -> (String, OAuthState) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::{Digest, Sha256};

    // Generate code_verifier (43-128 chars, unreserved chars)
    let code_verifier: String = (0..64)
        .map(|_| {
            let idx = rand::random::<u8>() % 66;
            let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
            chars[idx as usize] as char
        })
        .collect();

    // Generate code_challenge = BASE64URL(SHA256(code_verifier))
    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let hash = hasher.finalize();
    let code_challenge = URL_SAFE_NO_PAD.encode(hash);

    // Generate random state
    let state: String = (0..32)
        .map(|_| {
            let idx = rand::random::<u8>() % 36;
            if idx < 10 {
                (b'0' + idx) as char
            } else {
                (b'a' + idx - 10) as char
            }
        })
        .collect();

    let auth_url = format!(
        "{}/authorize?client_id=dispatch-desktop&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        api_url,
        urlencoding::encode("dispatch://oauth/callback"),
        urlencoding::encode("openid profile email api:read api:write"),
        code_challenge,
        state
    );

    let oauth_state = OAuthState {
        code_verifier,
        state,
    };

    (auth_url, oauth_state)
}

/// Exchange authorization code for tokens.
pub async fn exchange_code(
    api_url: &str,
    code: &str,
    oauth_state: &OAuthState,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let token_url = format!("{}/token", api_url);

    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", "dispatch://oauth/callback"),
        ("client_id", "dispatch-desktop"),
        ("code_verifier", &oauth_state.code_verifier),
    ];

    let resp = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed ({}): {}", status, body));
    }

    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

/// Fetch user info using access token.
pub async fn fetch_userinfo(
    api_url: &str,
    access_token: &str,
) -> Result<UserInfo, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/userinfo", api_url);

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| format!("Userinfo request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Userinfo request failed: {}", resp.status()));
    }

    resp.json::<UserInfo>()
        .await
        .map_err(|e| format!("Failed to parse userinfo: {}", e))
}

/// Refresh an expired access token.
pub async fn refresh_access_token(
    api_url: &str,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let token_url = format!("{}/token", api_url);

    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", "dispatch-desktop"),
    ];

    let resp = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token refresh failed: {}", body));
    }

    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {}", e))
}

/// Load v2 Yapture config from DB settings + in-memory token.
pub async fn load_v2_config(pool: &sqlx::SqlitePool, service_token: Option<String>) -> Option<YaptureConfig> {
    let enabled = crate::db::get_setting(pool, "yapture_v2_enabled").await.ok()?;
    if enabled.as_deref() != Some("1") { return None; }
    let api_url = crate::db::get_setting(pool, "yapture_v2_api_url").await.ok()??;
    if api_url.is_empty() { return None; }
    let user_id = crate::db::get_setting(pool, "yapture_v2_user_id").await.ok()??;
    if user_id.is_empty() { return None; }
    let service_token = match service_token {
        Some(t) if !t.is_empty() => t,
        _ => return None,
    };
    Some(YaptureConfig { enabled: true, api_url, user_id, service_token })
}

/// Generate PKCE + authorization URL for v2 auth service.
/// v2 uses BetterAuth at {auth_url}/api/auth/oauth2/authorize
pub fn start_oauth_flow_v2(auth_url: &str) -> (String, OAuthState) {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use sha2::{Digest, Sha256};

    let code_verifier: String = (0..64)
        .map(|_| {
            let idx = rand::random::<u8>() % 66;
            let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
            chars[idx as usize] as char
        })
        .collect();

    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());

    let state: String = (0..32)
        .map(|_| {
            let idx = rand::random::<u8>() % 36;
            if idx < 10 { (b'0' + idx) as char } else { (b'a' + idx - 10) as char }
        })
        .collect();

    let url = format!(
        "{}/api/auth/oauth2/authorize?client_id=dispatch-desktop&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        auth_url,
        urlencoding::encode("dispatch://oauth/callback"),
        urlencoding::encode("openid profile email api:read api:write"),
        code_challenge,
        state
    );

    (url, OAuthState { code_verifier, state })
}

/// Exchange authorization code for tokens via v2 auth service.
pub async fn exchange_code_v2(
    auth_url: &str,
    code: &str,
    oauth_state: &OAuthState,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let token_url = format!("{}/api/auth/oauth2/token", auth_url);

    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", "dispatch://oauth/callback"),
        ("client_id", "dispatch-desktop"),
        ("code_verifier", &oauth_state.code_verifier),
    ];

    let resp = client.post(&token_url).form(&params).send().await
        .map_err(|e| format!("v2 token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("v2 token exchange failed ({}): {}", status, body));
    }

    resp.json::<TokenResponse>().await
        .map_err(|e| format!("Failed to parse v2 token response: {}", e))
}

/// Detect Yapture API version by probing endpoints.
/// Returns V2 if /api/v2/health responds, otherwise V1.
pub async fn detect_version(api_url: &str) -> YaptureVersion {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    let v2_url = format!("{}/api/v2/health", api_url);
    match client.get(&v2_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            crate::log::log("[yapture] detected API version: v2");
            YaptureVersion::V2
        }
        _ => {
            crate::log::log("[yapture] detected API version: v1");
            YaptureVersion::V1
        }
    }
}
