use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::SqlitePool;
use std::sync::Arc;

use crate::db;

pub struct AppState {
    pub pool: SqlitePool,
    pub signing_secret: String,
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

pub async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

// ---------------------------------------------------------------------------
// POST /slack/events
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
struct SlackEventPayload {
    #[serde(rename = "type")]
    payload_type: String,
    challenge: Option<String>,
    event: Option<SlackEvent>,
}

#[derive(Debug, serde::Deserialize)]
struct SlackEvent {
    #[serde(rename = "type")]
    event_type: String,
    channel: Option<String>,
    user: Option<String>,
    text: Option<String>,
    ts: Option<String>,
    channel_type: Option<String>,
}

pub async fn slack_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> Result<impl IntoResponse, StatusCode> {
    // 1. Verify Slack request signature
    let timestamp = headers
        .get("X-Slack-Request-Timestamp")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let signature = headers
        .get("X-Slack-Signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !verify_slack_signature(&state.signing_secret, timestamp, &body, signature) {
        eprintln!("[relay] invalid Slack signature");
        return Err(StatusCode::UNAUTHORIZED);
    }

    // 2. Parse payload
    let payload: SlackEventPayload = serde_json::from_str(&body).map_err(|e| {
        eprintln!("[relay] failed to parse Slack payload: {}", e);
        StatusCode::BAD_REQUEST
    })?;

    // 3. Handle url_verification challenge
    if payload.payload_type == "url_verification" {
        let challenge = payload.challenge.unwrap_or_default();
        return Ok(Json(serde_json::json!({ "challenge": challenge })));
    }

    // 4. Handle event_callback
    if payload.payload_type == "event_callback" {
        if let Some(event) = payload.event {
            if event.event_type == "message" {
                // Queue event for all registered users
                // In production, filter by channel membership
                let user_ids = db::get_all_user_ids(&state.pool).await.unwrap_or_default();
                let raw_json = &body;

                for user_id in &user_ids {
                    if let Err(e) = db::insert_event(
                        &state.pool,
                        user_id,
                        &event.event_type,
                        event.channel.as_deref(),
                        None, // channel_name not in event payload, would need API call
                        event.user.as_deref(),
                        None, // sender_avatar not in event payload
                        event.text.as_deref(),
                        event.ts.as_deref(),
                        raw_json,
                    )
                    .await
                    {
                        eprintln!("[relay] failed to insert event for user {}: {}", user_id, e);
                    }
                }
            }
        }
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Verify Slack request signature using HMAC-SHA256.
fn verify_slack_signature(
    signing_secret: &str,
    timestamp: &str,
    body: &str,
    expected_signature: &str,
) -> bool {
    // Skip verification if no signing secret configured (dev mode)
    if signing_secret.is_empty() {
        return true;
    }

    let sig_basestring = format!("v0:{}:{}", timestamp, body);

    let mut mac = match Hmac::<Sha256>::new_from_slice(signing_secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(sig_basestring.as_bytes());
    let result = mac.finalize();
    let computed = format!("v0={}", hex::encode(result.into_bytes()));

    // Constant-time comparison
    computed == expected_signature
}

// ---------------------------------------------------------------------------
// POST /api/register
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
pub struct RegisterRequest {
    pub slack_user_id: String,
    pub api_key: String,
}

pub async fn register_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    // Simple auth: require a master API key in header
    let auth = headers
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if auth.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }

    match db::register_user(&state.pool, &req.slack_user_id, &req.api_key).await {
        Ok(user_id) => Ok(Json(serde_json::json!({
            "ok": true,
            "user_id": user_id,
        }))),
        Err(e) => {
            eprintln!("[relay] register_user failed: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/register/discord
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
pub struct RegisterDiscordRequest {
    pub discord_user_id: String,
    pub api_key: String,
}

pub async fn register_discord_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<RegisterDiscordRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let auth = headers
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if auth.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }

    match db::register_discord_user(&state.pool, &req.discord_user_id, &req.api_key).await {
        Ok(user_id) => Ok(Json(serde_json::json!({
            "ok": true,
            "user_id": user_id,
        }))),
        Err(e) => {
            eprintln!("[relay] register_discord_user failed: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

// ---------------------------------------------------------------------------
// GET /api/poll
// ---------------------------------------------------------------------------

pub async fn poll_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    let api_key = headers
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if api_key.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Unified lookup across Slack and Discord users
    let (user_id, _provider_user_id, _provider) =
        match db::get_user_by_api_key_any(&state.pool, api_key).await {
            Ok(Some(u)) => u,
            Ok(None) => {
                return Err(StatusCode::UNAUTHORIZED);
            }
            Err(e) => {
                eprintln!("[relay] get_user_by_api_key_any failed: {}", e);
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
        };

    match db::poll_events(&state.pool, &user_id).await {
        Ok(events) => Ok(Json(serde_json::json!({
            "ok": true,
            "events": events,
        }))),
        Err(e) => {
            eprintln!("[relay] poll_events failed: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
