use std::sync::Arc;

use axum::{
    extract::{Path, Query, State, WebSocketUpgrade},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use tower_http::cors::CorsLayer;

use crate::db;
use crate::models::{CreateNotificationRequest, NotificationResponse, QueryParams};
use crate::state::AppState;

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/notifications", post(create_notification))
        .route("/api/notifications", get(list_notifications))
        .route("/api/notifications/:id/read", post(mark_read))
        .route("/api/notifications/read-all", post(mark_all_read))
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn create_notification(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateNotificationRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let notification = db::insert_notification(&state.db, &req)
        .await
        .map_err(|e| {
            eprintln!("DB insert error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    // Broadcast to all listeners (WebSocket + Tauri events)
    let _ = state.tx.send(notification.clone());

    Ok((StatusCode::CREATED, Json(notification)))
}

async fn list_notifications(
    State(state): State<Arc<AppState>>,
    Query(params): Query<QueryParams>,
) -> Result<Json<NotificationResponse>, StatusCode> {
    let (notifications, total) = db::query_notifications(&state.db, &params)
        .await
        .map_err(|e| {
            eprintln!("DB query error: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    Ok(Json(NotificationResponse {
        notifications,
        total,
    }))
}

async fn mark_read(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let updated = db::mark_read(&state.db, &id).await.map_err(|e| {
        eprintln!("DB mark_read error: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    if updated {
        Ok(StatusCode::OK)
    } else {
        Ok(StatusCode::NOT_FOUND)
    }
}

async fn mark_all_read(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, StatusCode> {
    let count = db::mark_all_read(&state.db).await.map_err(|e| {
        eprintln!("DB mark_all_read error: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(Json(serde_json::json!({ "marked": count })))
}

async fn ws_handler(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        let mut rx = state.tx.subscribe();
        let (mut sender, mut receiver) = socket.split();

        let send_task = tokio::spawn(async move {
            while let Ok(notification) = rx.recv().await {
                if let Ok(json) = serde_json::to_string(&notification) {
                    if sender
                        .send(axum::extract::ws::Message::Text(json.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        });

        // Keep reading to detect client disconnect
        let recv_task = tokio::spawn(async move {
            while let Some(Ok(_)) = receiver.next().await {}
        });

        tokio::select! {
            _ = send_task => {},
            _ = recv_task => {},
        }
    })
}
