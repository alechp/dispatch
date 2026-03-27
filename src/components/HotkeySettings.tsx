import { useState, useEffect, useCallback, useRef } from "react";
import { getHotkeyConfig, setHotkeyConfig } from "../lib/api";
import type { HotkeyConfig, HotkeyBinding } from "../lib/types";

interface HotkeySettingsProps {
  onConfigChanged: () => void;
}

function KeyBadge({
  label,
  onClick,
  capturing,
}: {
  label: string;
  onClick?: () => void;
  capturing?: boolean;
}) {
  return (
    <kbd
      onClick={onClick}
      className={`inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 text-[11px] font-mono font-medium rounded border transition-colors ${
        capturing
          ? "bg-accent/20 text-accent border-accent animate-pulse cursor-default"
          : onClick
            ? "bg-surface-overlay text-text-secondary border-border-subtle hover:border-accent/50 cursor-pointer"
            : "bg-surface-overlay text-text-secondary border-border-subtle"
      }`}
    >
      {capturing ? "Press a key..." : label}
    </kbd>
  );
}

function formatKeyForDisplay(key: string): string {
  if (key.includes("CommandOrControl")) {
    return key
      .replace("CommandOrControl", "\u2318")
      .replace("+Shift+", "+\u21e7+")
      .replace(/\+/g, "");
  }
  switch (key) {
    case "ArrowDown": return "\u2193";
    case "ArrowUp": return "\u2191";
    case "ArrowLeft": return "\u2190";
    case "ArrowRight": return "\u2192";
    case "Backspace": return "\u232b";
    case "Enter": return "\u23ce";
    case "Escape": return "Esc";
    default: return key;
  }
}

export function HotkeySettings({ onConfigChanged }: HotkeySettingsProps) {
  const [config, setConfig] = useState<HotkeyConfig | null>(null);
  const [capturingIndex, setCapturingIndex] = useState<{
    bindingIdx: number;
    keyIdx: number;
  } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await getHotkeyConfig();
      setConfig(cfg);
    } catch (e) {
      console.error("[hotkey-settings] loadConfig failed:", e);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Key capture handler
  useEffect(() => {
    if (!capturingIndex || !config) return;

    function handler(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setCapturingIndex(null);
        return;
      }

      // Build key string
      const binding = config!.bindings[capturingIndex!.bindingIdx];
      let newKey: string;

      if (binding.scope === "global") {
        // Global shortcuts need modifier keys
        const parts: string[] = [];
        if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
        if (e.shiftKey) parts.push("Shift");
        if (e.altKey) parts.push("Alt");
        // Don't capture modifier-only presses
        if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
        newKey = parts.join("+");
      } else {
        newKey = e.key;
      }

      // Check for conflicts
      for (let i = 0; i < config!.bindings.length; i++) {
        if (i === capturingIndex!.bindingIdx) continue;
        const other = config!.bindings[i];
        if (!other.enabled) continue;
        if (other.keys.includes(newKey)) {
          setConflict(
            `"${newKey}" is already used by "${other.description}"`
          );
          setTimeout(() => setConflict(null), 3000);
          setCapturingIndex(null);
          return;
        }
      }

      // Apply the new key
      const newConfig = structuredClone(config!);
      newConfig.bindings[capturingIndex!.bindingIdx].keys[
        capturingIndex!.keyIdx
      ] = newKey;
      saveConfig(newConfig);
      setCapturingIndex(null);
    }

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [capturingIndex, config]);

  async function saveConfig(newConfig: HotkeyConfig) {
    try {
      await setHotkeyConfig(newConfig);
      setConfig(newConfig);
      onConfigChanged();
    } catch (e) {
      console.error("[hotkey-settings] save failed:", e);
    }
  }

  async function handleToggle(idx: number) {
    if (!config) return;
    const newConfig = structuredClone(config);
    newConfig.bindings[idx].enabled = !newConfig.bindings[idx].enabled;
    await saveConfig(newConfig);
  }

  async function handleResetDefaults() {
    try {
      const defaultConfig: HotkeyConfig = {
        bindings: [
          { action: "toggle_window", keys: ["CommandOrControl+Shift+D"], enabled: true, scope: "global", category: "Global", description: "Toggle window" },
          { action: "select_next", keys: ["j", "ArrowDown"], enabled: true, scope: "app", category: "Navigation", description: "Next notification" },
          { action: "select_prev", keys: ["k", "ArrowUp"], enabled: true, scope: "app", category: "Navigation", description: "Previous notification" },
          { action: "focus_search", keys: ["f"], enabled: true, scope: "app", category: "Navigation", description: "Focus search" },
          { action: "clear_selection", keys: ["Escape"], enabled: true, scope: "app", category: "Navigation", description: "Clear selection" },
          { action: "mark_selected_read", keys: ["Enter", "r"], enabled: true, scope: "app", category: "Actions", description: "Mark read" },
          { action: "delete_selected", keys: ["d", "Backspace"], enabled: true, scope: "app", category: "Actions", description: "Delete" },
          { action: "focus_terminal", keys: ["t"], enabled: true, scope: "app", category: "Actions", description: "Focus terminal" },
          { action: "mark_all_read", keys: ["R"], enabled: true, scope: "app", category: "Actions", description: "Mark all read" },
          { action: "clear_all", keys: ["D"], enabled: true, scope: "app", category: "Actions", description: "Clear all" },
          { action: "filter_all", keys: ["1"], enabled: true, scope: "app", category: "Filters", description: "All" },
          { action: "filter_unread", keys: ["2"], enabled: true, scope: "app", category: "Filters", description: "Unread" },
          { action: "filter_read", keys: ["3"], enabled: true, scope: "app", category: "Filters", description: "Read" },
          { action: "toggle_help", keys: ["?"], enabled: true, scope: "app", category: "Help", description: "Toggle help" },
        ],
      };
      await saveConfig(defaultConfig);
    } catch (e) {
      console.error("[hotkey-settings] reset failed:", e);
    }
  }

  function addKey(bindingIdx: number) {
    if (!config) return;
    const newConfig = structuredClone(config);
    newConfig.bindings[bindingIdx].keys.push("");
    setConfig(newConfig);
    setCapturingIndex({ bindingIdx, keyIdx: newConfig.bindings[bindingIdx].keys.length - 1 });
  }

  function removeKey(bindingIdx: number, keyIdx: number) {
    if (!config) return;
    const binding = config.bindings[bindingIdx];
    if (binding.keys.length <= 1) return; // Must have at least one key
    const newConfig = structuredClone(config);
    newConfig.bindings[bindingIdx].keys.splice(keyIdx, 1);
    saveConfig(newConfig);
  }

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-text-tertiary">Loading...</p>
      </div>
    );
  }

  // Group bindings by category
  const categories = new Map<string, { idx: number; binding: HotkeyBinding }[]>();
  config.bindings.forEach((binding, idx) => {
    const list = categories.get(binding.category) || [];
    list.push({ idx, binding });
    categories.set(binding.category, list);
  });

  return (
    <div ref={captureRef} className="space-y-4">
      {conflict && (
        <div className="px-3 py-2 text-xs text-warning bg-warning/10 border border-warning/20 rounded-md">
          {conflict}
        </div>
      )}

      {Array.from(categories.entries()).map(([category, items]) => (
        <div key={category}>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
            {category}
          </h3>
          <div className="bg-surface-raised border border-border-subtle rounded-lg divide-y divide-border-subtle">
            {items.map(({ idx, binding }) => (
              <div
                key={binding.action}
                className="flex items-center justify-between px-3 py-2"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  {/* Toggle */}
                  <button
                    onClick={() => handleToggle(idx)}
                    className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
                      binding.enabled
                        ? "bg-accent"
                        : "bg-surface-overlay border border-border-subtle"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                        binding.enabled ? "translate-x-4" : ""
                      }`}
                    />
                  </button>
                  <span
                    className={`text-xs truncate ${
                      binding.enabled
                        ? "text-text-primary"
                        : "text-text-tertiary"
                    }`}
                  >
                    {binding.description}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {binding.keys.map((key, keyIdx) => (
                    <span key={keyIdx} className="flex items-center gap-0.5">
                      {keyIdx > 0 && (
                        <span className="text-[10px] text-text-tertiary">/</span>
                      )}
                      <KeyBadge
                        label={formatKeyForDisplay(key)}
                        onClick={() =>
                          setCapturingIndex({ bindingIdx: idx, keyIdx })
                        }
                        capturing={
                          capturingIndex?.bindingIdx === idx &&
                          capturingIndex?.keyIdx === keyIdx
                        }
                      />
                      {binding.keys.length > 1 && (
                        <button
                          onClick={() => removeKey(idx, keyIdx)}
                          className="text-text-tertiary hover:text-error transition-colors ml-0.5"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </span>
                  ))}
                  <button
                    onClick={() => addKey(idx)}
                    className="ml-1 text-text-tertiary hover:text-accent transition-colors"
                    title="Add alternative key"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Reset to defaults */}
      <div className="pt-2">
        <button
          onClick={handleResetDefaults}
          className="px-4 py-1.5 text-xs text-text-tertiary hover:text-error bg-surface-overlay border border-border-subtle rounded-md hover:border-error/30 transition-colors"
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
