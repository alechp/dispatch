import { useEffect } from "react";

interface HotkeyHelpProps {
  onClose: () => void;
}

interface Keybinding {
  keys: string[];
  description: string;
}

interface KeybindingGroup {
  title: string;
  bindings: Keybinding[];
}

const groups: KeybindingGroup[] = [
  {
    title: "Navigation",
    bindings: [
      { keys: ["j", "\u2193"], description: "Next notification" },
      { keys: ["k", "\u2191"], description: "Previous notification" },
      { keys: ["f"], description: "Focus search" },
      { keys: ["Esc"], description: "Clear selection" },
    ],
  },
  {
    title: "Actions",
    bindings: [
      { keys: ["Enter", "r"], description: "Mark read" },
      { keys: ["d", "\u232b"], description: "Delete" },
      { keys: ["t"], description: "Focus terminal" },
      { keys: ["R"], description: "Mark all read" },
      { keys: ["D"], description: "Clear all" },
    ],
  },
  {
    title: "Filters",
    bindings: [
      { keys: ["1"], description: "All" },
      { keys: ["2"], description: "Unread" },
      { keys: ["3"], description: "Read" },
    ],
  },
  {
    title: "Help",
    bindings: [{ keys: ["?"], description: "Toggle help" }],
  },
];

function KeyBadge({ label }: { label: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 text-[11px] font-mono font-medium rounded bg-surface-overlay text-text-secondary border border-border-subtle">
      {label}
    </kbd>
  );
}

export function HotkeyHelp({ onClose }: HotkeyHelpProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[380px] max-h-[80vh] overflow-y-auto bg-surface-raised border border-border-subtle rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-text-tertiary hover:text-text-secondary rounded transition-colors"
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-3 space-y-4">
          {groups.map((group) => (
            <div key={group.title}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
                {group.title}
              </h3>
              <div className="space-y-1.5">
                {group.bindings.map((binding) => (
                  <div
                    key={binding.description}
                    className="flex items-center justify-between"
                  >
                    <span className="text-xs text-text-secondary">
                      {binding.description}
                    </span>
                    <div className="flex items-center gap-1">
                      {binding.keys.map((key, i) => (
                        <span key={key} className="flex items-center gap-1">
                          {i > 0 && (
                            <span className="text-[10px] text-text-tertiary">
                              /
                            </span>
                          )}
                          <KeyBadge label={key} />
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-border-subtle">
          <p className="text-[11px] text-text-tertiary text-center">
            Press <KeyBadge label="?" /> to toggle &middot;{" "}
            <KeyBadge label="Esc" /> to close
          </p>
        </div>
      </div>
    </div>
  );
}
