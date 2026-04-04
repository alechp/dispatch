use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::thread;
use std::time::Duration;

// ── CGEvent FFI for reliable Cmd+V paste ────────────────────────────────────

#[cfg(target_os = "macos")]
mod cg {
    use std::os::raw::c_void;

    pub type CGEventRef = *mut c_void;
    pub type CGEventSourceRef = *mut c_void;
    pub type CGEventFlags = u64;

    pub const CG_KEY_DOWN: u32 = 10;
    pub const CG_KEY_UP: u32 = 11;
    pub const CG_EVENT_FLAG_MASK_COMMAND: CGEventFlags = 0x0010_0000;
    // kCGHIDEventTap = 0
    pub const CG_HID_EVENT_TAP: u32 = 0;

    // macOS virtual keycode for 'v'
    pub const KEYCODE_V: u16 = 0x09;

    extern "C" {
        pub fn CGEventCreateKeyboardEvent(
            source: CGEventSourceRef,
            virtual_key: u16,
            key_down: bool,
        ) -> CGEventRef;
        pub fn CGEventSetFlags(event: CGEventRef, flags: CGEventFlags);
        pub fn CGEventPost(tap: u32, event: CGEventRef);
        pub fn CFRelease(cf: *const c_void);
    }
}

/// Post a Cmd+V keystroke using CoreGraphics directly.
/// This is more reliable than enigo's separate Press/Click/Release pattern,
/// which can crash on some macOS versions.
#[cfg(target_os = "macos")]
fn post_cmd_v() {
    unsafe {
        // Key down with Cmd flag
        let key_down = cg::CGEventCreateKeyboardEvent(
            std::ptr::null_mut(),
            cg::KEYCODE_V,
            true,
        );
        if key_down.is_null() {
            eprintln!("[live-expansion][inject] CGEventCreateKeyboardEvent(down) returned null");
            return;
        }
        cg::CGEventSetFlags(key_down, cg::CG_EVENT_FLAG_MASK_COMMAND);
        cg::CGEventPost(cg::CG_HID_EVENT_TAP, key_down);
        cg::CFRelease(key_down as *const _);

        thread::sleep(Duration::from_millis(5));

        // Key up with Cmd flag
        let key_up = cg::CGEventCreateKeyboardEvent(
            std::ptr::null_mut(),
            cg::KEYCODE_V,
            false,
        );
        if key_up.is_null() {
            eprintln!("[live-expansion][inject] CGEventCreateKeyboardEvent(up) returned null");
            return;
        }
        cg::CGEventSetFlags(key_up, cg::CG_EVENT_FLAG_MASK_COMMAND);
        cg::CGEventPost(cg::CG_HID_EVENT_TAP, key_up);
        cg::CFRelease(key_up as *const _);
    }
}

#[cfg(not(target_os = "macos"))]
fn post_cmd_v() {
    // Fallback for non-macOS: use enigo Ctrl+V
    if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
        let _ = enigo.key(Key::Control, Direction::Press);
        let _ = enigo.key(Key::Unicode('v'), Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

pub fn inject_text(trigger_char_count: usize, expanded_text: &str) {
    eprintln!(
        "[live-expansion][inject] start: delete {} chars, paste {} chars",
        trigger_char_count,
        expanded_text.len(),
    );

    // Wrap the entire injection in catch_unwind to catch panics
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        inject_text_inner(trigger_char_count, expanded_text)
    }));

    match result {
        Ok(()) => eprintln!("[live-expansion][inject] injection complete"),
        Err(e) => {
            let msg = e
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| e.downcast_ref::<String>().map(|s| s.as_str()))
                .unwrap_or("unknown panic");
            eprintln!("[live-expansion][inject] PANIC during injection: {}", msg);
        }
    }
}

fn inject_text_inner(trigger_char_count: usize, expanded_text: &str) {
    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(e) => e,
        Err(e) => {
            crate::log::log(&format!("[live-expansion][inject] FAILED to create enigo: {:?}", e));
            return;
        }
    };

    // 1. Send backspaces to delete the trigger
    for i in 0..trigger_char_count {
        match enigo.key(Key::Backspace, Direction::Click) {
            Ok(()) => {}
            Err(e) => {
                crate::log::log(&format!("[live-expansion][inject] backspace #{} error: {:?}", i, e));
                return;
            }
        }
        thread::sleep(Duration::from_millis(10));
    }

    // Drop enigo before using CGEvent for paste (avoid conflicting event sources)
    drop(enigo);
    thread::sleep(Duration::from_millis(30));

    // 2. Save current clipboard (best-effort)
    let original_clipboard = arboard::Clipboard::new()
        .ok()
        .and_then(|mut cb| cb.get_text().ok());

    // 3. Copy expanded text to clipboard
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(cb) => cb,
        Err(e) => {
            crate::log::log(&format!("[live-expansion][inject] clipboard error: {:?}", e));
            return;
        }
    };

    if let Err(e) = clipboard.set_text(expanded_text) {
        crate::log::log(&format!("[live-expansion][inject] clipboard set error: {:?}", e));
        return;
    }

    thread::sleep(Duration::from_millis(20));

    // 4. Paste via Cmd+V using CGEvent directly
    post_cmd_v();

    crate::log::log(&format!(
        "[live-expansion][inject] injected {:?} (deleted {} chars)",
        expanded_text, trigger_char_count
    ));

    // 5. Restore original clipboard after a delay
    if let Some(original) = original_clipboard {
        thread::sleep(Duration::from_millis(200));
        let _ = clipboard.set_text(original);
        eprintln!("[live-expansion][inject] original clipboard restored");
    }
}
