#[cfg(target_os = "macos")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn nsevent_request_accessibility() -> bool;
}

/// Check Accessibility permission (needed for NSEvent keyboard listener + enigo text injection).
pub fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Request Accessibility permission by showing the macOS system prompt.
/// Returns true if already granted; otherwise shows the system dialog.
pub fn request_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { nsevent_request_accessibility() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Robust permission check: actually attempts operations rather than relying
/// on preflight APIs (which macOS caches per binary hash).
/// Returns true if Accessibility is available.
pub fn check_permissions_robust() -> bool {
    let preflight = check_accessibility();
    if preflight {
        return true;
    }

    // Try creating an enigo instance as a definitive test
    let enigo_ok = enigo::Enigo::new(&enigo::Settings::default()).is_ok();
    crate::log::log(&format!(
        "[permissions] Accessibility: preflight={}, enigo_test={}",
        preflight, enigo_ok
    ));
    enigo_ok
}
