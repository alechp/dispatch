use parking_lot::RwLock;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::models::Notification;
use crate::trigger_cache::TriggerEntry;

pub struct AppState {
    pub db: SqlitePool,
    pub tx: broadcast::Sender<Notification>,
    pub live_expansion_enabled: Arc<AtomicBool>,
    pub trigger_cache: Arc<RwLock<Vec<TriggerEntry>>>,
    pub oauth_pending: std::sync::Mutex<Option<crate::yapture::OAuthState>>,
    pub yapture_tokens: std::sync::Mutex<YaptureTokens>,
    /// Maps global shortcut string (e.g. "CommandOrControl+Shift+D") → action name
    pub global_shortcut_map: Arc<RwLock<HashMap<String, String>>>,
}

#[derive(Default)]
pub struct YaptureTokens {
    pub service_token: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            db,
            tx,
            live_expansion_enabled: Arc::new(AtomicBool::new(false)),
            trigger_cache: Arc::new(RwLock::new(Vec::new())),
            oauth_pending: std::sync::Mutex::new(None),
            yapture_tokens: std::sync::Mutex::new(YaptureTokens::default()),
            global_shortcut_map: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}
