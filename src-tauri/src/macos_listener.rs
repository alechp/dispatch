//! macOS keyboard listener using NSEvent global monitor.
//!
//! Previous implementation used CGEventTap which requires Input Monitoring
//! permission. macOS tracks Input Monitoring by binary hash, so the permission
//! is invalidated on every rebuild. This module uses NSEvent global monitor
//! instead, which only requires Accessibility permission (tracked by app path,
//! survives rebuilds). This is the same approach Espanso uses.
//!
//! The NSEvent handler is always invoked on the main thread's run loop, which
//! Tauri's Cocoa event loop provides automatically — no background CFRunLoop needed.

#![cfg(target_os = "macos")]

use crossbeam_channel::Sender;
use parking_lot::RwLock;
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::live_listener::TriggerMatch;
use crate::trigger_cache::{self, TriggerEntry};

/// Global counter of key events received by the NSEvent callback.
/// Used by diagnostics to verify events are flowing.
static EVENT_COUNT: AtomicU64 = AtomicU64::new(0);

// ── NSEvent bridge FFI (nsevent_bridge.m) ───────────────────────────────────

type NSeventKeyCallback =
    extern "C" fn(keycode: u16, modifier_flags: u64, context: *mut c_void);

extern "C" {
    fn nsevent_start_key_monitor(callback: NSeventKeyCallback, context: *mut c_void) -> bool;
    fn nsevent_stop_key_monitor();
    fn nsevent_is_key_monitoring() -> bool;
}

// ── NSEvent modifier flags ──────────────────────────────────────────────────

const NS_EVENT_MODIFIER_FLAG_SHIFT: u64 = 1 << 17; // 0x0002_0000

// ── Listener state ──────────────────────────────────────────────────────────

const MAX_BUFFER_LEN: usize = 64;

struct ListenerState {
    enabled: Arc<AtomicBool>,
    cache: Arc<RwLock<Vec<TriggerEntry>>>,
    match_tx: Sender<TriggerMatch>,
    buffer: Mutex<String>,
}


// ── NSEvent callback ────────────────────────────────────────────────────────

extern "C" fn key_event_callback(keycode: u16, modifier_flags: u64, context: *mut c_void) {
    EVENT_COUNT.fetch_add(1, Ordering::Relaxed);

    let state = unsafe { &*(context as *const ListenerState) };

    if !state.enabled.load(Ordering::Relaxed) {
        return;
    }

    let shift = (modifier_flags & NS_EVENT_MODIFIER_FLAG_SHIFT) != 0;

    // Reset buffer on navigation/control keys
    if is_reset_keycode(keycode) {
        state.buffer.lock().unwrap().clear();
        return;
    }

    // Skip modifier-only keys
    if is_modifier_keycode(keycode) {
        return;
    }

    if let Some(ch) = keycode_to_char(keycode, shift) {
        let mut buf = state.buffer.lock().unwrap();
        buf.push(ch);

        // Trim buffer if too long
        if buf.len() > MAX_BUFFER_LEN {
            let drain_to = buf.len() - MAX_BUFFER_LEN;
            let safe_boundary = buf.ceil_char_boundary(drain_to);
            buf.drain(..safe_boundary);
        }

        // Only check triggers and log once a ':' prefix is in the buffer
        if !buf.contains(':') {
            return;
        }

        // Check for trigger match
        if let Some(entry) = trigger_cache::match_trigger(&buf, &state.cache) {
            crate::log::log(&format!(
                "[live-expansion] MATCHED trigger=\"{}\" snippet_id={}",
                entry.trigger, entry.snippet_id
            ));
            let trigger_len = entry.trigger.chars().count();
            let _ = state.match_tx.send(TriggerMatch {
                snippet_id: entry.snippet_id,
                trigger_len,
            });
            buf.clear();
        }
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

pub fn start_listener(
    enabled: Arc<AtomicBool>,
    cache: Arc<RwLock<Vec<TriggerEntry>>>,
    match_tx: Sender<TriggerMatch>,
) {
    eprintln!("[live-expansion] NSEvent keyboard listener starting");

    // Leak the state so the raw pointer stays valid for the program's lifetime.
    // All fields are thread-safe (Arc, Mutex, crossbeam Sender).
    let state = Box::leak(Box::new(ListenerState {
        enabled,
        cache,
        match_tx,
        buffer: Mutex::new(String::with_capacity(MAX_BUFFER_LEN)),
    }));
    let context = state as *mut ListenerState as *mut c_void;

    let started = unsafe { nsevent_start_key_monitor(key_event_callback, context) };

    if started {
        eprintln!("[live-expansion] NSEvent key monitor active");
    } else {
        eprintln!(
            "[live-expansion] NSEvent monitor creation failed — \
             Accessibility permission likely not granted. Will retry every 5s."
        );

        // Spawn retry thread that periodically attempts to create the monitor.
        // Once Accessibility is granted in System Settings, the next retry succeeds.
        // Cast to usize to satisfy Send bound (the pointer is valid for program lifetime).
        let context_addr = context as usize;
        std::thread::Builder::new()
            .name("nsevent-monitor-retry".into())
            .spawn(move || {
                let ctx = context_addr as *mut c_void;
                const RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
                const MAX_RETRIES: u32 = 120; // 10 minutes total

                for attempt in 1..=MAX_RETRIES {
                    std::thread::sleep(RETRY_INTERVAL);

                    let ok = unsafe { nsevent_start_key_monitor(key_event_callback, ctx) };
                    if ok {
                        eprintln!(
                            "[live-expansion] NSEvent monitor started on retry #{attempt}"
                        );
                        return;
                    }

                    if attempt % 12 == 0 {
                        eprintln!(
                            "[live-expansion] still waiting for Accessibility permission \
                             ({attempt} retries, {}s elapsed)",
                            attempt * 5
                        );
                    }
                }

                eprintln!(
                    "[live-expansion] gave up waiting for Accessibility after {MAX_RETRIES} retries"
                );
            })
            .ok();
    }
}

/// Check if the NSEvent key monitor is currently active.
pub fn is_monitoring() -> bool {
    unsafe { nsevent_is_key_monitoring() }
}

/// Get the total number of key events received since the monitor started.
pub fn event_count() -> u64 {
    EVENT_COUNT.load(Ordering::Relaxed)
}

// ── Key code mapping (US QWERTY) ───────────────────────────────────────────

fn keycode_to_char(code: u16, shift: bool) -> Option<char> {
    if shift {
        match code {
            // Letters → uppercase
            0x00 => Some('A'),
            0x01 => Some('S'),
            0x02 => Some('D'),
            0x03 => Some('F'),
            0x04 => Some('H'),
            0x05 => Some('G'),
            0x06 => Some('Z'),
            0x07 => Some('X'),
            0x08 => Some('C'),
            0x09 => Some('V'),
            0x0B => Some('B'),
            0x0C => Some('Q'),
            0x0D => Some('W'),
            0x0E => Some('E'),
            0x0F => Some('R'),
            0x10 => Some('Y'),
            0x11 => Some('T'),
            0x1F => Some('O'),
            0x20 => Some('U'),
            0x22 => Some('I'),
            0x23 => Some('P'),
            0x25 => Some('L'),
            0x26 => Some('J'),
            0x28 => Some('K'),
            0x2D => Some('N'),
            0x2E => Some('M'),
            // Numbers → symbols
            0x12 => Some('!'),
            0x13 => Some('@'),
            0x14 => Some('#'),
            0x15 => Some('$'),
            0x17 => Some('%'),
            0x16 => Some('^'),
            0x1A => Some('&'),
            0x1C => Some('*'),
            0x19 => Some('('),
            0x1D => Some(')'),
            // Punctuation shifted
            0x1B => Some('_'),  // Shift+-
            0x18 => Some('+'),  // Shift+=
            0x21 => Some('{'),  // Shift+[
            0x1E => Some('}'),  // Shift+]
            0x2A => Some('|'),  // Shift+\
            0x29 => Some(':'),  // Shift+; ← critical for :trigger
            0x27 => Some('"'),  // Shift+'
            0x2B => Some('<'),  // Shift+,
            0x2F => Some('>'),  // Shift+.
            0x2C => Some('?'),  // Shift+/
            0x32 => Some('~'),  // Shift+`
            // Space
            0x31 => Some(' '),
            _ => None,
        }
    } else {
        match code {
            // Letters
            0x00 => Some('a'),
            0x01 => Some('s'),
            0x02 => Some('d'),
            0x03 => Some('f'),
            0x04 => Some('h'),
            0x05 => Some('g'),
            0x06 => Some('z'),
            0x07 => Some('x'),
            0x08 => Some('c'),
            0x09 => Some('v'),
            0x0B => Some('b'),
            0x0C => Some('q'),
            0x0D => Some('w'),
            0x0E => Some('e'),
            0x0F => Some('r'),
            0x10 => Some('y'),
            0x11 => Some('t'),
            0x1F => Some('o'),
            0x20 => Some('u'),
            0x22 => Some('i'),
            0x23 => Some('p'),
            0x25 => Some('l'),
            0x26 => Some('j'),
            0x28 => Some('k'),
            0x2D => Some('n'),
            0x2E => Some('m'),
            // Numbers
            0x12 => Some('1'),
            0x13 => Some('2'),
            0x14 => Some('3'),
            0x15 => Some('4'),
            0x17 => Some('5'),
            0x16 => Some('6'),
            0x1A => Some('7'),
            0x1C => Some('8'),
            0x19 => Some('9'),
            0x1D => Some('0'),
            // Punctuation
            0x1B => Some('-'),
            0x18 => Some('='),
            0x21 => Some('['),
            0x1E => Some(']'),
            0x2A => Some('\\'),
            0x29 => Some(';'),
            0x27 => Some('\''),
            0x2B => Some(','),
            0x2C => Some('/'),
            0x2F => Some('.'),
            0x32 => Some('`'),
            0x31 => Some(' '),
            _ => None,
        }
    }
}

fn is_reset_keycode(code: u16) -> bool {
    matches!(
        code,
        0x24  // Return
        | 0x30 // Tab
        | 0x35 // Escape
        | 0x7E // Up Arrow
        | 0x7D // Down Arrow
        | 0x7B // Left Arrow
        | 0x7C // Right Arrow
        | 0x33 // Delete/Backspace
        | 0x75 // Forward Delete
    )
}

fn is_modifier_keycode(code: u16) -> bool {
    matches!(
        code,
        0x38  // Left Shift
        | 0x3C // Right Shift
        | 0x3B // Left Control
        | 0x3E // Right Control
        | 0x3A // Left Option
        | 0x3D // Right Option
        | 0x37 // Left Command
        | 0x36 // Right Command
        | 0x39 // Caps Lock
        | 0x3F // Function
    )
}
