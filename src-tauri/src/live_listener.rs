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

                        // Map key to character directly — do NOT use event.name as it calls
                        // TSMGetInputSourceProperty which must run on the main thread and
                        // causes EXC_BREAKPOINT (SIGTRAP) when called from a background thread.
                        if let Some(ch) = key_to_char(key) {
                            buffer.push(ch);

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

/// Map rdev::Key to a character without calling macOS TSM APIs.
/// TSMGetInputSourceProperty must run on the main thread — calling it from
/// the rdev background thread causes EXC_BREAKPOINT / SIGTRAP.
/// This mapping covers US-QWERTY; non-US layouts will still match ASCII triggers.
fn key_to_char(key: rdev::Key) -> Option<char> {
    use rdev::Key::*;
    match key {
        KeyA => Some('a'), KeyB => Some('b'), KeyC => Some('c'), KeyD => Some('d'),
        KeyE => Some('e'), KeyF => Some('f'), KeyG => Some('g'), KeyH => Some('h'),
        KeyI => Some('i'), KeyJ => Some('j'), KeyK => Some('k'), KeyL => Some('l'),
        KeyM => Some('m'), KeyN => Some('n'), KeyO => Some('o'), KeyP => Some('p'),
        KeyQ => Some('q'), KeyR => Some('r'), KeyS => Some('s'), KeyT => Some('t'),
        KeyU => Some('u'), KeyV => Some('v'), KeyW => Some('w'), KeyX => Some('x'),
        KeyY => Some('y'), KeyZ => Some('z'),
        Num0 => Some('0'), Num1 => Some('1'), Num2 => Some('2'), Num3 => Some('3'),
        Num4 => Some('4'), Num5 => Some('5'), Num6 => Some('6'), Num7 => Some('7'),
        Num8 => Some('8'), Num9 => Some('9'),
        Space => Some(' '),
        Minus => Some('-'), Equal => Some('='),
        LeftBracket => Some('['), RightBracket => Some(']'),
        BackSlash => Some('\\'), SemiColon => Some(';'), Quote => Some('\''),
        Comma => Some(','), Dot => Some('.'), Slash => Some('/'),
        BackQuote => Some('`'),
        _ => None,
    }
}
