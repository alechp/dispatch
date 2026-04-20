import { useState, useEffect, useCallback, useContext } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  listNotificationAccounts,
  toggleNotificationAccount,
  deleteNotificationAccount,
  updateNotificationAccountLabel,
  getAccountScreenToggles,
  setAccountScreenToggle,
  setMonitoredChannels,
  testAccountConnection,
  discordStartOAuth,
  discordFetchChannels,
  slackStartOAuth,
  slackFetchConversations,
  getMacosPushConfig,
  setMacosPushConfig,
  sendTestPush,
  slackRelaySaveConfig,
  slackRelayTestConnection,
  slackRelayStartPolling,
  slackRelayStopPolling,
  slackRelayStatus,
} from "../lib/api";
import type { MacOSPushConfig, DiscordChannel, SlackConversation, SlackRelayStatus } from "../lib/api";
import type { NotificationAccount, AccountScreenToggles, BannerScreenKey } from "../lib/types";
import { PROVIDER_COLORS, BANNER_SCREEN_LABELS } from "../lib/types";
import { ToastContext } from "../hooks/useToast";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface IntegrationSettingsProps {
  onBack?: () => void;
}

// ---------------------------------------------------------------------------
// Provider icons (inline SVG)
// ---------------------------------------------------------------------------

function DiscordIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
    </svg>
  );
}

function SlackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// AccountCard
// ---------------------------------------------------------------------------

function AccountCard({
  account,
  onRefresh,
  showToast,
}: {
  account: NotificationAccount;
  onRefresh: () => void;
  showToast: (msg: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelValue, setLabelValue] = useState(account.account_label);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Screen toggles
  const [screenToggles, setScreenToggles] = useState<AccountScreenToggles | null>(null);
  const [loadingToggles, setLoadingToggles] = useState(false);

  // Channel picker
  const [channels, setChannels] = useState<(DiscordChannel | SlackConversation)[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(
    new Set(account.sync_channels ?? [])
  );
  const [savingChannels, setSavingChannels] = useState(false);

  const colors = PROVIDER_COLORS[account.provider];

  // Load screen toggles when expanded
  useEffect(() => {
    if (!expanded) return;
    setLoadingToggles(true);
    getAccountScreenToggles(account.id)
      .then(setScreenToggles)
      .catch((err) => console.error("[integration] Failed to load screen toggles:", err))
      .finally(() => setLoadingToggles(false));
  }, [expanded, account.id]);

  const handleToggleEnabled = useCallback(async () => {
    try {
      await toggleNotificationAccount(account.id, !account.is_enabled);
      onRefresh();
    } catch (err) {
      console.error("[integration] Toggle failed:", err);
      showToast(`Failed to toggle account: ${err}`);
    }
  }, [account.id, account.is_enabled, onRefresh, showToast]);

  const handleSaveLabel = useCallback(async () => {
    try {
      await updateNotificationAccountLabel(account.id, labelValue);
      setEditingLabel(false);
      onRefresh();
      showToast("Label updated");
    } catch (err) {
      console.error("[integration] Label update failed:", err);
      showToast(`Failed to update label: ${err}`);
    }
  }, [account.id, labelValue, onRefresh, showToast]);

  const handleTest = useCallback(async () => {
    setTestStatus("testing");
    try {
      await testAccountConnection(account.id);
      setTestStatus("success");
    } catch {
      setTestStatus("error");
    }
    setTimeout(() => setTestStatus("idle"), 3000);
  }, [account.id]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteNotificationAccount(account.id);
      showToast("Account removed");
      onRefresh();
    } catch (err) {
      console.error("[integration] Delete failed:", err);
      showToast(`Failed to delete account: ${err}`);
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [account.id, onRefresh, showToast]);

  const handleScreenToggle = useCallback(
    async (screen: BannerScreenKey) => {
      if (!screenToggles) return;
      const newValue = !screenToggles.screens[screen];
      try {
        await setAccountScreenToggle(account.id, screen, newValue);
        setScreenToggles({
          ...screenToggles,
          screens: { ...screenToggles.screens, [screen]: newValue },
        });
      } catch (err) {
        console.error("[integration] Screen toggle failed:", err);
        showToast(`Failed to update screen toggle: ${err}`);
      }
    },
    [account.id, screenToggles, showToast]
  );

  const handleFetchChannels = useCallback(async () => {
    setLoadingChannels(true);
    try {
      if (account.provider === "discord") {
        const chs = await discordFetchChannels(account.id);
        setChannels(chs);
      } else if (account.provider === "slack") {
        const convos = await slackFetchConversations(account.id);
        setChannels(convos);
      }
    } catch (err) {
      console.error("[integration] Fetch channels failed:", err);
      showToast(`Failed to fetch channels: ${err}`);
    } finally {
      setLoadingChannels(false);
    }
  }, [account.id, account.provider, showToast]);

  const handleToggleChannel = useCallback((id: string) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSaveChannels = useCallback(async () => {
    setSavingChannels(true);
    try {
      const channelList = Array.from(selectedChannels).join(",");
      await setMonitoredChannels(account.id, channelList);
      showToast("Monitored channels updated");
      onRefresh();
    } catch (err) {
      console.error("[integration] Save channels failed:", err);
      showToast(`Failed to save channels: ${err}`);
    } finally {
      setSavingChannels(false);
    }
  }, [account.id, selectedChannels, onRefresh, showToast]);

  const screenKeys = Object.keys(BANNER_SCREEN_LABELS) as BannerScreenKey[];

  return (
    <div
      className={`bg-surface-raised border border-border-subtle rounded-lg overflow-hidden border-l-4 ${colors.border} transition-all`}
    >
      {/* Card header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 hover:bg-surface-overlay/30 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className={colors.text}>
              {account.provider === "discord" ? <DiscordIcon /> : <SlackIcon />}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-primary truncate">
                  {account.account_label}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${colors.badge} ${colors.text}`}
                >
                  {account.provider}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                {account.provider_username && (
                  <span className="text-[11px] text-text-secondary">
                    {account.provider_username}
                  </span>
                )}
                {account.provider_team_name && (
                  <span className="text-[11px] text-text-tertiary">
                    {account.provider_team_name}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0" onClick={(e) => e.stopPropagation()}>
            {/* Enabled toggle */}
            <button
              onClick={handleToggleEnabled}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                account.is_enabled
                  ? "bg-accent"
                  : "bg-surface-overlay border border-border-subtle"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  account.is_enabled ? "translate-x-5" : ""
                }`}
              />
            </button>
            {/* Expand chevron */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`text-text-tertiary transition-transform ${expanded ? "rotate-90" : ""}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border-subtle px-4 py-3 space-y-4">
          {/* Edit label */}
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1.5">
              Label
            </label>
            {editingLabel ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={labelValue}
                  onChange={(e) => setLabelValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveLabel();
                    if (e.key === "Escape") {
                      setLabelValue(account.account_label);
                      setEditingLabel(false);
                    }
                  }}
                  autoFocus
                  className="flex-1 bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
                />
                <button
                  onClick={handleSaveLabel}
                  className="text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setLabelValue(account.account_label);
                    setEditingLabel(false);
                  }}
                  className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-primary">{account.account_label}</span>
                <button
                  onClick={() => setEditingLabel(true)}
                  className="text-[11px] text-accent hover:text-accent-hover transition-colors"
                >
                  Edit
                </button>
              </div>
            )}
          </div>

          {/* Per-screen visibility toggles */}
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1.5">
              Show on screens
            </label>
            {loadingToggles ? (
              <p className="text-[11px] text-text-tertiary">Loading...</p>
            ) : screenToggles ? (
              <div className="bg-surface-overlay border border-border-subtle rounded-lg divide-y divide-border-subtle">
                {screenKeys.map((key) => (
                  <div key={key} className="flex items-center justify-between px-3 py-2">
                    <span className="text-xs text-text-primary">{BANNER_SCREEN_LABELS[key]}</span>
                    <button
                      onClick={() => handleScreenToggle(key)}
                      className={`relative w-8 h-4 rounded-full transition-colors ${
                        screenToggles.screens[key]
                          ? "bg-accent"
                          : "bg-surface border border-border-subtle"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                          screenToggles.screens[key] ? "translate-x-4" : ""
                        }`}
                      />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* Channel picker */}
          {(account.provider === "discord" || account.provider === "slack") && (
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1.5">
                Monitored channels
              </label>
              {channels.length === 0 ? (
                <button
                  onClick={handleFetchChannels}
                  disabled={loadingChannels}
                  className="px-3 py-1.5 text-xs font-medium text-text-primary bg-surface-overlay border border-border-subtle rounded-md hover:border-accent/30 transition-colors disabled:opacity-50"
                >
                  {loadingChannels ? "Fetching..." : "Fetch Channels"}
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="bg-surface-overlay border border-border-subtle rounded-lg max-h-40 overflow-y-auto divide-y divide-border-subtle">
                    {channels.map((ch) => {
                      const chId = ch.id;
                      const chName = ch.name;
                      const isSelected = selectedChannels.has(chId);
                      return (
                        <label
                          key={chId}
                          className="flex items-center gap-2 px-3 py-2 hover:bg-surface-raised/50 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleChannel(chId)}
                            className="rounded border-border-subtle accent-accent"
                          />
                          <span className="text-xs text-text-primary"># {chName}</span>
                          {"is_private" in ch && ch.is_private && (
                            <span className="text-[10px] text-text-tertiary">private</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveChannels}
                      disabled={savingChannels}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
                    >
                      {savingChannels ? "Saving..." : "Save Channels"}
                    </button>
                    <button
                      onClick={handleFetchChannels}
                      disabled={loadingChannels}
                      className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
                    >
                      Refresh
                    </button>
                    <span className="text-[10px] text-text-tertiary ml-auto">
                      {selectedChannels.size} selected
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Actions row */}
          <div className="flex items-center gap-3 pt-1 border-t border-border-subtle">
            <button
              onClick={handleTest}
              disabled={testStatus === "testing"}
              className="px-3 py-1.5 text-xs font-medium text-text-primary bg-surface-overlay border border-border-subtle rounded-md hover:border-accent/30 transition-colors disabled:opacity-50"
            >
              {testStatus === "testing" ? "Testing..." : "Test Connection"}
            </button>
            {testStatus === "success" && (
              <span className="text-xs text-success">Connected</span>
            )}
            {testStatus === "error" && (
              <span className="text-xs text-error">Failed</span>
            )}

            <div className="ml-auto">
              {confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-error">Are you sure?</span>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="px-2.5 py-1 text-xs font-medium text-white bg-error hover:bg-red-600 rounded-md transition-colors disabled:opacity-50"
                  >
                    {deleting ? "Deleting..." : "Yes, remove"}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-xs text-error hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddAccountPanel
// ---------------------------------------------------------------------------

function AddAccountPanel({
  showToast,
}: {
  showToast: (msg: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "discord" | "slack">("idle");
  const [clientId, setClientId] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [connecting, setConnecting] = useState(false);

  const handleDiscordOAuth = useCallback(async () => {
    if (!clientId.trim()) {
      showToast("Please enter a Discord Client ID");
      return;
    }
    setConnecting(true);
    try {
      const url = await discordStartOAuth(clientId.trim());
      await openUrl(url);
      showToast("Discord OAuth started -- complete in browser");
    } catch (err) {
      console.error("[integration] Discord OAuth failed:", err);
      showToast(`Discord OAuth failed: ${err}`);
    } finally {
      setConnecting(false);
    }
  }, [clientId, showToast]);

  const handleSlackOAuth = useCallback(async () => {
    if (!clientId.trim()) {
      showToast("Please enter a Slack Client ID");
      return;
    }
    if (!relayUrl.trim()) {
      showToast("Please enter a Relay URL");
      return;
    }
    setConnecting(true);
    try {
      const url = await slackStartOAuth(clientId.trim(), relayUrl.trim());
      await openUrl(url);
      showToast("Slack OAuth started -- complete in browser");
    } catch (err) {
      console.error("[integration] Slack OAuth failed:", err);
      showToast(`Slack OAuth failed: ${err}`);
    } finally {
      setConnecting(false);
    }
  }, [clientId, relayUrl, showToast]);

  if (mode === "idle") {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => setMode("discord")}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors"
        >
          <DiscordIcon />
          Connect Discord
        </button>
        <button
          onClick={() => setMode("slack")}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors"
        >
          <SlackIcon />
          Connect Slack
        </button>
      </div>
    );
  }

  return (
    <div className="bg-surface-raised border border-border-subtle rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-text-primary">
          {mode === "discord" ? "Connect Discord" : "Connect Slack"}
        </h3>
        <button
          onClick={() => {
            setMode("idle");
            setClientId("");
            setRelayUrl("");
          }}
          className="p-1 text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div>
        <label className="block text-[11px] text-text-secondary mb-1">Client ID</label>
        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={mode === "discord" ? "Discord Application Client ID" : "Slack App Client ID"}
          className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
        />
      </div>

      {mode === "slack" && (
        <div>
          <label className="block text-[11px] text-text-secondary mb-1">Relay URL</label>
          <input
            type="text"
            value={relayUrl}
            onChange={(e) => setRelayUrl(e.target.value)}
            placeholder="https://your-relay.example.com"
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>
      )}

      <button
        onClick={mode === "discord" ? handleDiscordOAuth : handleSlackOAuth}
        disabled={connecting || !clientId.trim() || (mode === "slack" && !relayUrl.trim())}
        className="w-full px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {connecting ? "Opening browser..." : "Authorize"}
      </button>

      <p className="text-[10px] text-text-tertiary">
        This will open your browser to complete the OAuth flow. The account will appear here after authorization.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MacOSPushSection
// ---------------------------------------------------------------------------

function MacOSPushSection({ showToast }: { showToast: (msg: string) => void }) {
  const [config, setConfig] = useState<MacOSPushConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    getMacosPushConfig()
      .then(setConfig)
      .catch((err) => console.error("[integration] Failed to load push config:", err))
      .finally(() => setLoading(false));
  }, []);

  const updateConfig = useCallback(
    async (updates: Partial<MacOSPushConfig>) => {
      if (!config) return;
      const updated = { ...config, ...updates };
      setConfig(updated);
      try {
        await setMacosPushConfig(updated);
      } catch (err) {
        console.error("[integration] Failed to save push config:", err);
        showToast(`Failed to save push config: ${err}`);
      }
    },
    [config, showToast]
  );

  const handleSendTest = useCallback(async () => {
    setSending(true);
    try {
      await sendTestPush();
      showToast("Test notification sent");
    } catch (err) {
      console.error("[integration] Test push failed:", err);
      showToast(`Test push failed: ${err}`);
    } finally {
      setSending(false);
    }
  }, [showToast]);

  if (loading) {
    return <p className="text-xs text-text-tertiary">Loading push config...</p>;
  }

  if (!config) {
    return <p className="text-xs text-error">Failed to load push configuration.</p>;
  }

  return (
    <div className="space-y-3">
      {/* Enable push */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm text-text-primary">Push Notifications</span>
          <p className="text-[10px] text-text-tertiary mt-0.5">
            Show macOS native push notifications
          </p>
        </div>
        <button
          onClick={() => updateConfig({ enabled: !config.enabled })}
          className={`relative w-10 h-5 rounded-full transition-colors ${
            config.enabled
              ? "bg-accent"
              : "bg-surface-overlay border border-border-subtle"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              config.enabled ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>

      <div
        className={`space-y-3 transition-opacity ${
          config.enabled ? "" : "opacity-50 pointer-events-none"
        }`}
      >
        {/* Sound toggle */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-primary">Sound</span>
          <button
            onClick={() => updateConfig({ sound: !config.sound })}
            className={`relative w-8 h-4 rounded-full transition-colors ${
              config.sound
                ? "bg-accent"
                : "bg-surface-overlay border border-border-subtle"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                config.sound ? "translate-x-4" : ""
              }`}
            />
          </button>
        </div>

        {/* Quiet hours */}
        <div>
          <label className="block text-xs text-text-primary mb-1.5">Quiet Hours</label>
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={config.quiet_hours_start ?? ""}
              onChange={(e) =>
                updateConfig({ quiet_hours_start: e.target.value || null })
              }
              className="bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50 transition-colors"
            />
            <span className="text-xs text-text-tertiary">to</span>
            <input
              type="time"
              value={config.quiet_hours_end ?? ""}
              onChange={(e) =>
                updateConfig({ quiet_hours_end: e.target.value || null })
              }
              className="bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <p className="text-[10px] text-text-tertiary mt-1">
            Notifications are silenced during quiet hours. Leave blank to disable.
          </p>
        </div>

        {/* Suppress when focused */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-text-primary">Suppress when focused</span>
            <p className="text-[10px] text-text-tertiary mt-0.5">
              Skip push when the Dispatch window is focused
            </p>
          </div>
          <button
            onClick={() =>
              updateConfig({ suppress_when_focused: !config.suppress_when_focused })
            }
            className={`relative w-8 h-4 rounded-full transition-colors ${
              config.suppress_when_focused
                ? "bg-accent"
                : "bg-surface-overlay border border-border-subtle"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                config.suppress_when_focused ? "translate-x-4" : ""
              }`}
            />
          </button>
        </div>

        {/* Test push */}
        <button
          onClick={handleSendTest}
          disabled={sending}
          className="px-4 py-1.5 text-xs font-medium text-text-primary bg-surface-overlay border border-border-subtle rounded-md hover:border-accent/30 transition-colors disabled:opacity-50"
        >
          {sending ? "Sending..." : "Send Test Notification"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SlackRelaySection
// ---------------------------------------------------------------------------

function SlackRelaySection({ showToast }: { showToast: (msg: string) => void }) {
  const [relayUrl, setRelayUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pollInterval, setPollInterval] = useState(30);
  const [status, setStatus] = useState<SlackRelayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load current status + config on mount
  useEffect(() => {
    slackRelayStatus()
      .then((s) => {
        setStatus(s);
        if (s.relay_url) setRelayUrl(s.relay_url);
        setPollInterval(s.poll_interval || 30);
      })
      .catch((err) => console.error("[integration] Failed to load relay status:", err))
      .finally(() => setLoading(false));
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await slackRelayStatus();
      setStatus(s);
    } catch (err) {
      console.error("[integration] status refresh failed:", err);
    }
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (!relayUrl.trim()) {
      showToast("Please enter a relay URL");
      return;
    }
    setTesting(true);
    try {
      await slackRelayTestConnection(relayUrl.trim());
      showToast("Relay server is reachable");
    } catch (err) {
      showToast(`Connection failed: ${err}`);
    } finally {
      setTesting(false);
    }
  }, [relayUrl, showToast]);

  const handleSave = useCallback(async () => {
    if (!relayUrl.trim() || !apiKey.trim()) {
      showToast("Relay URL and API key are required");
      return;
    }
    setSaving(true);
    try {
      await slackRelaySaveConfig(relayUrl.trim(), apiKey.trim(), pollInterval);
      showToast("Relay config saved");
      await refreshStatus();
    } catch (err) {
      showToast(`Failed to save config: ${err}`);
    } finally {
      setSaving(false);
    }
  }, [relayUrl, apiKey, pollInterval, showToast, refreshStatus]);

  const handleTogglePolling = useCallback(async () => {
    try {
      if (status?.is_running) {
        await slackRelayStopPolling();
        showToast("Polling stopped");
      } else {
        await slackRelayStartPolling();
        showToast("Polling started");
      }
      await refreshStatus();
    } catch (err) {
      showToast(`Failed to toggle polling: ${err}`);
    }
  }, [status?.is_running, showToast, refreshStatus]);

  if (loading) {
    return <p className="text-xs text-text-tertiary">Loading relay config...</p>;
  }

  return (
    <div className="space-y-3">
      {/* Relay URL */}
      <div>
        <label className="block text-[11px] text-text-secondary mb-1">Relay Server URL</label>
        <input
          type="text"
          value={relayUrl}
          onChange={(e) => setRelayUrl(e.target.value)}
          placeholder="http://localhost:3001"
          className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
        />
      </div>

      {/* API Key */}
      <div>
        <label className="block text-[11px] text-text-secondary mb-1">API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Your relay poll API key"
          className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
        />
      </div>

      {/* Poll interval */}
      <div>
        <label className="block text-[11px] text-text-secondary mb-1">Poll Interval</label>
        <select
          value={pollInterval}
          onChange={(e) => setPollInterval(Number(e.target.value))}
          className="bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50 transition-colors"
        >
          <option value={15}>15 seconds</option>
          <option value={30}>30 seconds</option>
          <option value={60}>1 minute</option>
          <option value={300}>5 minutes</option>
        </select>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleSave}
          disabled={saving || !relayUrl.trim() || !apiKey.trim()}
          className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Config"}
        </button>
        <button
          onClick={handleTestConnection}
          disabled={testing || !relayUrl.trim()}
          className="px-3 py-1.5 text-xs font-medium text-text-primary bg-surface-overlay border border-border-subtle rounded-md hover:border-accent/30 transition-colors disabled:opacity-50"
        >
          {testing ? "Testing..." : "Test Connection"}
        </button>
        <button
          onClick={handleTogglePolling}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            status?.is_running
              ? "text-error bg-error/10 border border-error/20 hover:bg-error/20"
              : "text-text-primary bg-surface-overlay border border-border-subtle hover:border-accent/30"
          }`}
        >
          {status?.is_running ? "Stop Polling" : "Start Polling"}
        </button>
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-3 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              status?.is_running ? "bg-success" : "bg-text-tertiary"
            }`}
          />
          <span className="text-text-secondary">
            {status?.is_running ? "Polling active" : "Polling stopped"}
          </span>
        </div>
        {status?.last_poll && (
          <span className="text-text-tertiary">
            Last poll: {new Date(status.last_poll).toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IntegrationSettings (main export)
// ---------------------------------------------------------------------------

export function IntegrationSettings({ onBack }: IntegrationSettingsProps) {
  const { showToast } = useContext(ToastContext);
  const [accounts, setAccounts] = useState<NotificationAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshAccounts = useCallback(async () => {
    try {
      const accs = await listNotificationAccounts();
      setAccounts(accs);
      setError(null);
    } catch (err) {
      console.error("[integration] Failed to load accounts:", err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    refreshAccounts();
  }, [refreshAccounts]);

  // Listen for OAuth completion events
  useEffect(() => {
    const unlistenDiscord = listen("discord-account-linked", () => {
      showToast("Discord account linked");
      refreshAccounts();
    });
    const unlistenSlack = listen("slack-account-linked", () => {
      showToast("Slack account linked");
      refreshAccounts();
    });
    return () => {
      unlistenDiscord.then((fn) => fn());
      unlistenSlack.then((fn) => fn());
    };
  }, [refreshAccounts, showToast]);

  const discordAccounts = accounts.filter((a) => a.provider === "discord");
  const slackAccounts = accounts.filter((a) => a.provider === "slack");

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-surface">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-surface shrink-0">
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors shrink-0"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </button>
        )}
        <h2 className="text-sm font-semibold text-text-primary">Integrations</h2>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Add account */}
        <div>
          <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-2">
            Connect an account
          </label>
          <AddAccountPanel showToast={showToast} />
        </div>

        {/* Accounts list */}
        <div>
          <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-2">
            Connected accounts
          </label>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-xs text-text-tertiary">Loading accounts...</p>
            </div>
          ) : error ? (
            <div className="py-4 px-3 bg-error/10 border border-error/20 rounded-lg">
              <p className="text-xs text-error">{error}</p>
              <button
                onClick={refreshAccounts}
                className="mt-2 text-[11px] text-accent hover:text-accent-hover transition-colors"
              >
                Retry
              </button>
            </div>
          ) : accounts.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-xs text-text-tertiary mb-1">No accounts connected.</p>
              <p className="text-[10px] text-text-tertiary">
                Use the buttons above to connect Discord or Slack.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {discordAccounts.length > 0 && (
                <div className="space-y-2">
                  {discordAccounts.map((acc) => (
                    <AccountCard
                      key={acc.id}
                      account={acc}
                      onRefresh={refreshAccounts}
                      showToast={showToast}
                    />
                  ))}
                </div>
              )}
              {slackAccounts.length > 0 && (
                <div className="space-y-2">
                  {slackAccounts.map((acc) => (
                    <AccountCard
                      key={acc.id}
                      account={acc}
                      onRefresh={refreshAccounts}
                      showToast={showToast}
                    />
                  ))}
                </div>
              )}
              {/* Other providers (yapture, terminal) -- just in case */}
              {accounts
                .filter((a) => a.provider !== "discord" && a.provider !== "slack")
                .map((acc) => (
                  <AccountCard
                    key={acc.id}
                    account={acc}
                    onRefresh={refreshAccounts}
                    showToast={showToast}
                  />
                ))}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-border-subtle" />

        {/* Slack Relay section */}
        <div>
          <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-3">
            Slack Relay (Event Subscriptions)
          </label>
          <SlackRelaySection showToast={showToast} />
        </div>

        {/* Divider */}
        <div className="border-t border-border-subtle" />

        {/* macOS Push section */}
        <div>
          <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-3">
            macOS Push Notifications
          </label>
          <MacOSPushSection showToast={showToast} />
        </div>
      </div>
    </div>
  );
}
