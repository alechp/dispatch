import { useState, useEffect, useRef } from "react";

interface CommandPaletteProps {
  onClose: () => void;
  onAction: (action: string) => void;
}

interface Command {
  label: string;
  action: string;
  category: string;
}

const COMMANDS: Command[] = [
  { label: "Go to Feed", action: "go_feed", category: "Navigation" },
  { label: "Go to Sessions", action: "go_sessions", category: "Navigation" },
  { label: "Go to Analytics", action: "go_telemetry", category: "Navigation" },
  { label: "Go to Text Expander", action: "go_expander", category: "Navigation" },
  { label: "Go to Settings", action: "go_settings", category: "Navigation" },
  { label: "Mark All Read", action: "mark_all_read", category: "Actions" },
  { label: "Clear All Notifications", action: "clear_all", category: "Actions" },
  { label: "Toggle Keyboard Shortcuts", action: "toggle_help", category: "Help" },
];

export function CommandPalette({ onClose, onAction }: CommandPaletteProps) {
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = search
    ? COMMANDS.filter((c) => c.label.toLowerCase().includes(search.toLowerCase()))
    : COMMANDS;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-command-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
      case "j":
        if (e.key === "j" && e.target instanceof HTMLInputElement) break;
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        break;
      case "ArrowUp":
      case "k":
        if (e.key === "k" && e.target instanceof HTMLInputElement) break;
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onAction(filtered[selectedIndex].action);
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-[400px] bg-surface-raised border border-border-subtle rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border-subtle">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type a command..."
            className="w-full bg-surface border-0 px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
        </div>
        <div ref={listRef} className="max-h-[300px] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-xs text-text-tertiary">No matching commands.</p>
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.action}
                data-command-item
                onClick={() => onAction(cmd.action)}
                className={`w-full text-left px-4 py-2.5 flex items-center justify-between transition-colors ${
                  i === selectedIndex
                    ? "bg-surface-overlay"
                    : "hover:bg-surface-overlay/50"
                }`}
              >
                <span className="text-xs text-text-primary">{cmd.label}</span>
                <span className="text-[10px] text-text-tertiary">{cmd.category}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
