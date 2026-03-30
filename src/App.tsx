import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Header } from "./components/Header";
import { FilterBar } from "./components/FilterBar";
import { NotificationFeed } from "./components/NotificationFeed";
import { HotkeyHelp } from "./components/HotkeyHelp";
import { Toast } from "./components/Toast";
import { CommandPalette } from "./components/CommandPalette";
import { useNotifications } from "./hooks/useNotifications";
import { useNotificationListener } from "./hooks/useNotificationListener";
import { useSound } from "./hooks/useSound";
import { useHotkeys } from "./hooks/useHotkeys";
import { ToastContext, useToastProvider } from "./hooks/useToast";
import { deleteNotification, focusTerminal, getNotificationBannerConfig } from "./lib/api";
import { copyToClipboard } from "./lib/liveExpansion";
import { trackEvent } from "./lib/telemetry";
import { TelemetryScreen } from "./components/TelemetryScreen";
import { SessionContent } from "./components/SessionTracker";
import { SnippetManager } from "./components/SnippetManager";
import { ExpanderPalette } from "./components/ExpanderPalette";
import { YaptureSettings } from "./components/YaptureSettings";
import { NotificationBanner } from "./components/NotificationBanner";
import { listen } from "@tauri-apps/api/event";
import { getExpandPrefix, createBoilerplateConfig, syncSnippetSource } from "./lib/snippets";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Notification, QueryFilters, NotificationBannerConfig, BannerScreenKey } from "./lib/types";
import { DEFAULT_BANNER_CONFIG } from "./lib/types";

export type ActiveScreen = "feed" | "telemetry" | "expander" | "settings";
export type FeedView = "notifications" | "sessions";

const SCREEN_ORDER: ActiveScreen[] = ["feed", "telemetry", "expander", "settings"];

export default function App() {
  const toastCtx = useToastProvider();
  const [filter, setFilter] = useState<"all" | "unread" | "read">("all");
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>("feed");
  const [feedView, setFeedView] = useState<FeedView>("notifications");
  const [showExpanderPalette, setShowExpanderPalette] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [bannerQueue, setBannerQueue] = useState<Notification[]>([]);
  const [visualMode, setVisualMode] = useState(false);
  const [visualSelections, setVisualSelections] = useState<Set<string>>(new Set());
  const [expandPrefix, setExpandPrefix] = useState(":");
  const [visualAnchor, setVisualAnchor] = useState<number | null>(null);
  const [bannerConfig, setBannerConfig] = useState<NotificationBannerConfig>(DEFAULT_BANNER_CONFIG);
  const searchRef = useRef<HTMLInputElement>(null);

  const queryFilters: QueryFilters = {
    ...(filter === "unread" ? { is_read: 0 } : {}),
    ...(filter === "read" ? { is_read: 1 } : {}),
    ...(search ? { search } : {}),
    limit: 100,
  };

  const { notifications, total, loading, refresh, markRead, markAllRead, clearAll } =
    useNotifications(queryFilters);

  const { play } = useSound();

  const unreadCount = notifications.filter((n) => n.is_read === 0).length;

  const currentScreenKey: BannerScreenKey = useMemo(() => {
    if (activeScreen === "feed") return `feed/${feedView}` as BannerScreenKey;
    return activeScreen as BannerScreenKey;
  }, [activeScreen, feedView]);

  // Load banner config on mount
  useEffect(() => {
    getNotificationBannerConfig().then(setBannerConfig).catch(() => {});
  }, []);

  const refreshBannerConfig = useCallback(() => {
    getNotificationBannerConfig().then(setBannerConfig).catch(() => {});
  }, []);

  const handleNewNotification = useCallback(
    (notification: Notification) => {
      play();
      refresh();
      if (bannerConfig.globalEnabled && bannerConfig.screens[currentScreenKey] === true) {
        setBannerQueue((prev) => [notification, ...prev]);
      }
    },
    [play, refresh, bannerConfig, currentScreenKey]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteNotification(id);
      trackEvent("notification_deleted", { targetId: id, metadata: { method: "click" } });
      refresh();
    },
    [refresh]
  );

  const handleFocusTerminal = useCallback(
    async (id: string, session: string, window: string | null, pane: string | null) => {
      markRead(id);
      trackEvent("notification_read", { targetId: id, metadata: { method: "terminal_focus" } });
      trackEvent("terminal_focused", { targetId: id, metadata: { session, window, pane } });
      await focusTerminal(session, window ?? undefined, pane ?? undefined, id);
      toastCtx.showToast(`Focused terminal: ${session}`);
    },
    [markRead, toastCtx]
  );

  const handleMarkRead = useCallback(
    (id: string) => {
      markRead(id);
      trackEvent("notification_read", { targetId: id, metadata: { method: "click" } });
    },
    [markRead]
  );

  useNotificationListener(handleNewNotification, refresh);

  // Load expand prefix from settings
  useEffect(() => {
    getExpandPrefix().then(setExpandPrefix).catch(() => {});
  }, []);

  // Listen for global CMD+SHIFT+K hotkey → toggle command palette
  useEffect(() => {
    const unlisten = listen("show-command-palette", () => {
      setShowCommandPalette((prev) => !prev);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Auto-select first notification when window is shown via global hotkey
  useEffect(() => {
    const unlisten = listen("auto-select-first", () => {
      if (notifications.length > 0) {
        setSelectedIndex(0);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [notifications.length]);

  // CMD+1-5 screen navigation & CMD+K command palette
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (!e.metaKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === "k") {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
        return;
      }

      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= SCREEN_ORDER.length) {
        e.preventDefault();
        setActiveScreen(SCREEN_ORDER[idx - 1]);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleExpand = useCallback((text: string) => {
    copyToClipboard(text);
    toastCtx.showToast("Copied to clipboard");
    setShowExpanderPalette(false);
    setShowCommandPalette(false);
  }, [toastCtx]);

  const handleNewConfig = useCallback(async () => {
    try {
      const folder = await openDialog({ directory: true, title: "Choose folder for new expansion config" });
      if (!folder) return;
      const path = typeof folder === "string" ? folder : (folder as any);
      if (!path) return;
      const name = window.prompt("Package name:", path.split("/").pop() || "snippets");
      if (!name) return;
      const source = await createBoilerplateConfig(path, name);
      const result = await syncSnippetSource(source.id);
      toastCtx.showToast(`Created config with ${result.added} snippets in ${path}`);
      setActiveScreen("expander");
    } catch (err: any) {
      console.error("Boilerplate failed:", err);
      toastCtx.showToast(`Failed: ${err}`);
    }
  }, [toastCtx]);

  // Reset selection when filter or search changes
  useEffect(() => {
    setSelectedIndex(null);
    setVisualMode(false);
    setVisualSelections(new Set());
    setVisualAnchor(null);
  }, [filter, search]);

  const hotkeyActions = useMemo(
    () => ({
      selectNext: () => {
        setSelectedIndex((prev) => {
          const next = prev === null ? 0 : Math.min(prev + 1, notifications.length - 1);
          if (visualMode && visualAnchor !== null) {
            const lo = Math.min(visualAnchor, next);
            const hi = Math.max(visualAnchor, next);
            setVisualSelections(new Set(notifications.slice(lo, hi + 1).map(n => n.id)));
          }
          return next;
        });
      },
      selectPrev: () => {
        setSelectedIndex((prev) => {
          const next = prev === null ? 0 : Math.max(prev - 1, 0);
          if (visualMode && visualAnchor !== null) {
            const lo = Math.min(visualAnchor, next);
            const hi = Math.max(visualAnchor, next);
            setVisualSelections(new Set(notifications.slice(lo, hi + 1).map(n => n.id)));
          }
          return next;
        });
      },
      markSelectedRead: () => {
        if (visualMode && visualSelections.size > 0) {
          for (const nid of visualSelections) {
            markRead(nid);
            trackEvent("notification_read", { targetId: nid, metadata: { method: "visual" } });
          }
          setVisualMode(false);
          setVisualSelections(new Set());
          setVisualAnchor(null);
        } else if (selectedIndex !== null && notifications[selectedIndex]) {
          const n = notifications[selectedIndex];
          markRead(n.id);
          trackEvent("notification_read", { targetId: n.id, metadata: { method: "hotkey" } });
        }
      },
      deleteSelected: () => {
        if (visualMode && visualSelections.size > 0) {
          for (const nid of visualSelections) {
            handleDelete(nid);
            trackEvent("notification_deleted", { targetId: nid, metadata: { method: "visual" } });
          }
          setVisualMode(false);
          setVisualSelections(new Set());
          setVisualAnchor(null);
          setSelectedIndex((prev) => {
            if (prev === null) return null;
            return Math.min(prev, Math.max(0, notifications.length - visualSelections.size - 1));
          });
        } else if (selectedIndex !== null && notifications[selectedIndex]) {
          const n = notifications[selectedIndex];
          handleDelete(n.id);
          trackEvent("notification_deleted", { targetId: n.id, metadata: { method: "hotkey" } });
          setSelectedIndex((prev) => {
            if (prev === null) return null;
            if (prev >= notifications.length - 1) return Math.max(0, prev - 1);
            return prev;
          });
        }
      },
      focusTerminal: () => {
        if (activeScreen !== "feed" || feedView !== "notifications") {
          return;
        }
        if (selectedIndex === null) {
          toastCtx.showToast("Select a notification first (j/k)");
          return;
        }
        const n = notifications[selectedIndex];
        if (!n?.tmux_session) {
          toastCtx.showToast("No terminal session on this notification");
          return;
        }
        handleFocusTerminal(n.id, n.tmux_session, n.tmux_window, n.tmux_pane);
      },
      markAllRead: () => {
        markAllRead();
        trackEvent("notification_read", { metadata: { method: "mark_all" } });
      },
      clearAll: () => {
        trackEvent("clear_all", { metadata: { count: notifications.length } });
        clearAll();
      },
      focusSearch: () => searchRef.current?.focus(),
      clearSelection: () => {
        if (visualMode) {
          setVisualMode(false);
          setVisualSelections(new Set());
          setVisualAnchor(null);
        } else {
          setSelectedIndex(null);
        }
      },
      setFilter: (f: "all" | "unread" | "read") => {
        setFilter(f);
        trackEvent("filter_changed", { metadata: { filter: f } });
      },
      toggleHelp: () => setShowHelp((prev) => !prev),
      toggleVisualMode: () => {
        if (visualMode) {
          setVisualMode(false);
          setVisualSelections(new Set());
          setVisualAnchor(null);
        } else {
          const idx = selectedIndex ?? 0;
          setSelectedIndex(idx);
          setVisualMode(true);
          setVisualAnchor(idx);
          const id = notifications[idx]?.id;
          if (id) setVisualSelections(new Set([id]));
        }
      },
      visualToggleItem: () => {
        if (!visualMode || selectedIndex === null) return;
        const id = notifications[selectedIndex]?.id;
        if (!id) return;
        setVisualSelections((prev) => {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
      },
    }),
    [selectedIndex, notifications, markRead, handleDelete, handleFocusTerminal, markAllRead, clearAll, visualMode, visualAnchor, visualSelections, activeScreen, feedView, toastCtx]
  );

  const { config: hotkeyConfig, refreshConfig } = useHotkeys(hotkeyActions);

  const handleCommandPaletteAction = useCallback(
    (action: string) => {
      switch (action) {
        case "go_feed": setActiveScreen("feed"); setFeedView("notifications"); break;
        case "go_sessions": setActiveScreen("feed"); setFeedView("sessions"); break;
        case "go_telemetry": setActiveScreen("telemetry"); break;
        case "go_expander": setActiveScreen("expander"); break;
        case "go_settings": setActiveScreen("settings"); break;
        case "mark_all_read": markAllRead(); break;
        case "clear_all": clearAll(); break;
        case "toggle_help": setShowHelp(true); break;
        case "new_config": handleNewConfig(); break;
      }
      setShowCommandPalette(false);
    },
    [markAllRead, clearAll, handleNewConfig]
  );

  return (
    <ToastContext.Provider value={toastCtx}>
    <div className="flex flex-col h-screen">
      <Header
        unreadCount={filter === "all" ? unreadCount : total}
        onMarkAllRead={markAllRead}
        onClearAll={clearAll}
        activeScreen={activeScreen}
        onScreenChange={setActiveScreen}
        feedView={feedView}
        onFeedViewChange={setFeedView}
      />
      {activeScreen === "feed" && feedView === "notifications" && (
        <>
          <FilterBar
            onSearchChange={setSearch}
            onFilterChange={setFilter}
            activeFilter={filter}
            searchRef={searchRef}
          />
          {visualMode && (
            <div className="flex items-center justify-between px-4 py-1.5 bg-warning/10 border-b border-warning/20">
              <span className="text-xs font-medium text-warning">-- VISUAL --</span>
              <span className="text-xs text-text-secondary">{visualSelections.size} selected</span>
            </div>
          )}
          <NotificationFeed
            notifications={notifications}
            loading={loading}
            onMarkRead={handleMarkRead}
            onDelete={handleDelete}
            onFocusTerminal={handleFocusTerminal}
            selectedIndex={selectedIndex}
            visualSelections={visualMode ? visualSelections : undefined}
          />
        </>
      )}
      {activeScreen === "feed" && feedView === "sessions" && (
        <SessionContent onFocusTerminal={handleFocusTerminal} />
      )}
      {activeScreen === "telemetry" && (
        <TelemetryScreen onBack={() => setActiveScreen("feed")} />
      )}
      {activeScreen === "expander" && (
        <SnippetManager onBack={() => setActiveScreen("feed")} />
      )}
      {activeScreen === "settings" && (
        <YaptureSettings
          onBack={() => setActiveScreen("feed")}
          onHotkeyConfigChanged={refreshConfig}
          onBannerConfigChanged={refreshBannerConfig}
        />
      )}
      {showHelp && (
        <HotkeyHelp
          onClose={() => setShowHelp(false)}
          config={hotkeyConfig}
        />
      )}
      {showExpanderPalette && (
        <ExpanderPalette
          onClose={() => setShowExpanderPalette(false)}
          onExpand={handleExpand}
        />
      )}
      {showCommandPalette && (
        <CommandPalette
          onClose={() => setShowCommandPalette(false)}
          onAction={handleCommandPaletteAction}
          onExpand={handleExpand}
          expandPrefix={expandPrefix}
        />
      )}
      <NotificationBanner
        queue={bannerQueue}
        onDismiss={(id) => setBannerQueue((prev) => prev.filter((n) => n.id !== id))}
        onDismissAll={() => setBannerQueue([])}
        onFocusTerminal={handleFocusTerminal}
        onViewInFeed={() => {
          setActiveScreen("feed");
          setBannerQueue([]);
        }}
      />
      <Toast />
    </div>
    </ToastContext.Provider>
  );
}
