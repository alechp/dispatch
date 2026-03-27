import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getYaptureConfig,
  setYaptureConfig,
  testYaptureConnection,
  yaptureStartOAuth,
  yaptureDisconnect,
  getYaptureConnectionStatus,
  yaptureRefresh,
  type YaptureConfig,
  type YaptureConnectionStatus,
} from "../lib/yapture";
import { getYaptureSyncEnabled, setYaptureSyncEnabled } from "../lib/api";
import { HotkeySettings } from "./HotkeySettings";

interface YaptureSettingsProps {
  onBack: () => void;
  onHotkeyConfigChanged: () => void;
}

type SettingsTab = "yapture" | "hotkeys";

type YaptureEnv = "production" | "staging" | "local";

const ENV_URLS: Record<YaptureEnv, string> = {
  production: "https://api.yapture.app",
  staging: "https://api.staging.yapture.dev",
  local: "http://localhost:4728",
};

function envFromUrl(url: string): YaptureEnv {
  if (url.includes("staging.yapture.dev")) return "staging";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "local";
  return "production";
}

function YaptureTab() {
  const [config, setConfig] = useState<YaptureConfig | null>(null);
  const [connection, setConnection] = useState<YaptureConnectionStatus | null>(null);
  const [testResult, setTestResult] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [env, setEnv] = useState<YaptureEnv>("production");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(true);

  useEffect(() => {
    loadState();
  }, []);

  // Listen for OAuth callback
  useEffect(() => {
    const unlisten = listen<YaptureConnectionStatus>("yapture-connected", (event) => {
      setConnection(event.payload);
      setConnecting(false);
      loadState();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function loadState() {
    try {
      const [cfg, conn] = await Promise.all([
        getYaptureConfig(),
        getYaptureConnectionStatus(),
      ]);
      setConfig(cfg);
      setConnection(conn);
      setEnv(envFromUrl(cfg.apiUrl));
      try {
        const sync = await getYaptureSyncEnabled();
        setSyncEnabled(sync);
      } catch {}
    } catch (e) {
      console.error("[yapture-settings] loadState failed:", e);
    }
  }

  async function handleConnect() {
    setConnecting(true);
    try {
      const url = await yaptureStartOAuth();
      await openUrl(url);
      // Auto-cancel "Connecting..." after 60s if OAuth callback hasn't fired
      setTimeout(() => {
        setConnecting((prev) => {
          if (prev) console.warn("[yapture] OAuth timed out after 60s");
          return false;
        });
      }, 60_000);
    } catch (e) {
      console.error("OAuth start failed:", e);
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    await yaptureDisconnect();
    setConnection({ connected: false, userName: null, userEmail: null });
    await loadState();
  }

  async function handleToggleEnabled() {
    if (!config) return;
    await setYaptureConfig({ enabled: !config.enabled });
    await loadState();
  }

  async function handleEnvChange(newEnv: YaptureEnv) {
    setEnv(newEnv);
    await setYaptureConfig({ apiUrl: ENV_URLS[newEnv] });
    await loadState();
  }

  async function handleTestConnection() {
    setTestResult("testing");
    try {
      let ok = await testYaptureConnection();
      // If test fails, try refreshing the token and retry
      if (!ok) {
        const refreshed = await yaptureRefresh();
        if (refreshed) {
          ok = await testYaptureConnection();
        }
      }
      setTestResult(ok ? "success" : "error");
    } catch {
      setTestResult("error");
    }
    setTimeout(() => setTestResult("idle"), 3000);
  }

  async function handleToggleSync() {
    const newVal = !syncEnabled;
    setSyncEnabled(newVal);
    await setYaptureSyncEnabled(newVal);
  }

  if (!config || !connection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-text-tertiary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {connection.connected ? (
        <>
          {/* Connection status */}
          <div className="bg-surface-raised border border-border-subtle rounded-lg p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-success" />
                  <span className="text-sm font-medium text-text-primary">
                    Connected as {connection.userName || "Unknown"}
                  </span>
                </div>
                {connection.userEmail && (
                  <p className="text-xs text-text-secondary mt-1 ml-4">{connection.userEmail}</p>
                )}
              </div>
              <button
                onClick={handleDisconnect}
                className="text-xs text-text-tertiary hover:text-error transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between px-1">
            <span className="text-sm text-text-primary">Enabled</span>
            <button
              onClick={handleToggleEnabled}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                config.enabled ? "bg-accent" : "bg-surface-overlay border border-border-subtle"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  config.enabled ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>

          {/* Bidirectional sync toggle */}
          <div className="flex items-center justify-between px-1">
            <div>
              <span className="text-sm text-text-primary">Bidirectional Sync</span>
              <p className="text-[10px] text-text-tertiary mt-0.5">
                Clearing or focusing terminal completes the Yapture task
              </p>
            </div>
            <button
              onClick={handleToggleSync}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                syncEnabled ? "bg-accent" : "bg-surface-overlay border border-border-subtle"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  syncEnabled ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>

          {/* Test connection */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleTestConnection}
              disabled={testResult === "testing"}
              className="px-4 py-1.5 text-xs font-medium text-text-primary bg-surface-overlay border border-border-subtle rounded-md hover:border-accent/30 transition-colors disabled:opacity-50"
            >
              {testResult === "testing" ? "Testing..." : "Test Connection"}
            </button>
            {testResult === "success" && (
              <span className="text-xs text-success">Connected</span>
            )}
            {testResult === "error" && (
              <span className="text-xs text-error">Connection failed</span>
            )}
          </div>

          {/* Advanced: environment selector */}
          <div className="border-t border-border-subtle pt-4">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Advanced
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-text-secondary">Environment</label>
                  <div className="flex gap-1">
                    {(["production", "staging", "local"] as YaptureEnv[]).map((e) => (
                      <button
                        key={e}
                        onClick={() => handleEnvChange(e)}
                        className={`px-3 py-1 text-[11px] rounded-md border transition-colors ${
                          env === e
                            ? "bg-accent/15 text-accent border-accent/30"
                            : "bg-surface-overlay text-text-secondary border-border-subtle hover:border-accent/30"
                        }`}
                      >
                        {e.charAt(0).toUpperCase() + e.slice(1)}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-text-tertiary">{ENV_URLS[env]}</p>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {/* OAuth connect — primary action */}
          <div className="bg-surface-raised border border-border-subtle rounded-lg p-4">
            <p className="text-xs text-text-secondary mb-3">
              Connect your Yapture account to push notifications as tasks.
            </p>
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="w-full px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
            >
              {connecting ? "Connecting..." : "Connect with Yapture"}
            </button>
          </div>

          {/* Environment selector (no manual API/token fields) */}
          <div className="space-y-1.5 px-1">
            <label className="text-xs text-text-secondary">Environment</label>
            <div className="flex gap-1">
              {(["production", "staging", "local"] as YaptureEnv[]).map((e) => (
                <button
                  key={e}
                  onClick={() => handleEnvChange(e)}
                  className={`px-3 py-1 text-[11px] rounded-md border transition-colors ${
                    env === e
                      ? "bg-accent/15 text-accent border-accent/30"
                      : "bg-surface-overlay text-text-secondary border-border-subtle hover:border-accent/30"
                  }`}
                >
                  {e.charAt(0).toUpperCase() + e.slice(1)}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-text-tertiary">{ENV_URLS[env]}</p>
          </div>
        </>
      )}
    </div>
  );
}

export function YaptureSettings({ onBack, onHotkeyConfigChanged }: YaptureSettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("yapture");

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-surface">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-surface shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <h2 className="text-sm font-semibold text-text-primary">Settings</h2>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0 border-b border-border-subtle bg-surface shrink-0">
        <button
          onClick={() => setActiveTab("yapture")}
          className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
            activeTab === "yapture"
              ? "text-text-primary border-accent"
              : "text-text-tertiary border-transparent hover:text-text-secondary"
          }`}
        >
          Yapture
        </button>
        <button
          onClick={() => setActiveTab("hotkeys")}
          className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
            activeTab === "hotkeys"
              ? "text-text-primary border-accent"
              : "text-text-tertiary border-transparent hover:text-text-secondary"
          }`}
        >
          Keyboard Shortcuts
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "yapture" && <YaptureTab />}
        {activeTab === "hotkeys" && (
          <HotkeySettings onConfigChanged={onHotkeyConfigChanged} />
        )}
      </div>
    </div>
  );
}
