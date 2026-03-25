import { invoke } from "@tauri-apps/api/core";

export async function getLiveExpansionEnabled(): Promise<boolean> {
  return invoke("get_live_expansion_enabled");
}

export async function setLiveExpansionEnabled(enabled: boolean): Promise<void> {
  return invoke("set_live_expansion_enabled", { enabled });
}

export async function checkAccessibilityPermission(): Promise<boolean> {
  return invoke("check_accessibility_permission");
}

export async function requestAccessibilityPermission(): Promise<boolean> {
  return invoke("request_accessibility_permission");
}
