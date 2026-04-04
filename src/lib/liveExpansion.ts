import { invoke } from "@tauri-apps/api/core";

export async function getLiveExpansionEnabled(): Promise<boolean> {
  return invoke("get_live_expansion_enabled");
}

export async function setLiveExpansionEnabled(enabled: boolean): Promise<void> {
  return invoke("set_live_expansion_enabled", { enabled });
}

/** Check Accessibility permission (needed for keyboard listener + text injection). */
export async function checkAccessibilityPermission(): Promise<boolean> {
  return invoke("check_accessibility_permission");
}

/** Request Accessibility permission (shows macOS system prompt if not granted). */
export async function requestAccessibilityPermission(): Promise<boolean> {
  return invoke("request_accessibility_permission");
}

export interface ExpansionDiagnostics {
  accessibility: boolean;
  listener_active: boolean;
  event_count: number;
  enabled: boolean;
  trigger_count: number;
}

/** Get full diagnostic state for the text expander. */
export async function getExpansionDiagnostics(): Promise<ExpansionDiagnostics> {
  return invoke("get_expansion_diagnostics");
}

/** Open macOS System Settings Accessibility pane. */
export async function openPrivacySettings(pane: "Accessibility" | "ListenEvent"): Promise<void> {
  return invoke("open_privacy_settings", { pane });
}

/** Test text injection and return a diagnostic message. */
export async function testTextInjection(): Promise<string> {
  return invoke("test_text_injection");
}

/** Copy text to system clipboard via native arboard (reliable in Tauri WebView). */
export async function copyToClipboard(text: string): Promise<void> {
  return invoke("copy_to_clipboard", { text });
}
