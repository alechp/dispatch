#[cfg(target_os = "macos")]
extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

pub fn check_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { CGPreflightListenEventAccess() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

pub fn request_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { CGRequestListenEventAccess() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
