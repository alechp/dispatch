use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Initialize file logging. Call once during app setup.
pub fn init(app_data_dir: &std::path::Path) {
    let path = app_data_dir.join("dispatch.log");

    // Truncate on startup so the log only contains the current session
    if let Ok(mut f) = std::fs::File::create(&path) {
        let _ = writeln!(f, "[{}] === Dispatch session started ===", timestamp());
    }

    let _ = LOG_PATH.set(path.clone());
    eprintln!("[dispatch] log file: {}", path.display());
}

/// Write a line to the log file (and also to stderr).
pub fn log(msg: &str) {
    let ts = timestamp();
    let line = format!("[{}] {}", ts, msg);
    eprintln!("{}", line);

    if let Some(path) = LOG_PATH.get() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{}", line);
        }
    }
}

fn timestamp() -> String {
    chrono::Local::now().format("%H:%M:%S%.3f").to_string()
}

/// Convenience macro: `log!("msg {}", val)`
#[macro_export]
macro_rules! dlog {
    ($($arg:tt)*) => {
        $crate::log::log(&format!($($arg)*))
    };
}
