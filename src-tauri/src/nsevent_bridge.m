/**
 * NSEvent keyboard monitor bridge for Rust.
 *
 * Uses NSEvent.addGlobalMonitorForEventsMatchingMask: which requires
 * Accessibility permission only (not Input Monitoring). Accessibility
 * permission is tracked by app path, so it survives rebuilds — unlike
 * Input Monitoring which is tracked by binary hash.
 *
 * The handler block is always invoked on the main thread's run loop,
 * which Tauri's Cocoa event loop provides automatically.
 */

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdbool.h>
#include <stdint.h>

typedef void (*nsevent_key_callback_t)(uint16_t keycode, uint64_t modifier_flags, void *context);

static id _globalKeyMonitor = nil;

/**
 * Start a global key-down monitor.
 * Returns true if the monitor was created successfully.
 * Returns false if Accessibility permission is not granted.
 *
 * Safe to call from any thread. The handler is always invoked on the main thread.
 * If a monitor already exists, it is removed before creating the new one.
 */
bool nsevent_start_key_monitor(nsevent_key_callback_t callback, void *context) {
    if (_globalKeyMonitor) {
        [NSEvent removeMonitor:_globalKeyMonitor];
        _globalKeyMonitor = nil;
    }

    _globalKeyMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                               handler:^(NSEvent *event) {
        if (callback) {
            callback(event.keyCode, (uint64_t)[event modifierFlags], context);
        }
    }];

    return _globalKeyMonitor != nil;
}

/**
 * Stop the global key monitor and release resources.
 */
void nsevent_stop_key_monitor(void) {
    if (_globalKeyMonitor) {
        [NSEvent removeMonitor:_globalKeyMonitor];
        _globalKeyMonitor = nil;
    }
}

/**
 * Check if the global key monitor is currently active.
 */
bool nsevent_is_key_monitoring(void) {
    return _globalKeyMonitor != nil;
}

/**
 * Request Accessibility permission by showing the macOS system prompt.
 * Returns true if Accessibility is already granted.
 * If not granted, macOS shows the "allow Accessibility" dialog.
 */
bool nsevent_request_accessibility(void) {
    NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}
