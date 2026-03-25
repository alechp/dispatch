use parking_lot::RwLock;
use sqlx::SqlitePool;
use std::sync::Arc;

use crate::models::VariableDef;

#[derive(Debug, Clone)]
pub struct TriggerEntry {
    pub snippet_id: String,
    pub trigger: String,
    pub has_interactive_vars: bool,
}

pub async fn refresh_trigger_cache(
    pool: &SqlitePool,
    cache: &Arc<RwLock<Vec<TriggerEntry>>>,
) -> Result<(), sqlx::Error> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, trigger, variables FROM snippets WHERE is_enabled = 1",
    )
    .fetch_all(pool)
    .await?;

    let mut entries: Vec<TriggerEntry> = rows
        .into_iter()
        .map(|(id, trigger, variables)| {
            let has_interactive = variables
                .as_deref()
                .and_then(|v| serde_json::from_str::<Vec<VariableDef>>(v).ok())
                .map(|vars| {
                    vars.iter()
                        .any(|v| v.var_type == "form" || v.var_type == "choice")
                })
                .unwrap_or(false);

            TriggerEntry {
                snippet_id: id,
                trigger,
                has_interactive_vars: has_interactive,
            }
        })
        .collect();

    // Sort longest trigger first to prevent partial matches
    entries.sort_by(|a, b| b.trigger.len().cmp(&a.trigger.len()));

    let mut guard = cache.write();
    *guard = entries;
    Ok(())
}

pub fn match_trigger(
    buffer: &str,
    cache: &Arc<RwLock<Vec<TriggerEntry>>>,
) -> Option<TriggerEntry> {
    let guard = cache.read();
    for entry in guard.iter() {
        if !entry.has_interactive_vars && buffer.ends_with(&entry.trigger) {
            return Some(entry.clone());
        }
    }
    None
}
