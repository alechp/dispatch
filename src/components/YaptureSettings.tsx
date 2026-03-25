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
  type YaptureConfig,
  type YaptureConnectionStatus,
} from "../lib/yapture";

interface YaptureSettingsProps {
  onBack: () => void;
}

export function YaptureSettings({ onBack }: YaptureSettingsProps) {
  const [config, setConfig] = useState<YaptureConfig | null>(null);
  const [connection, setConnection] = useState<YaptureConnectionStatus | null>(null);
  const [testResult, setTestResult] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [apiUrl, setApiUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [userId, setUserId] = useState("");
  const [serviceToken, setServiceToken] = useState("");
  const [connecting, setConnecting] = useState(false);

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
    const [cfg, conn] = await Promise.all([
      getYaptureConfig(),
      getYaptureConnectionStatus(),
    ]);
    setConfig(cfg);
    setConnection(conn);
    setApiUrl(cfg.api_url);
    setUserId(cfg.user_id);
  }

  async function handleConnect() {
    setConnecting(true);
    try {
      const url = await yaptureStartOAuth();
      await openUrl(url);
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

  async function handleSaveApiUrl() {
    await setYaptureConfig({ apiUrl: apiUrl });
    await loadState();
  }

  async function handleSaveAdvanced() {
    await setYaptureConfig({
      userId: userId || undefined,
      serviceToken: serviceToken || undefined,
    });
    setServiceToken("");
    await loadState();
  }

  async function handleTestConnection() {
    setTestResult("testing");
    try {
      const ok = await testYaptureConnection();
      setTestResult(ok ? "success" : "error");
    } catch {
      setTestResult("error");
    }
    setTimeout(() => setTestResult("idle"), 3000);
  }

  if (!config || !connection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-text-tertiary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-surface">
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
        <h2 className="text-sm font-semibold text-text-primary">Yapture Integration</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Connection status */}
        {connection.connected ? (
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
        ) : (
          <div className="bg-surface-raised border border-border-subtle rounded-lg p-4">
            <p className="text-xs text-text-secondary mb-3">
              Push notifications to Yapture as tasks.
            </p>
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="w-full px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
            >
              {connecting ? "Connecting..." : "Connect with Yapture"}
            </button>
          </div>
        )}

        {/* Enabled toggle */}
        {connection.connected && (
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
        )}

        {/* API URL */}
        <div className="space-y-1.5">
          <label className="text-xs text-text-secondary">API URL</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              className="flex-1 text-xs bg-surface-overlay border border-border-subtle rounded-md px-2.5 py-1.5 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
            />
            <button
              onClick={handleSaveApiUrl}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-surface-overlay border border-border-subtle rounded-md hover:border-accent/30 transition-colors"
            >
              Save
            </button>
          </div>
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

        {/* Advanced: Service Token fallback */}
        {!connection.connected && (
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
              Advanced: Use Service Token
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-text-secondary">User ID</label>
                  <input
                    type="text"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    placeholder="Paste Yapture UUID"
                    className="w-full text-xs bg-surface-overlay border border-border-subtle rounded-md px-2.5 py-1.5 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-text-secondary">Service Token</label>
                  <input
                    type="password"
                    value={serviceToken}
                    onChange={(e) => setServiceToken(e.target.value)}
                    placeholder="Paste service token"
                    className="w-full text-xs bg-surface-overlay border border-border-subtle rounded-md px-2.5 py-1.5 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
                  />
                </div>
                <button
                  onClick={handleSaveAdvanced}
                  className="px-4 py-1.5 text-xs font-medium text-text-primary bg-surface-overlay border border-border-subtle rounded-md hover:border-accent/30 transition-colors"
                >
                  Save
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
