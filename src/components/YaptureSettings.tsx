import { useState, useEffect, useCallback } from "react";
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
import { getYaptureSyncEnabled, setYaptureSyncEnabled, getNotificationBannerConfig, setNotificationBannerConfig } from "../lib/api";
import {
  importSnippets,
  exportSnippets,
  listSnippetSources,
  addSnippetSource,
  removeSnippetSource,
  syncSnippetSource,
  updateSnippetSource,
  createBoilerplateConfig,
  readSourceFile,
  writeSourceFile,
  refreshTriggers,
  getExpandPrefix,
  setExpandPrefix as setExpandPrefixApi,
  ensureDefaultSource,
} from "../lib/snippets";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { copyToClipboard } from "../lib/liveExpansion";
import { useToast } from "../hooks/useToast";
import { HotkeySettings } from "./HotkeySettings";
import type { NotificationBannerConfig, BannerScreenKey, SnippetSource } from "../lib/types";
import { DEFAULT_BANNER_CONFIG, BANNER_SCREEN_LABELS } from "../lib/types";

interface YaptureSettingsProps {
  onBack: () => void;
  onHotkeyConfigChanged: () => void;
  onBannerConfigChanged: () => void;
}

type SettingsTab = "yapture" | "hotkeys" | "notifications" | "sources";

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

function NotificationSettingsTab({ onConfigChanged }: { onConfigChanged: () => void }) {
  const [config, setConfig] = useState<NotificationBannerConfig>(DEFAULT_BANNER_CONFIG);

  useEffect(() => {
    getNotificationBannerConfig().then(setConfig).catch(() => {});
  }, []);

  async function handleToggleGlobal() {
    const updated = { ...config, globalEnabled: !config.globalEnabled };
    setConfig(updated);
    await setNotificationBannerConfig(updated);
    onConfigChanged();
  }

  async function handleToggleScreen(key: BannerScreenKey) {
    const updated = {
      ...config,
      screens: { ...config.screens, [key]: !config.screens[key] },
    };
    setConfig(updated);
    await setNotificationBannerConfig(updated);
    onConfigChanged();
  }

  const screenKeys = Object.keys(BANNER_SCREEN_LABELS) as BannerScreenKey[];

  return (
    <div className="space-y-4">
      {/* Global toggle */}
      <div className="flex items-center justify-between px-1">
        <div>
          <span className="text-sm text-text-primary">Show notification banners</span>
          <p className="text-[10px] text-text-tertiary mt-0.5">
            Sounds and data refresh are unaffected
          </p>
        </div>
        <button
          onClick={handleToggleGlobal}
          className={`relative w-10 h-5 rounded-full transition-colors ${
            config.globalEnabled ? "bg-accent" : "bg-surface-overlay border border-border-subtle"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              config.globalEnabled ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>

      {/* Per-screen toggles */}
      <div
        className={`bg-surface-raised border border-border-subtle rounded-lg divide-y divide-border-subtle transition-opacity ${
          config.globalEnabled ? "" : "opacity-50 pointer-events-none"
        }`}
      >
        {screenKeys.map((key) => (
          <div key={key} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-text-primary">{BANNER_SCREEN_LABELS[key]}</span>
            <button
              onClick={() => handleToggleScreen(key)}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                config.screens[key] ? "bg-accent" : "bg-surface-overlay border border-border-subtle"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  config.screens[key] ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExpansionSourcesTab() {
  const [sources, setSources] = useState<SnippetSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefix, setPrefix] = useState(":");
  const [prefixEdit, setPrefixEdit] = useState(":");
  const [editingSource, setEditingSource] = useState<SnippetSource | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const { showToast } = useToast();

  const refreshSources = useCallback(async () => {
    try {
      // Ensure the built-in Defaults source exists before listing
      await ensureDefaultSource().catch(() => {});
      const [srcs, pfx] = await Promise.all([
        listSnippetSources(),
        getExpandPrefix(),
      ]);
      setSources(srcs);
      setPrefix(pfx);
      setPrefixEdit(pfx);
    } catch (err) {
      console.error("Failed to load sources:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshSources();
  }, [refreshSources]);

  const handleAddSource = useCallback(async () => {
    try {
      const selected = await openDialog({ directory: true, title: "Choose folder or file for expansion config" });
      if (!selected) return;
      const path = typeof selected === "string" ? selected : (selected as any);
      if (!path) return;
      const name = window.prompt("Package name:", path.split("/").pop() || "snippets");
      if (!name) return;
      const isFolder = !path.endsWith(".yml") && !path.endsWith(".yaml");
      await addSnippetSource(name, path, isFolder);
      showToast("Source added and synced");
      refreshSources();
    } catch (err) {
      console.error("Add source failed:", err);
      showToast(`Failed: ${err}`);
    }
  }, [showToast, refreshSources]);

  const handleBoilerplate = useCallback(async () => {
    try {
      const folder = await openDialog({ directory: true, title: "Choose folder for new expansion config" });
      if (!folder) return;
      const path = typeof folder === "string" ? folder : (folder as any);
      if (!path) return;
      const name = window.prompt("Package name:", path.split("/").pop() || "snippets");
      if (!name) return;
      const source = await createBoilerplateConfig(path, name);
      showToast(`Created dispatch-snippets.yml in ${path}`);
      refreshSources();
      setEditingSource(source);
    } catch (err: any) {
      console.error("Boilerplate failed:", err);
      showToast(`Failed: ${err}`);
    }
  }, [showToast, refreshSources]);

  const handleSync = useCallback(async (id: string) => {
    try {
      const result = await syncSnippetSource(id);
      showToast(`Synced: +${result.added} ~${result.updated} -${result.removed}`);
      refreshSources();
    } catch (err) {
      console.error("Sync failed:", err);
    }
  }, [showToast, refreshSources]);

  const handleRemove = useCallback(async (id: string) => {
    try {
      await removeSnippetSource(id);
      showToast("Source removed");
      refreshSources();
    } catch (err) {
      console.error("Remove failed:", err);
    }
  }, [showToast, refreshSources]);

  const handleToggleEnabled = useCallback(async (source: SnippetSource) => {
    try {
      await updateSnippetSource(source.id, { isEnabled: source.is_enabled === 0 });
      await refreshTriggers();
      refreshSources();
    } catch (err) {
      console.error("Toggle failed:", err);
    }
  }, [refreshSources]);

  const handleSavePrefix = useCallback(async () => {
    try {
      await setExpandPrefixApi(prefixEdit);
      setPrefix(prefixEdit);
      showToast(`Prefix updated to "${prefixEdit}"`);
    } catch (err: any) {
      showToast(`Invalid prefix: ${err}`);
    }
  }, [prefixEdit, showToast]);

  const handleExport = useCallback(async () => {
    try {
      const data = await exportSnippets();
      const json = JSON.stringify(data, null, 2);
      await copyToClipboard(json);
      showToast("Exported to clipboard");
    } catch (err) {
      console.error("Export failed:", err);
    }
  }, [showToast]);

  const handleImportSubmit = useCallback(
    async (json: string) => {
      try {
        await importSnippets(json);
        setShowImportModal(false);
        showToast("Snippets imported");
      } catch (err) {
        console.error("Import failed:", err);
      }
    },
    [showToast]
  );

  if (editingSource) {
    return (
      <SourceFileEditor
        source={editingSource}
        onBack={() => setEditingSource(null)}
        onSaved={refreshSources}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Trigger Prefix */}
      <div>
        <label className="block text-xs font-semibold text-text-secondary mb-2">
          Trigger Prefix
        </label>
        <p className="text-[10px] text-text-tertiary mb-2">
          Character(s) that activate expansion mode in the command palette.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={prefixEdit}
            onChange={(e) => setPrefixEdit(e.target.value)}
            maxLength={3}
            className="w-16 bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary font-mono text-center focus:outline-none focus:border-accent/50 transition-colors"
          />
          {prefixEdit !== prefix && (
            <button
              onClick={handleSavePrefix}
              className="text-xs text-accent hover:text-accent-hover transition-colors"
            >
              Save
            </button>
          )}
          <span className="text-[10px] text-text-tertiary ml-2">
            Current: <code className="font-mono text-accent">{prefix}</code>
          </span>
        </div>
      </div>

      {/* Import / Export */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowImportModal(true)}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5 rounded-md border border-border-subtle hover:border-border-default"
        >
          Import Snippets
        </button>
        <button
          onClick={handleExport}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5 rounded-md border border-border-subtle hover:border-border-default"
        >
          Export Snippets
        </button>
      </div>

      {/* External Sources */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="text-xs font-semibold text-text-secondary">
            External Sources
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={handleBoilerplate}
              className="text-[11px] text-accent hover:text-accent-hover transition-colors"
            >
              New Config File
            </button>
            <button
              onClick={handleAddSource}
              className="text-[11px] text-accent hover:text-accent-hover transition-colors"
            >
              Import Source
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-xs text-text-tertiary">Loading sources...</p>
        ) : sources.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-xs text-text-tertiary mb-2">No external sources configured.</p>
            <p className="text-[10px] text-text-tertiary">
              Add a YAML config file or folder, or create a new one with "New Config File".
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => (
              <div
                key={source.id}
                className={`rounded-lg bg-surface-raised border border-border-subtle p-3 transition-opacity ${!source.is_enabled ? "opacity-50" : ""}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-text-primary">
                    {source.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEditingSource(source)}
                      className="text-[10px] text-accent hover:text-accent-hover transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleSync(source.id)}
                      className="text-[10px] text-accent hover:text-accent-hover transition-colors"
                    >
                      Sync
                    </button>
                    <button
                      onClick={() => handleToggleEnabled(source)}
                      className={`text-[10px] transition-colors ${source.is_enabled ? "text-success" : "text-text-tertiary"}`}
                    >
                      {source.is_enabled ? "Enabled" : "Disabled"}
                    </button>
                    <button
                      onClick={() => handleRemove(source.id)}
                      className="text-[10px] text-error hover:text-red-400 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <p className="text-[10px] font-mono text-text-tertiary truncate">
                  {source.path}
                </p>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-[10px] text-text-tertiary">
                    {source.is_folder ? "Folder" : "File"}
                  </span>
                  {source.last_synced_at && (
                    <span className="text-[10px] text-text-tertiary">
                      Last synced: {new Date(source.last_synced_at).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Import modal */}
      {showImportModal && (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onImport={handleImportSubmit}
        />
      )}
    </div>
  );
}

function SourceFileEditor({
  source,
  onBack,
  onSaved,
}: {
  source: SnippetSource;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    readSourceFile(source.id)
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(`Failed to read file: ${err}`);
        setLoading(false);
      });
  }, [source.id]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await writeSourceFile(source.id, content);
      setDirty(false);
      showToast(`Saved — +${result.added} added, ~${result.updated} updated, -${result.removed} removed`);
      onSaved();
    } catch (err: any) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [source.id, content, showToast, onSaved]);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Sources
          </button>
          <span className="text-sm font-semibold text-text-primary">{source.name}</span>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="text-xs text-white bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors px-3 py-1.5 rounded-md"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {/* Editor */}
      {loading ? (
        <p className="text-sm text-text-tertiary">Loading file...</p>
      ) : (
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
            setError(null);
          }}
          spellCheck={false}
          rows={20}
          className="w-full bg-surface-overlay border border-border-subtle rounded-md px-4 py-3 text-xs text-text-primary font-mono leading-relaxed focus:outline-none focus:border-accent/50 transition-colors resize-y"
        />
      )}

      {/* Status */}
      {error ? (
        <p className="text-[11px] text-error">{error}</p>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-text-tertiary font-mono truncate">
            {source.path}
          </span>
          <span className="text-[10px] text-text-tertiary">
            {dirty ? "Modified" : "Saved"}
            {source.last_synced_at && ` · Last synced: ${new Date(source.last_synced_at).toLocaleString()}`}
          </span>
        </div>
      )}
    </div>
  );
}

function ImportModal({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (json: string) => void;
}) {
  const [json, setJson] = useState("");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[400px] bg-surface-raised border border-border-subtle rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">
            Import Snippets
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-text-tertiary hover:text-text-secondary rounded transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="p-4">
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={10}
            placeholder="Paste JSON here..."
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors resize-y"
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5 rounded-md border border-border-subtle"
          >
            Cancel
          </button>
          <button
            onClick={() => onImport(json)}
            disabled={!json.trim()}
            className="text-xs text-white bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors px-3 py-1.5 rounded-md"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

export function YaptureSettings({ onBack, onHotkeyConfigChanged, onBannerConfigChanged }: YaptureSettingsProps) {
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
        <button
          onClick={() => setActiveTab("notifications")}
          className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
            activeTab === "notifications"
              ? "text-text-primary border-accent"
              : "text-text-tertiary border-transparent hover:text-text-secondary"
          }`}
        >
          Notifications
        </button>
        <button
          onClick={() => setActiveTab("sources")}
          className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
            activeTab === "sources"
              ? "text-text-primary border-accent"
              : "text-text-tertiary border-transparent hover:text-text-secondary"
          }`}
        >
          Expansion Sources
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "yapture" && <YaptureTab />}
        {activeTab === "hotkeys" && (
          <HotkeySettings onConfigChanged={onHotkeyConfigChanged} />
        )}
        {activeTab === "notifications" && (
          <NotificationSettingsTab onConfigChanged={onBannerConfigChanged} />
        )}
        {activeTab === "sources" && <ExpansionSourcesTab />}
      </div>
    </div>
  );
}
