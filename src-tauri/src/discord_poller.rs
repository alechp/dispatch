//! Discord relay poller — periodically polls the relay server for new Discord
//! events and ingests them as Dispatch notifications.

use sqlx::SqlitePool;
use tokio::sync::{broadcast, watch};

use crate::models::{CreateNotificationRequest, Notification};
use crate::{db, dlog};

/// Event returned from the relay server's /api/poll endpoint.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DiscordRelayEvent {
    pub id: String,
    pub event_type: String,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub sender_name: Option<String>,
    pub sender_avatar: Option<String>,
    pub message_text: Option<String>,
    pub message_ts: Option<String>,
    pub raw_json: String,
    pub created_at: String,
}

#[derive(Debug, serde::Deserialize)]
struct PollResponse {
    ok: bool,
    events: Option<Vec<DiscordRelayEvent>>,
}

/// Start the polling loop. Returns a `watch::Sender<bool>` that can be used
/// to signal the loop to stop (send `true` to stop).
pub fn start_polling(
    pool: SqlitePool,
    tx: broadcast::Sender<Notification>,
    relay_url: String,
    api_key: String,
    interval_secs: u64,
    account_id: String,
) -> watch::Sender<bool> {
    let (stop_tx, mut stop_rx) = watch::channel(false);

    tokio::spawn(async move {
        let http = reqwest::Client::new();
        dlog!("[discord-poller] started: relay={}, interval={}s", relay_url, interval_secs);

        loop {
            // Check for stop signal
            if *stop_rx.borrow() {
                dlog!("[discord-poller] stop signal received, exiting");
                break;
            }

            // Poll relay
            match poll_once(&http, &relay_url, &api_key).await {
                Ok(events) => {
                    if !events.is_empty() {
                        dlog!("[discord-poller] received {} events", events.len());
                    }
                    for event in events {
                        if let Err(e) = ingest_event(&pool, &tx, &event, &account_id).await {
                            eprintln!("[discord-poller] ingest error: {}", e);
                        }
                    }
                    // Update last poll time
                    let _ = db::set_setting(&pool, "discord_relay_last_poll", &chrono::Utc::now().to_rfc3339()).await;
                }
                Err(e) => {
                    eprintln!("[discord-poller] poll error: {}", e);
                }
            }

            // Sleep with stop-signal awareness
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(interval_secs)) => {}
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        dlog!("[discord-poller] stop signal during sleep, exiting");
                        break;
                    }
                }
            }
        }

        dlog!("[discord-poller] loop exited");
    });

    stop_tx
}

/// Poll the relay server once for events.
async fn poll_once(
    http: &reqwest::Client,
    relay_url: &str,
    api_key: &str,
) -> Result<Vec<DiscordRelayEvent>, String> {
    let url = format!("{}/api/poll", relay_url.trim_end_matches('/'));

    let response = http
        .get(&url)
        .header("X-API-Key", api_key)
        .send()
        .await
        .map_err(|e| format!("relay poll request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("relay returned {}: {}", status, body));
    }

    let poll_response: PollResponse = response
        .json()
        .await
        .map_err(|e| format!("failed to parse poll response: {}", e))?;

    if !poll_response.ok {
        return Err("relay returned ok=false".to_string());
    }

    Ok(poll_response.events.unwrap_or_default())
}

/// Convert a relay event into a Dispatch notification and store it.
async fn ingest_event(
    pool: &SqlitePool,
    tx: &broadcast::Sender<Notification>,
    event: &DiscordRelayEvent,
    account_id: &str,
) -> Result<(), String> {
    let title = match &event.channel_name {
        Some(name) => format!("#{}", name),
        None => match &event.channel_id {
            Some(id) => format!("#{}", id),
            None => "Discord message".to_string(),
        },
    };

    // Discord content is plain text (no mrkdwn cleaning needed)
    let body = event.message_text.clone();

    // Discord timestamps are already ISO 8601 (no epoch conversion needed)
    let created_at = event
        .message_ts
        .as_deref()
        .unwrap_or(&event.created_at)
        .to_string();

    let req = CreateNotificationRequest {
        title: title.clone(),
        body,
        source: Some("discord-relay".to_string()),
        event_type: Some(event.event_type.clone()),
        metadata: Some(serde_json::json!({
            "relay_event_id": event.id,
            "created_at": created_at,
        })),
        project: None,
        tmux_session: None,
        tmux_window: None,
        tmux_pane: None,
    };

    let notification = db::insert_provider_notification(
        pool,
        &req,
        account_id,
        "discord",
        event.message_ts.as_deref(),
        event.channel_name.as_deref(),
        event.channel_id.as_deref(),
        event.sender_avatar.as_deref(),
        event.sender_name.as_deref(),
    )
    .await
    .map_err(|e| format!("db insert failed: {}", e))?;

    // Broadcast to Tauri event bridge
    let _ = tx.send(notification);

    Ok(())
}

/// Test connectivity to the relay server's /health endpoint.
pub async fn test_relay_connection(relay_url: &str) -> Result<(), String> {
    let http = reqwest::Client::new();
    let url = format!("{}/health", relay_url.trim_end_matches('/'));

    let response = http
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("relay connection failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("relay returned status {}", response.status()));
    }

    Ok(())
}
