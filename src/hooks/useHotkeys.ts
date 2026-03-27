import { useEffect, useState, useCallback, useRef } from "react";
import { getHotkeyConfig } from "../lib/api";
import type { HotkeyConfig } from "../lib/types";

interface HotkeyActions {
  selectNext: () => void;
  selectPrev: () => void;
  markSelectedRead: () => void;
  deleteSelected: () => void;
  focusTerminal: () => void;
  markAllRead: () => void;
  clearAll: () => void;
  focusSearch: () => void;
  clearSelection: () => void;
  setFilter: (filter: "all" | "unread" | "read") => void;
  toggleHelp: () => void;
  toggleVisualMode: () => void;
  visualToggleItem: () => void;
}

const ACTION_MAP: Record<string, (actions: HotkeyActions, e: KeyboardEvent) => void> = {
  select_next: (a, e) => { e.preventDefault(); a.selectNext(); },
  select_prev: (a, e) => { e.preventDefault(); a.selectPrev(); },
  mark_selected_read: (a) => a.markSelectedRead(),
  delete_selected: (a) => a.deleteSelected(),
  focus_terminal: (a) => a.focusTerminal(),
  mark_all_read: (a) => a.markAllRead(),
  clear_all: (a) => a.clearAll(),
  focus_search: (a, e) => { e.preventDefault(); a.focusSearch(); },
  clear_selection: (a) => a.clearSelection(),
  filter_all: (a) => a.setFilter("all"),
  filter_unread: (a) => a.setFilter("unread"),
  filter_read: (a) => a.setFilter("read"),
  toggle_help: (a) => a.toggleHelp(),
  toggle_visual_mode: (a) => a.toggleVisualMode(),
  visual_toggle_item: (a, e) => { e.preventDefault(); a.visualToggleItem(); },
};

export function useHotkeys(actions: HotkeyActions): {
  config: HotkeyConfig | null;
  refreshConfig: () => Promise<void>;
} {
  const [config, setConfig] = useState<HotkeyConfig | null>(null);
  const keyMapRef = useRef<Map<string, string>>(new Map());

  const refreshConfig = useCallback(async () => {
    try {
      const cfg = await getHotkeyConfig();
      setConfig(cfg);

      // Build key → action map from enabled app-scope bindings
      const map = new Map<string, string>();
      for (const binding of cfg.bindings) {
        if (binding.scope === "app" && binding.enabled) {
          for (const key of binding.keys) {
            map.set(key, binding.action);
          }
        }
      }
      keyMapRef.current = map;
    } catch (e) {
      console.error("[useHotkeys] failed to load config:", e);
    }
  }, []);

  useEffect(() => {
    refreshConfig();
  }, [refreshConfig]);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Skip if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
          actions.clearSelection();
        }
        return;
      }

      const action = keyMapRef.current.get(e.key);
      if (action) {
        const handler = ACTION_MAP[action];
        if (handler) {
          handler(actions, e);
        }
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [actions]);

  return { config, refreshConfig };
}
