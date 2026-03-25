use serde::{Deserialize, Serialize};

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
        return None;
    }
    let api_url = crate::db::get_setting(pool, "yapture_api_url").await.ok()??;
    let user_id = crate::db::get_setting(pool, "yapture_user_id").await.ok()??;
    let service_token = service_token?;
    if api_url.is_empty() || user_id.is_empty() || service_token.is_empty() {
        return None;
    }
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
) {
    let client = reqwest::Client::new();
    let project = notification
        .project
        .as_deref()
        .unwrap_or(&notification.source);

    // Build task text: "[project] title" (append body if present, truncate to 500 chars)
    let mut text = format!("[{}] {}", project, notification.title);
    if let Some(body) = &notification.body {
        text.push_str(": ");
        text.push_str(body);
    }
    if text.len() > 500 {
        text.truncate(500);
    }

    // 1. Create task
    let task_url = format!("{}/api/tasks", config.api_url);
    let task_body = serde_json::json!({
        "text": text,
        "skipNLP": true
    });

    let task_result = client
        .post(&task_url)
        .header(
            "Authorization",
            format!("ServiceToken {}", config.service_token),
        )
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
                eprintln!("[yapture] task created: {}", id);
                id
            }
            Err(e) => {
                eprintln!("[yapture] failed to parse task response: {}", e);
                return;
            }
        },
        Ok(resp) => {
            eprintln!("[yapture] task creation failed: {}", resp.status());
            return;
        }
        Err(e) => {
            eprintln!("[yapture] task creation error: {}", e);
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
        .header(
            "Authorization",
            format!("ServiceToken {}", config.service_token),
        )
        .json(&webhook_body)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            eprintln!("[yapture] webhook notification sent");
        }
        Ok(resp) => {
            eprintln!("[yapture] webhook failed: {}", resp.status());
        }
        Err(e) => {
            eprintln!("[yapture] webhook error: {}", e);
        }
    }
}

/// Test connection to Yapture API
pub async fn test_connection(api_url: &str, service_token: &str) -> bool {
    let client = reqwest::Client::new();
    let url = format!("{}/api/webhooks/capswan/health", api_url);
    match client
        .get(&url)
        .header(
            "Authorization",
            format!("ServiceToken {}", service_token),
        )
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
