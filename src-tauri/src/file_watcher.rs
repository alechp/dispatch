use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::{Mutex, RwLock};
use sqlx::SqlitePool;
use tokio::sync::mpsc;

use crate::trigger_cache::TriggerEntry;

/// Handle returned by `start_file_watcher` that allows callers to
/// update the set of watched paths or shut down the watcher entirely.
#[derive(Clone)]
pub struct FileWatcherHandle {
    /// Send commands to the background watcher loop.
    cmd_tx: mpsc::UnboundedSender<WatcherCommand>,
}

enum WatcherCommand {
    /// Re-query snippet_sources and update watched paths.
    UpdateWatches,
    /// Shut down the watcher.
    Stop,
}

impl FileWatcherHandle {
    /// Re-query the `snippet_sources` table and update watched paths.
    /// The pool is not needed here because the background task already
    /// holds a clone; we just signal it to re-query.
    pub fn update_watches(&self, _pool: &SqlitePool) {
        let _ = self.cmd_tx.send(WatcherCommand::UpdateWatches);
    }

    /// Shut down the file watcher background task.
    pub fn stop(&self) {
        let _ = self.cmd_tx.send(WatcherCommand::Stop);
    }
}

/// Internal struct that owns the `notify` watcher and tracks state.
struct FileWatcher {
    watcher: RecommendedWatcher,
    watched_paths: HashSet<PathBuf>,
}

impl FileWatcher {
    fn new(event_tx: std::sync::mpsc::Sender<Event>) -> Result<Self, notify::Error> {
        let watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = event_tx.send(event);
            }
        })?;

        Ok(Self {
            watcher,
            watched_paths: HashSet::new(),
        })
    }

    /// Add a path to the watch set. Returns true if the path was newly added.
    fn watch(&mut self, path: &PathBuf) -> bool {
        if self.watched_paths.contains(path) {
            return false;
        }
        match self.watcher.watch(path, RecursiveMode::NonRecursive) {
            Ok(()) => {
                eprintln!("[file-watcher] watching: {}", path.display());
                self.watched_paths.insert(path.clone());
                true
            }
            Err(e) => {
                eprintln!(
                    "[file-watcher] failed to watch {}: {}",
                    path.display(),
                    e
                );
                false
            }
        }
    }

    /// Remove a path from the watch set.
    fn unwatch(&mut self, path: &PathBuf) {
        if self.watched_paths.remove(path) {
            if let Err(e) = self.watcher.unwatch(path) {
                eprintln!(
                    "[file-watcher] failed to unwatch {}: {}",
                    path.display(),
                    e
                );
            } else {
                eprintln!("[file-watcher] unwatched: {}", path.display());
            }
        }
    }

    /// Synchronize watches to match the given set of desired paths.
    /// Adds new paths and removes stale ones.
    fn sync_watches(&mut self, desired: &HashSet<PathBuf>) {
        // Remove paths that are no longer desired
        let to_remove: Vec<PathBuf> = self
            .watched_paths
            .difference(desired)
            .cloned()
            .collect();
        for path in &to_remove {
            self.unwatch(path);
        }

        // Add paths that are newly desired
        let to_add: Vec<PathBuf> = desired
            .difference(&self.watched_paths)
            .cloned()
            .collect();
        for path in &to_add {
            self.watch(path);
        }
    }
}

/// Query the database for enabled snippet sources with valid file paths,
/// and return the set of paths that should be watched.
async fn query_watchable_paths(pool: &SqlitePool) -> HashSet<PathBuf> {
    let sources = match crate::db::list_snippet_sources(pool).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[file-watcher] failed to query snippet_sources: {}", e);
            return HashSet::new();
        }
    };

    let mut paths = HashSet::new();
    for source in &sources {
        // Only watch enabled sources with auto_reload on
        if source.is_enabled == 0 || source.auto_reload == 0 {
            continue;
        }

        let path = PathBuf::from(&source.path);
        if source.is_folder == 1 {
            // For folder sources, watch the folder itself
            if path.is_dir() {
                paths.insert(path);
            } else {
                eprintln!(
                    "[file-watcher] folder source path does not exist: {}",
                    source.path
                );
            }
        } else {
            // For file sources, watch the parent directory so we get
            // create/rename events (editors often write to a temp file
            // and then rename). But we track the file path for filtering.
            if path.exists() {
                // Watch the file directly
                paths.insert(path);
            } else {
                eprintln!(
                    "[file-watcher] file source path does not exist: {}",
                    source.path
                );
            }
        }
    }

    paths
}

/// Debounce state: tracks the last event time per path so we can
/// avoid re-syncing on partial writes.
struct DebounceState {
    last_event: std::collections::HashMap<PathBuf, Instant>,
    debounce_duration: Duration,
}

impl DebounceState {
    fn new(debounce_ms: u64) -> Self {
        Self {
            last_event: std::collections::HashMap::new(),
            debounce_duration: Duration::from_millis(debounce_ms),
        }
    }

    /// Record an event for a path. Returns true if the event should be
    /// processed (i.e., enough time has passed since the last event).
    fn should_process(&mut self, path: &PathBuf) -> bool {
        let now = Instant::now();
        if let Some(last) = self.last_event.get(path) {
            if now.duration_since(*last) < self.debounce_duration {
                return false;
            }
        }
        self.last_event.insert(path.clone(), now);
        true
    }
}

/// Start the file watcher background system.
///
/// This spawns a tokio task that:
/// 1. Queries `snippet_sources` for enabled sources with valid file paths
/// 2. Watches those paths using the `notify` crate
/// 3. On file change (debounced at 300ms), logs the change. The actual
///    re-sync call will be wired up by the integration layer.
/// 4. Responds to commands to update watches or stop.
///
/// Returns a `FileWatcherHandle` that can be used to control the watcher.
pub fn start_file_watcher(
    pool: SqlitePool,
    trigger_cache: Arc<RwLock<Vec<TriggerEntry>>>,
) -> FileWatcherHandle {
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<WatcherCommand>();
    let handle = FileWatcherHandle {
        cmd_tx: cmd_tx.clone(),
    };

    // Channel for notify events (std::sync::mpsc since notify requires Send)
    let (event_tx, event_rx) = std::sync::mpsc::channel::<Event>();

    // Shared debounce state
    let debounce = Arc::new(Mutex::new(DebounceState::new(300)));

    tokio::spawn(async move {
        eprintln!("[file-watcher] starting file watcher task");

        // Create the notify watcher on a blocking thread since it may
        // involve OS setup.
        let watcher_result = tokio::task::spawn_blocking({
            move || FileWatcher::new(event_tx)
        })
        .await;

        let watcher = match watcher_result {
            Ok(Ok(w)) => Arc::new(Mutex::new(w)),
            Ok(Err(e)) => {
                eprintln!("[file-watcher] failed to create watcher: {}", e);
                return;
            }
            Err(e) => {
                eprintln!("[file-watcher] spawn_blocking failed: {}", e);
                return;
            }
        };

        // Initial watch setup
        {
            let desired = query_watchable_paths(&pool).await;
            let mut w = watcher.lock();
            w.sync_watches(&desired);
            eprintln!(
                "[file-watcher] initial setup: watching {} paths",
                desired.len()
            );
        }

        // Spawn a task to poll the std::sync::mpsc receiver and forward
        // events into the async world.
        let (async_event_tx, mut async_event_rx) = mpsc::unbounded_channel::<Event>();
        tokio::task::spawn_blocking({
            let async_event_tx = async_event_tx;
            move || {
                while let Ok(event) = event_rx.recv() {
                    if async_event_tx.send(event).is_err() {
                        break;
                    }
                }
            }
        });

        // Main loop: process commands and file events
        loop {
            tokio::select! {
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(WatcherCommand::UpdateWatches) => {
                            eprintln!("[file-watcher] updating watches");
                            let desired = query_watchable_paths(&pool).await;
                            let mut w = watcher.lock();
                            w.sync_watches(&desired);
                            eprintln!(
                                "[file-watcher] watches updated: {} paths",
                                desired.len()
                            );
                        }
                        Some(WatcherCommand::Stop) | None => {
                            eprintln!("[file-watcher] stopping");
                            break;
                        }
                    }
                }
                event = async_event_rx.recv() => {
                    match event {
                        Some(event) => {
                            handle_file_event(
                                &event,
                                &pool,
                                &trigger_cache,
                                &debounce,
                            ).await;
                        }
                        None => {
                            // Event channel closed (watcher dropped)
                            eprintln!("[file-watcher] event channel closed");
                            break;
                        }
                    }
                }
            }
        }

        eprintln!("[file-watcher] file watcher task exiting");
    });

    handle
}

/// Handle a single file system event. Debounces and logs changes.
async fn handle_file_event(
    event: &Event,
    pool: &SqlitePool,
    trigger_cache: &Arc<RwLock<Vec<TriggerEntry>>>,
    debounce: &Arc<Mutex<DebounceState>>,
) {
    // We only care about modifications and creates (editors may
    // delete + create on save).
    let is_relevant = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_));
    if !is_relevant {
        return;
    }

    for path in &event.paths {
        // Debounce: skip if we recently processed this path
        {
            let mut db = debounce.lock();
            if !db.should_process(&path.to_path_buf()) {
                continue;
            }
        }

        eprintln!(
            "[file-watcher] change detected: {} ({:?})",
            path.display(),
            event.kind
        );

        // Find which source(s) this path belongs to and re-sync
        let path_str = path.to_string_lossy().to_string();
        let sources = match crate::db::list_snippet_sources(pool).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[file-watcher] failed to query sources: {}", e);
                continue;
            }
        };

        let mut synced_any = false;
        for source in &sources {
            if source.is_enabled == 0 || source.auto_reload == 0 {
                continue;
            }

            let source_path = PathBuf::from(&source.path);
            let matches = if source.is_folder == 1 {
                // For folder sources, check if the changed file is inside
                path.starts_with(&source_path)
            } else {
                // For file sources, check exact match
                *path == source_path
            };

            if matches {
                eprintln!(
                    "[file-watcher] re-syncing source '{}' (id={}) due to change in {}",
                    source.name, source.id, path_str
                );

                // Perform the sync. We call the file_parser + db pipeline
                // directly here since we have the pool.
                match do_sync_source(pool, &source).await {
                    Ok(result) => {
                        eprintln!(
                            "[file-watcher] sync complete for '{}': +{} ~{} -{} (errors: {})",
                            source.name,
                            result.added,
                            result.updated,
                            result.removed,
                            result.errors.len()
                        );
                        synced_any = true;
                    }
                    Err(e) => {
                        eprintln!(
                            "[file-watcher] sync failed for '{}': {}",
                            source.name, e
                        );
                    }
                }
            }
        }

        // Refresh trigger cache if any source was synced
        if synced_any {
            if let Err(e) =
                crate::trigger_cache::refresh_trigger_cache(pool, trigger_cache).await
            {
                eprintln!("[file-watcher] failed to refresh trigger cache: {}", e);
            }
        }
    }
}

/// Internal sync implementation mirroring `commands::sync_source_internal`.
/// This is duplicated here to avoid circular dependencies with the commands
/// module. The integration layer may replace this with a shared function.
async fn do_sync_source(
    pool: &SqlitePool,
    source: &crate::models::SnippetSource,
) -> Result<crate::models::SyncResult, String> {
    use crate::file_parser;

    let mut result = crate::models::SyncResult {
        added: 0,
        updated: 0,
        removed: 0,
        errors: vec![],
    };
    let path = std::path::Path::new(&source.path);

    let configs = if source.is_folder == 1 {
        file_parser::parse_expansion_folder(path)?
    } else {
        let config = file_parser::parse_expansion_file(path)?;
        vec![(source.name.clone(), config)]
    };

    let mut active_triggers = Vec::new();

    for (_filename, config) in &configs {
        for snippet in &config.snippets {
            let tags = file_parser::tags_to_json(&snippet.tags);
            let vars = file_parser::variables_to_json(&snippet.variables);
            match crate::db::upsert_source_snippet(
                pool,
                &source.id,
                &snippet.trigger,
                snippet.label.as_deref(),
                &snippet.body,
                tags.as_deref(),
                vars.as_deref(),
            )
            .await
            {
                Ok(crate::db::SnippetUpsertOutcome::Inserted) => {
                    active_triggers.push(snippet.trigger.clone());
                    result.added += 1;
                }
                Ok(crate::db::SnippetUpsertOutcome::Updated) => {
                    active_triggers.push(snippet.trigger.clone());
                    result.updated += 1;
                }
                Ok(crate::db::SnippetUpsertOutcome::SkippedConflict) => {
                    // Trigger exists under a different source; skip
                }
                Err(e) => {
                    result
                        .errors
                        .push(format!("Failed to upsert {}: {}", snippet.trigger, e));
                }
            }
        }
    }

    // Remove snippets that no longer exist in the source files
    let removed = crate::db::remove_stale_source_snippets(pool, &source.id, &active_triggers)
        .await
        .map_err(|e| e.to_string())?;
    result.removed = removed;

    // Update last_synced_at
    let _ = crate::db::update_snippet_source_synced(pool, &source.id).await;

    Ok(result)
}
