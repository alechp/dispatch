//! Discord Gateway WebSocket client.
//!
//! Connects to Discord's Gateway API, handles heartbeating, identifies with a
//! bot token, and inserts MESSAGE_CREATE events into the relay SQLite database
//! for all registered Discord users to poll.

use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use sqlx::SqlitePool;
use tokio::time::{self, Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::db;

// Gateway URL (API v10, JSON encoding)
const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=10&encoding=json";

// Opcodes
const OP_DISPATCH: u64 = 0;
const OP_HEARTBEAT: u64 = 1;
const OP_IDENTIFY: u64 = 2;
const OP_RESUME: u64 = 6;
const OP_RECONNECT: u64 = 7;
const OP_INVALID_SESSION: u64 = 9;
const OP_HELLO: u64 = 10;
const OP_HEARTBEAT_ACK: u64 = 11;

// Intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS: u64 = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/// Fatal errors that should not be retried.
const FATAL_CLOSE_CODES: &[u16] = &[
    4004, // Authentication failed
    4014, // Disallowed intents
];

/// Entry point: runs the gateway connection loop forever, reconnecting on errors.
pub async fn run_gateway(pool: SqlitePool, bot_token: String) {
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(60);

    // Resume state
    let mut session_id: Option<String> = None;
    let mut resume_gateway_url: Option<String> = None;
    let mut last_sequence: Option<u64> = None;

    loop {
        let url = resume_gateway_url
            .clone()
            .unwrap_or_else(|| GATEWAY_URL.to_string());

        eprintln!("[discord-gateway] connecting to {}", url);

        match run_session(&pool, &bot_token, &url, &mut session_id, &mut resume_gateway_url, &mut last_sequence).await {
            SessionResult::Fatal(reason) => {
                eprintln!("[discord-gateway] FATAL: {} — stopping", reason);
                return;
            }
            SessionResult::ReconnectFresh => {
                session_id = None;
                resume_gateway_url = None;
                last_sequence = None;
                eprintln!("[discord-gateway] reconnecting fresh after {}s", backoff.as_secs());
            }
            SessionResult::ReconnectResume => {
                eprintln!("[discord-gateway] reconnecting (resume) after {}s", backoff.as_secs());
            }
        }

        // Apply backoff with jitter
        let jitter = rand::thread_rng().gen_range(0..1000);
        tokio::time::sleep(backoff + Duration::from_millis(jitter)).await;

        // Exponential backoff
        backoff = (backoff * 2).min(max_backoff);
    }
}

enum SessionResult {
    Fatal(String),
    ReconnectFresh,
    ReconnectResume,
}

async fn run_session(
    pool: &SqlitePool,
    bot_token: &str,
    url: &str,
    session_id: &mut Option<String>,
    resume_gateway_url: &mut Option<String>,
    last_sequence: &mut Option<u64>,
) -> SessionResult {
    // Connect
    let (ws_stream, _response) = match connect_async(url).await {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("[discord-gateway] connection failed: {}", e);
            return SessionResult::ReconnectFresh;
        }
    };

    let (mut sink, mut stream) = ws_stream.split();

    // Wait for HELLO
    let heartbeat_interval = match wait_for_hello(&mut stream).await {
        Some(interval) => interval,
        None => {
            eprintln!("[discord-gateway] did not receive HELLO");
            return SessionResult::ReconnectFresh;
        }
    };

    eprintln!("[discord-gateway] received HELLO, heartbeat_interval={}ms", heartbeat_interval);

    // Send IDENTIFY or RESUME
    if let Some(sid) = session_id.as_ref() {
        let resume_payload = serde_json::json!({
            "op": OP_RESUME,
            "d": {
                "token": bot_token,
                "session_id": sid,
                "seq": *last_sequence,
            }
        });
        if let Err(e) = sink.send(Message::Text(resume_payload.to_string())).await {
            eprintln!("[discord-gateway] failed to send RESUME: {}", e);
            return SessionResult::ReconnectFresh;
        }
        eprintln!("[discord-gateway] sent RESUME");
    } else {
        let identify_payload = serde_json::json!({
            "op": OP_IDENTIFY,
            "d": {
                "token": bot_token,
                "intents": INTENTS,
                "properties": {
                    "os": "linux",
                    "browser": "dispatch-relay",
                    "device": "dispatch-relay",
                }
            }
        });
        if let Err(e) = sink.send(Message::Text(identify_payload.to_string())).await {
            eprintln!("[discord-gateway] failed to send IDENTIFY: {}", e);
            return SessionResult::ReconnectFresh;
        }
        eprintln!("[discord-gateway] sent IDENTIFY");
    }

    // Main loop: heartbeat + dispatch
    let heartbeat_dur = Duration::from_millis(heartbeat_interval);
    let mut heartbeat_deadline = Instant::now() + heartbeat_dur;
    let mut ack_received = true;

    loop {
        tokio::select! {
            // Heartbeat timer
            _ = time::sleep_until(heartbeat_deadline) => {
                if !ack_received {
                    eprintln!("[discord-gateway] zombie connection (no ACK), reconnecting");
                    return SessionResult::ReconnectResume;
                }

                let hb = serde_json::json!({
                    "op": OP_HEARTBEAT,
                    "d": *last_sequence,
                });
                if let Err(e) = sink.send(Message::Text(hb.to_string())).await {
                    eprintln!("[discord-gateway] heartbeat send failed: {}", e);
                    return SessionResult::ReconnectResume;
                }
                ack_received = false;
                heartbeat_deadline = Instant::now() + heartbeat_dur;
            }

            // Incoming messages
            msg = stream.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => {
                        eprintln!("[discord-gateway] ws error: {}", e);
                        return SessionResult::ReconnectResume;
                    }
                    None => {
                        eprintln!("[discord-gateway] ws stream ended");
                        return SessionResult::ReconnectResume;
                    }
                };

                match msg {
                    Message::Text(text) => {
                        let payload: serde_json::Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                eprintln!("[discord-gateway] invalid JSON: {}", e);
                                continue;
                            }
                        };

                        let op = payload["op"].as_u64().unwrap_or(99);
                        let seq = payload["s"].as_u64();
                        if let Some(s) = seq {
                            *last_sequence = Some(s);
                        }

                        match op {
                            OP_DISPATCH => {
                                let event_name = payload["t"].as_str().unwrap_or("");

                                if event_name == "READY" {
                                    let d = &payload["d"];
                                    *session_id = d["session_id"].as_str().map(|s| s.to_string());
                                    *resume_gateway_url = d["resume_gateway_url"].as_str().map(|s| s.to_string());
                                    eprintln!("[discord-gateway] READY session_id={:?}", session_id);
                                } else if event_name == "RESUMED" {
                                    eprintln!("[discord-gateway] RESUMED successfully");
                                } else if event_name == "MESSAGE_CREATE" {
                                    handle_message_create(pool, &payload["d"]).await;
                                }
                            }
                            OP_HEARTBEAT => {
                                // Server requests immediate heartbeat
                                let hb = serde_json::json!({
                                    "op": OP_HEARTBEAT,
                                    "d": *last_sequence,
                                });
                                let _ = sink.send(Message::Text(hb.to_string())).await;
                            }
                            OP_HEARTBEAT_ACK => {
                                ack_received = true;
                            }
                            OP_RECONNECT => {
                                eprintln!("[discord-gateway] server requested RECONNECT");
                                return SessionResult::ReconnectResume;
                            }
                            OP_INVALID_SESSION => {
                                let resumable = payload["d"].as_bool().unwrap_or(false);
                                // Wait 1-5s as Discord recommends
                                let delay = rand::thread_rng().gen_range(1000..5000);
                                tokio::time::sleep(Duration::from_millis(delay)).await;
                                if resumable {
                                    eprintln!("[discord-gateway] INVALID_SESSION (resumable)");
                                    return SessionResult::ReconnectResume;
                                } else {
                                    eprintln!("[discord-gateway] INVALID_SESSION (not resumable)");
                                    *session_id = None;
                                    *resume_gateway_url = None;
                                    *last_sequence = None;
                                    return SessionResult::ReconnectFresh;
                                }
                            }
                            _ => {}
                        }
                    }
                    Message::Close(frame) => {
                        let code = frame.as_ref().map(|f| f.code.into()).unwrap_or(0u16);
                        let reason = frame.as_ref().map(|f| f.reason.to_string()).unwrap_or_default();
                        eprintln!("[discord-gateway] closed: code={} reason={}", code, reason);

                        if FATAL_CLOSE_CODES.contains(&code) {
                            return SessionResult::Fatal(format!("close code {}: {}", code, reason));
                        }
                        return SessionResult::ReconnectFresh;
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Wait for the HELLO opcode and return heartbeat_interval.
async fn wait_for_hello(
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
) -> Option<u64> {
    // Give it up to 10 seconds
    let timeout = Duration::from_secs(10);
    let result = tokio::time::timeout(timeout, async {
        while let Some(msg) = stream.next().await {
            if let Ok(Message::Text(text)) = msg {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&text) {
                    if payload["op"].as_u64() == Some(OP_HELLO) {
                        return payload["d"]["heartbeat_interval"].as_u64();
                    }
                }
            }
        }
        None
    })
    .await;

    match result {
        Ok(interval) => interval,
        Err(_) => None,
    }
}

/// Handle a MESSAGE_CREATE dispatch: insert event for all registered Discord users.
async fn handle_message_create(pool: &SqlitePool, data: &serde_json::Value) {
    // Skip bot messages
    if data["author"]["bot"].as_bool().unwrap_or(false) {
        return;
    }

    let channel_id = data["channel_id"].as_str().unwrap_or("");
    let author_name = data["author"]["username"].as_str().unwrap_or("unknown");
    let author_avatar = data["author"]["avatar"].as_str().map(|hash| {
        let user_id = data["author"]["id"].as_str().unwrap_or("");
        format!("https://cdn.discordapp.com/avatars/{}/{}.png", user_id, hash)
    });
    let content = data["content"].as_str().unwrap_or("");
    let timestamp = data["timestamp"].as_str().unwrap_or("");

    let raw_json = serde_json::to_string(data).unwrap_or_default();

    // Get all registered Discord user IDs
    let user_ids = match db::get_all_discord_user_ids(pool).await {
        Ok(ids) => ids,
        Err(e) => {
            eprintln!("[discord-gateway] failed to get discord user ids: {}", e);
            return;
        }
    };

    for user_id in &user_ids {
        if let Err(e) = db::insert_event(
            pool,
            user_id,
            "message",
            Some(channel_id),
            None, // channel_name — we don't have it without extra API calls
            Some(author_name),
            author_avatar.as_deref(),
            Some(content),
            Some(timestamp),
            &raw_json,
        )
        .await
        {
            eprintln!("[discord-gateway] insert_event failed for user {}: {}", user_id, e);
        }
    }
}
