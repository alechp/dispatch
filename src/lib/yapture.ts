import { invoke } from "@tauri-apps/api/core";

export interface YaptureConfig {
  enabled: boolean;
  apiUrl: string;
  userId: string;
  hasToken: boolean;
}

export interface YaptureConnectionStatus {
  connected: boolean;
  userName: string | null;
  userEmail: string | null;
}

export async function getYaptureConfig(): Promise<YaptureConfig> {
  return invoke("get_yapture_config");
}

export async function setYaptureConfig(config: {
  enabled?: boolean;
  apiUrl?: string;
  userId?: string;
  serviceToken?: string;
}): Promise<void> {
  return invoke("set_yapture_config", {
    enabled: config.enabled ?? null,
    apiUrl: config.apiUrl ?? null,
    userId: config.userId ?? null,
    serviceToken: config.serviceToken ?? null,
  });
}

export async function testYaptureConnection(): Promise<boolean> {
  return invoke("test_yapture_connection");
}

export async function yaptureStartOAuth(): Promise<string> {
  return invoke("yapture_start_oauth");
}

export async function yaptureDisconnect(): Promise<void> {
  return invoke("yapture_disconnect");
}

export async function getYaptureConnectionStatus(): Promise<YaptureConnectionStatus> {
  return invoke("get_yapture_connection_status");
}
