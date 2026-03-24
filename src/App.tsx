import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Header } from "./components/Header";
import { FilterBar } from "./components/FilterBar";
import { NotificationFeed } from "./components/NotificationFeed";
import { HotkeyHelp } from "./components/HotkeyHelp";
import { useNotifications } from "./hooks/useNotifications";
import { useNotificationListener } from "./hooks/useNotificationListener";
import { useSound } from "./hooks/useSound";
import { useHotkeys } from "./hooks/useHotkeys";
import { deleteNotification, focusTerminal } from "./lib/api";
import { trackEvent } from "./lib/telemetry";
import { TelemetryScreen } from "./components/TelemetryScreen";
import type { Notification, QueryFilters } from "./lib/types";

export type ActiveScreen = "feed" | "telemetry" | "sessions" | "expander";

export default function App() {
  const [filter, setFilter] = useState<"all" | "unread" | "read">("all");
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>("feed");
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

  const handleNewNotification = useCallback(
    (_notification: Notification) => {
      play();
      refresh();
    },
    [play, refresh]
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
      await focusTerminal(session, window ?? undefined, pane ?? undefined);
    },
    [markRead]
  );

  const handleMarkRead = useCallback(
    (id: string) => {
      markRead(id);
      trackEvent("notification_read", { targetId: id, metadata: { method: "click" } });
    },
    [markRead]
  );

  useNotificationListener(handleNewNotification, refresh);

  // Reset selection when filter or search changes
  useEffect(() => {
    setSelectedIndex(null);
  }, [filter, search]);

  const hotkeyActions = useMemo(
    () => ({
      selectNext: () => {
        setSelectedIndex((prev) => {
          if (prev === null) return 0;
          return Math.min(prev + 1, notifications.length - 1);
        });
      },
      selectPrev: () => {
        setSelectedIndex((prev) => {
          if (prev === null) return 0;
          return Math.max(prev - 1, 0);
        });
      },
      markSelectedRead: () => {
        if (selectedIndex !== null && notifications[selectedIndex]) {
          const n = notifications[selectedIndex];
          markRead(n.id);
          trackEvent("notification_read", { targetId: n.id, metadata: { method: "hotkey" } });
        }
      },
      deleteSelected: () => {
        if (selectedIndex !== null && notifications[selectedIndex]) {
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
        if (selectedIndex !== null) {
          const n = notifications[selectedIndex];
          if (n?.tmux_session) {
            handleFocusTerminal(n.id, n.tmux_session, n.tmux_window, n.tmux_pane);
          }
        }
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
      clearSelection: () => setSelectedIndex(null),
      setFilter: (f: "all" | "unread" | "read") => {
        setFilter(f);
        trackEvent("filter_changed", { metadata: { filter: f } });
      },
      toggleHelp: () => setShowHelp((prev) => !prev),
    }),
    [selectedIndex, notifications, markRead, handleDelete, handleFocusTerminal, markAllRead, clearAll]
  );

  useHotkeys(hotkeyActions);

  return (
    <div className="flex flex-col h-screen">
      <Header
        unreadCount={filter === "all" ? unreadCount : total}
        onMarkAllRead={markAllRead}
        onClearAll={clearAll}
        activeScreen={activeScreen}
        onScreenChange={setActiveScreen}
        onToggleHelp={() => setShowHelp((prev) => !prev)}
      />
      {activeScreen === "feed" && (
        <>
          <FilterBar
            onSearchChange={setSearch}
            onFilterChange={setFilter}
            activeFilter={filter}
            searchRef={searchRef}
          />
          <NotificationFeed
            notifications={notifications}
            loading={loading}
            onMarkRead={handleMarkRead}
            onDelete={handleDelete}
            onFocusTerminal={handleFocusTerminal}
            selectedIndex={selectedIndex}
          />
        </>
      )}
      {activeScreen === "telemetry" && (
        <TelemetryScreen onBack={() => setActiveScreen("feed")} />
      )}
      {/* activeScreen === "sessions" — SessionsScreen not yet implemented */}
      {/* activeScreen === "expander" — ExpanderScreen not yet implemented */}
      {showHelp && <HotkeyHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}
