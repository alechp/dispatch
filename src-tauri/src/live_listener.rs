use crossbeam_channel::Sender;
use parking_lot::RwLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::trigger_cache::{self, TriggerEntry};

const MAX_BUFFER_LEN: usize = 64;

#[derive(Debug, Clone)]
pub struct TriggerMatch {
    pub snippet_id: String,
    pub trigger_len: usize,
}

pub fn start_listener(
    enabled: Arc<AtomicBool>,
    cache: Arc<RwLock<Vec<TriggerEntry>>>,
    match_tx: Sender<TriggerMatch>,
) {
    std::thread::Builder::new()
        .name("live-expansion-listener".into())
        .spawn(move || {
            eprintln!("[live-expansion] listener thread started");

            let mut buffer = String::with_capacity(MAX_BUFFER_LEN);

            let callback = move |event: rdev::Event| {
                // Fast path: rdev fires on ALL events (mouse moves, scrolls, clicks)
                // because its event mask is hardcoded. Skip non-keyboard events
                // immediately to avoid any overhead — mouse events fire hundreds of
                // times per second during window resize.
                if !matches!(event.event_type, rdev::EventType::KeyPress(_)) {
                    return;
                }

                if !enabled.load(Ordering::Relaxed) {
                    return;
                }

                // Wrap keyboard processing in catch_unwind — this callback runs
                // inside a C FFI event tap (CGEventTapCreate on macOS). A panic
                // here would unwind through the FFI boundary which is UB and
                // aborts the process.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if let rdev::EventType::KeyPress(key) = event.event_type {
                        // Reset buffer on navigation/control keys
                        if is_reset_key(key) {
                            buffer.clear();
                            return;
                        }

                        // Skip modifier-only keys
                        if is_modifier_key(key) {
                            return;
                        }

                        // Use event.name for layout-aware character detection
                        if let Some(name) = event.name {
                            if !name.is_empty() {
                                buffer.push_str(&name);

                                // Trim buffer if too long — must respect char boundaries
                                if buffer.len() > MAX_BUFFER_LEN {
                                    let drain_to = buffer.len() - MAX_BUFFER_LEN;
                                    let safe_boundary = buffer.ceil_char_boundary(drain_to);
                                    buffer.drain(..safe_boundary);
                                }

                                // Check for trigger match
                                if let Some(entry) =
                                    trigger_cache::match_trigger(&buffer, &cache)
                                {
                                    let trigger_len = entry.trigger.chars().count();
                                    let _ = match_tx.send(TriggerMatch {
                                        snippet_id: entry.snippet_id,
                                        trigger_len,
                                    });
                                    buffer.clear();
                                }
                            }
                        }
                    }
                }));

                if let Err(e) = result {
                    eprintln!(
                        "[live-expansion] panic caught in rdev callback: {:?}",
                        e.downcast_ref::<&str>().copied().unwrap_or("unknown panic")
                    );
                }
            };

            match rdev::listen(callback) {
                Ok(()) => eprintln!("[live-expansion] rdev::listen returned (event tap likely disabled by macOS)"),
                Err(e) => eprintln!("[live-expansion] rdev::listen error: {:?}", e),
            }

            eprintln!("[live-expansion] listener thread exiting");
        })
        .expect("failed to spawn live-expansion listener thread");
}

fn is_reset_key(key: rdev::Key) -> bool {
    matches!(
        key,
        rdev::Key::Return
            | rdev::Key::Tab
            | rdev::Key::Escape
            | rdev::Key::UpArrow
            | rdev::Key::DownArrow
            | rdev::Key::LeftArrow
            | rdev::Key::RightArrow
            | rdev::Key::Backspace
            | rdev::Key::Delete
    )
}

fn is_modifier_key(key: rdev::Key) -> bool {
    matches!(
        key,
        rdev::Key::ShiftLeft
            | rdev::Key::ShiftRight
            | rdev::Key::ControlLeft
            | rdev::Key::ControlRight
            | rdev::Key::Alt
            | rdev::Key::AltGr
            | rdev::Key::MetaLeft
            | rdev::Key::MetaRight
            | rdev::Key::CapsLock
            | rdev::Key::Function
    )
}
