import { useState, useCallback } from "react";
import { Header } from "./components/Header";
import { FilterBar } from "./components/FilterBar";
import { NotificationFeed } from "./components/NotificationFeed";
import { useNotifications } from "./hooks/useNotifications";
import { useNotificationListener } from "./hooks/useNotificationListener";
import { useSound } from "./hooks/useSound";
import { deleteNotification, focusTerminal } from "./lib/api";
import type { Notification, QueryFilters } from "./lib/types";

export default function App() {
  const [filter, setFilter] = useState<"all" | "unread" | "read">("all");
  const [search, setSearch] = useState("");

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
    async (session: string, window: string | null, pane: string | null) => {
      await focusTerminal(session, window ?? undefined, pane ?? undefined);
    },
    []
  );

  useNotificationListener(handleNewNotification, refresh);

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
      />
      <NotificationFeed
        notifications={notifications}
        loading={loading}
        onMarkRead={markRead}
        onDelete={handleDelete}
        onFocusTerminal={handleFocusTerminal}
      />
    </div>
  );
}
