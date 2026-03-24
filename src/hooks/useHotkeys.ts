import { useEffect } from "react";

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
}

export function useHotkeys(actions: HotkeyActions): void {
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

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          actions.selectNext();
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          actions.selectPrev();
          break;
        case "Enter":
        case "r":
          actions.markSelectedRead();
          break;
        case "d":
        case "Backspace":
          actions.deleteSelected();
          break;
        case "t":
          actions.focusTerminal();
          break;
        case "R":
          actions.markAllRead();
          break;
        case "D":
          actions.clearAll();
          break;
        case "f":
          e.preventDefault();
          actions.focusSearch();
          break;
        case "Escape":
          actions.clearSelection();
          break;
        case "1":
          actions.setFilter("all");
          break;
        case "2":
          actions.setFilter("unread");
          break;
        case "3":
          actions.setFilter("read");
          break;
        case "?":
          actions.toggleHelp();
          break;
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [actions]);
}
