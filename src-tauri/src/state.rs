use sqlx::SqlitePool;
use tokio::sync::broadcast;

use crate::models::Notification;

pub struct AppState {
    pub db: SqlitePool,
    pub tx: broadcast::Sender<Notification>,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { db, tx }
    }
}
