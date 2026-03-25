use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::thread;
use std::time::Duration;

pub fn inject_text(trigger_char_count: usize, expanded_text: &str) {
    eprintln!(
        "[live-expansion] injecting: delete {} chars, paste {} chars",
        trigger_char_count,
        expanded_text.len()
    );

    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[live-expansion] failed to create enigo instance: {:?}", e);
            return;
        }
    };

    // 1. Send backspaces to delete the trigger
    for _ in 0..trigger_char_count {
        if let Err(e) = enigo.key(Key::Backspace, Direction::Click) {
            eprintln!("[live-expansion] backspace error: {:?}", e);
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }

    // Small delay after backspaces
    thread::sleep(Duration::from_millis(20));

    // 2. Save current clipboard (best-effort)
    let original_clipboard = arboard::Clipboard::new()
        .ok()
        .and_then(|mut cb| cb.get_text().ok());

    // 3. Copy expanded text to clipboard
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(cb) => cb,
        Err(e) => {
            eprintln!("[live-expansion] clipboard init error: {:?}", e);
            return;
        }
    };

    if let Err(e) = clipboard.set_text(expanded_text) {
        eprintln!("[live-expansion] clipboard set_text error: {:?}", e);
        return;
    }

    thread::sleep(Duration::from_millis(10));

    // 4. Paste via Cmd+V (macOS) or Ctrl+V (others)
    #[cfg(target_os = "macos")]
    {
        let _ = enigo.key(Key::Meta, Direction::Press);
        let _ = enigo.key(Key::Unicode('v'), Direction::Click);
        let _ = enigo.key(Key::Meta, Direction::Release);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = enigo.key(Key::Control, Direction::Press);
        let _ = enigo.key(Key::Unicode('v'), Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
    }

    // 5. Restore original clipboard after a delay
    if let Some(original) = original_clipboard {
        thread::sleep(Duration::from_millis(200));
        let _ = clipboard.set_text(original);
    }

    eprintln!("[live-expansion] injection complete");
}
