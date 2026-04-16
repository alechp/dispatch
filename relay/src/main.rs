mod db;
mod routes;

use std::sync::Arc;

use axum::routing::{get, post};
use sqlx::sqlite::SqlitePoolOptions;

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    let db_path = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite:relay.db?mode=rwc".to_string());
    let signing_secret =
        std::env::var("SLACK_SIGNING_SECRET").unwrap_or_default();

    eprintln!("[relay] connecting to {}", db_path);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_path)
        .await
        .expect("Failed to connect to SQLite");

    db::init_db(&pool)
        .await
        .expect("Failed to initialize database");

    let state = Arc::new(routes::AppState {
        pool,
        signing_secret,
    });

    let app = axum::Router::new()
        .route("/health", get(routes::health))
        .route("/slack/events", post(routes::slack_events))
        .route("/api/register", post(routes::register_user))
        .route("/api/poll", get(routes::poll_events))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    eprintln!("[relay] listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");
    axum::serve(listener, app).await.unwrap();
}
