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
import type { Notification, QueryFilters } from "./lib/types";

export default function App() {
  const [filter, setFilter] = useState<"all" | "unread" | "read">("all");
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);
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
      refresh();
    },
    [refresh]
  );

  const handleFocusTerminal = useCallback(
    async (id: string, session: string, window: string | null, pane: string | null) => {
      markRead(id);
      await focusTerminal(session, window ?? undefined, pane ?? undefined);
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
          markRead(notifications[selectedIndex].id);
        }
      },
      deleteSelected: () => {
        if (selectedIndex !== null && notifications[selectedIndex]) {
          handleDelete(notifications[selectedIndex].id);
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
      markAllRead: () => markAllRead(),
      clearAll: () => clearAll(),
      focusSearch: () => searchRef.current?.focus(),
      clearSelection: () => setSelectedIndex(null),
      setFilter: (f: "all" | "unread" | "read") => setFilter(f),
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
      />
      <FilterBar
        onSearchChange={setSearch}
        onFilterChange={setFilter}
        activeFilter={filter}
        searchRef={searchRef}
      />
      <NotificationFeed
        notifications={notifications}
        loading={loading}
        onMarkRead={markRead}
        onDelete={handleDelete}
        onFocusTerminal={handleFocusTerminal}
        selectedIndex={selectedIndex}
      />
      {showHelp && <HotkeyHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}
