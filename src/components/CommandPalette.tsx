import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { expandSnippet } from "../lib/snippets";
import type { Snippet, SnippetVariable } from "../lib/types";

interface CommandPaletteProps {
  onClose: () => void;
  onAction: (action: string) => void;
  onExpand: (text: string) => void;
  expandPrefix?: string;
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
  { label: "Create New Expansion Config", action: "new_config", category: "Actions" },
  { label: "Toggle Keyboard Shortcuts", action: "toggle_help", category: "Help" },
];

type PaletteMode = "commands" | "expansions";

function parseVariables(json: string | null): SnippetVariable[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as SnippetVariable[];
  } catch {
    return [];
  }
}

function hasFormVariables(variables: SnippetVariable[]): boolean {
  return variables.some((v) => v.type === "form" || v.type === "choice");
}

export function CommandPalette({
  onClose,
  onAction,
  onExpand,
  expandPrefix = ":",
}: CommandPaletteProps) {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<PaletteMode>("commands");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [recentSnippets, setRecentSnippets] = useState<Snippet[]>([]);
  const [favoriteSnippets, setFavoriteSnippets] = useState<Snippet[]>([]);
  const [formSnippetId, setFormSnippetId] = useState<string | null>(null);
  const [formVariables, setFormVariables] = useState<SnippetVariable[]>([]);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [activeSection, setActiveSection] = useState<"favorites" | "recent" | "all">("favorites");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The actual search query in expansion mode (without the prefix)
  const expansionQuery = mode === "expansions" ? search : "";

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fetch snippets when in expansion mode
  useEffect(() => {
    if (mode !== "expansions") return;
    invoke<Snippet[]>("list_snippets", {
      search: expansionQuery || null,
      tag: null,
    })
      .then(setSnippets)
      .catch((err) => console.error("Failed to fetch snippets:", err));
  }, [mode, expansionQuery]);

  // Fetch recents and favorites on expansion mode entry
  useEffect(() => {
    if (mode !== "expansions") return;
    invoke<Snippet[]>("list_recent_snippets", { limit: 5 })
      .then(setRecentSnippets)
      .catch(() => setRecentSnippets([]));
    invoke<Snippet[]>("list_favorite_snippets")
      .then(setFavoriteSnippets)
      .catch(() => setFavoriteSnippets([]));
  }, [mode]);

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [search, mode]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-palette-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const formVarsForForm = useMemo(
    () => formVariables.filter((v) => v.type === "form" || v.type === "choice"),
    [formVariables]
  );

  // Command mode filtering
  const filteredCommands = search
    ? COMMANDS.filter((c) =>
        c.label.toLowerCase().includes(search.toLowerCase())
      )
    : COMMANDS;

  // Build sectioned list for expansion mode (empty query)
  const expansionItems = useMemo(() => {
    if (mode !== "expansions") return [];
    if (expansionQuery) return snippets;

    // Deduplicate: favorites first, then recents (excluding favorites), then all (excluding both)
    const favIds = new Set(favoriteSnippets.map((s) => s.id));
    const recentIds = new Set(recentSnippets.map((s) => s.id));
    const sections: { header: string; items: Snippet[] }[] = [];

    if (favoriteSnippets.length > 0) {
      sections.push({ header: "Favorites", items: favoriteSnippets });
    }
    const filteredRecents = recentSnippets.filter((s) => !favIds.has(s.id));
    if (filteredRecents.length > 0) {
      sections.push({ header: "Recent", items: filteredRecents });
    }
    const rest = snippets.filter((s) => !favIds.has(s.id) && !recentIds.has(s.id));
    if (rest.length > 0) {
      sections.push({ header: "All Snippets", items: rest });
    }

    return sections;
  }, [mode, expansionQuery, snippets, recentSnippets, favoriteSnippets]);

  // Flat list for keyboard navigation in expansion mode (empty query with sections)
  const flatExpansionItems = useMemo(() => {
    if (expansionQuery) return snippets;
    if (!Array.isArray(expansionItems)) return [];
    return (expansionItems as { header: string; items: Snippet[] }[]).flatMap(
      (s) => s.items
    );
  }, [expansionQuery, expansionItems, snippets]);

  const totalItems =
    mode === "commands" ? filteredCommands.length : flatExpansionItems.length;

  const handleSnippetSelect = useCallback(
    async (snippet: Snippet) => {
      const vars = parseVariables(snippet.variables);
      if (hasFormVariables(vars)) {
        setFormSnippetId(snippet.id);
        setFormVariables(vars);
        const defaults: Record<string, string> = {};
        for (const v of vars) {
          if (v.type === "form") {
            defaults[v.name] = (v.params.default as string) ?? "";
          } else if (v.type === "choice") {
            const values = (v.params.values as string[]) ?? [];
            defaults[v.name] = values[0] ?? "";
          }
        }
        setFormValues(defaults);
      } else {
        try {
          const expanded = await expandSnippet(snippet.id);
          onExpand(expanded);
          onClose();
        } catch (err) {
          console.error("Expand failed:", err);
        }
      }
    },
    [onExpand, onClose]
  );

  const handleFormExpand = useCallback(async () => {
    if (!formSnippetId) return;
    try {
      const expanded = await expandSnippet(formSnippetId, formValues);
      onExpand(expanded);
      onClose();
    } catch (err) {
      console.error("Expand failed:", err);
    }
  }, [formSnippetId, formValues, onExpand, onClose]);

  const handleCancelForm = useCallback(() => {
    setFormSnippetId(null);
    setFormVariables([]);
    setFormValues({});
    inputRef.current?.focus();
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;

      if (mode === "commands" && val.startsWith(expandPrefix)) {
        // Switch to expansion mode
        setMode("expansions");
        setSearch(val.slice(expandPrefix.length));
        setSelectedIndex(0);
        return;
      }

      setSearch(val);
    },
    [mode, expandPrefix]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (formSnippetId) {
        if (e.key === "Escape") {
          e.preventDefault();
          handleCancelForm();
        }
        return;
      }

      // Backspace past prefix returns to command mode
      if (
        mode === "expansions" &&
        e.key === "Backspace" &&
        search === ""
      ) {
        e.preventDefault();
        setMode("commands");
        setSearch("");
        setSelectedIndex(0);
        return;
      }

      // Tab cycles sections in expansion mode (empty query)
      if (mode === "expansions" && e.key === "Tab" && !expansionQuery) {
        e.preventDefault();
        setActiveSection((prev) =>
          prev === "favorites"
            ? "recent"
            : prev === "recent"
            ? "all"
            : "favorites"
        );
        return;
      }

      switch (e.key) {
        case "ArrowDown":
        case "j":
          if (e.key === "j" && e.target instanceof HTMLInputElement) break;
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, totalItems - 1));
          break;
        case "ArrowUp":
        case "k":
          if (e.key === "k" && e.target instanceof HTMLInputElement) break;
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (mode === "commands") {
            if (filteredCommands[selectedIndex]) {
              onAction(filteredCommands[selectedIndex].action);
            }
          } else {
            const snippet = flatExpansionItems[selectedIndex];
            if (snippet) handleSnippetSelect(snippet);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (mode === "expansions") {
            setMode("commands");
            setSearch("");
          } else {
            onClose();
          }
          break;
      }
    },
    [
      formSnippetId,
      mode,
      search,
      expansionQuery,
      totalItems,
      selectedIndex,
      filteredCommands,
      flatExpansionItems,
      onAction,
      onClose,
      handleSnippetSelect,
      handleCancelForm,
      activeSection,
    ]
  );

  // Display value in input includes the prefix when in expansion mode
  const displayValue = mode === "expansions" ? expandPrefix + search : search;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-[440px] bg-surface-raised border border-border-subtle rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="border-b border-border-subtle flex items-center">
          {mode === "expansions" && (
            <span className="pl-4 text-xs font-mono text-accent select-none">
              {expandPrefix}
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={mode === "expansions" ? search : displayValue}
            onChange={handleInputChange}
            placeholder={
              mode === "expansions"
                ? "Search snippets..."
                : `Type a command or "${expandPrefix}" for snippets...`
            }
            className={`w-full bg-surface border-0 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none ${
              mode === "expansions" ? "pl-1 pr-4" : "px-4"
            }`}
          />
        </div>

        {/* Mode indicator */}
        {mode === "expansions" && (
          <div className="px-4 py-1.5 bg-accent/5 border-b border-border-subtle flex items-center justify-between">
            <span className="text-[10px] font-medium text-accent uppercase tracking-wider">
              Expansions
            </span>
            <span className="text-[10px] text-text-tertiary">
              ESC to go back · Tab to switch sections
            </span>
          </div>
        )}

        {/* Content */}
        {formSnippetId ? (
          <FormView
            variables={formVarsForForm}
            values={formValues}
            onValuesChange={setFormValues}
            onExpand={handleFormExpand}
            onCancel={handleCancelForm}
          />
        ) : mode === "commands" ? (
          <div ref={listRef} className="max-h-[300px] overflow-y-auto">
            {filteredCommands.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-text-tertiary">
                  No matching commands.
                </p>
              </div>
            ) : (
              filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.action}
                  data-palette-item
                  onClick={() => onAction(cmd.action)}
                  className={`w-full text-left px-4 py-2.5 flex items-center justify-between transition-colors ${
                    i === selectedIndex
                      ? "bg-surface-overlay"
                      : "hover:bg-surface-overlay/50"
                  }`}
                >
                  <span className="text-xs text-text-primary">{cmd.label}</span>
                  <span className="text-[10px] text-text-tertiary">
                    {cmd.category}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div ref={listRef} className="max-h-[300px] overflow-y-auto">
            {expansionQuery ? (
              // Flat search results
              snippets.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs text-text-tertiary">
                    No matching snippets.
                  </p>
                </div>
              ) : (
                snippets.map((snippet, i) => (
                  <SnippetRow
                    key={snippet.id}
                    snippet={snippet}
                    selected={i === selectedIndex}
                    onClick={() => handleSnippetSelect(snippet)}
                  />
                ))
              )
            ) : (
              // Sectioned: favorites, recent, all
              (expansionItems as { header: string; items: Snippet[] }[]).length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs text-text-tertiary">
                    No snippets available.
                  </p>
                </div>
              ) : (
                (() => {
                  let flatIdx = 0;
                  return (expansionItems as { header: string; items: Snippet[] }[]).map(
                    (section) => {
                      const startIdx = flatIdx;
                      const sectionEl = (
                        <div key={section.header}>
                          <div className="px-4 py-1.5 bg-surface/50 border-b border-border-subtle sticky top-0">
                            <span className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
                              {section.header}{" "}
                              <span className="text-text-tertiary/50">
                                ({section.items.length})
                              </span>
                            </span>
                          </div>
                          {section.items.map((snippet) => {
                            const idx = flatIdx++;
                            return (
                              <SnippetRow
                                key={snippet.id}
                                snippet={snippet}
                                selected={idx === selectedIndex}
                                onClick={() => handleSnippetSelect(snippet)}
                                showFavorite
                              />
                            );
                          })}
                        </div>
                      );
                      void startIdx; // used only for closure
                      return sectionEl;
                    }
                  );
                })()
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SnippetRow
// ---------------------------------------------------------------------------

function SnippetRow({
  snippet,
  selected,
  onClick,
  showFavorite,
}: {
  snippet: Snippet;
  selected: boolean;
  onClick: () => void;
  showFavorite?: boolean;
}) {
  return (
    <button
      data-palette-item
      onClick={onClick}
      className={`w-full text-left px-4 py-2.5 flex items-center gap-2 transition-colors ${
        selected ? "bg-surface-overlay" : "hover:bg-surface-overlay/50"
      }`}
    >
      {showFavorite && (snippet as any).is_favorite === 1 && (
        <span className="text-[10px] text-warning shrink-0">★</span>
      )}
      <span className="text-sm font-mono text-accent shrink-0">
        {snippet.trigger}
      </span>
      {snippet.label && (
        <span className="text-xs text-text-secondary truncate flex-1">
          {snippet.label}
        </span>
      )}
      {(snippet as any).source_name && (
        <span className="text-[10px] text-text-tertiary bg-surface-overlay/50 px-1.5 py-0.5 rounded shrink-0">
          {(snippet as any).source_name}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// FormView (inline variable form for form/choice variables)
// ---------------------------------------------------------------------------

function FormView({
  variables,
  values,
  onValuesChange,
  onExpand,
  onCancel,
}: {
  variables: SnippetVariable[];
  values: Record<string, string>;
  onValuesChange: (values: Record<string, string>) => void;
  onExpand: () => void;
  onCancel: () => void;
}) {
  const firstInputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const updateValue = (name: string, value: string) => {
    onValuesChange({ ...values, [name]: value });
  };

  return (
    <div className="px-4 py-3 space-y-3">
      {variables.map((v, i) => {
        if (v.type === "form") {
          return (
            <div key={v.name}>
              <label className="block text-[11px] text-text-tertiary mb-1">
                {(v.params.label as string) || v.name}
              </label>
              <input
                ref={
                  i === 0
                    ? (firstInputRef as React.RefObject<HTMLInputElement>)
                    : undefined
                }
                type="text"
                value={values[v.name] ?? ""}
                onChange={(e) => updateValue(v.name, e.target.value)}
                placeholder={(v.params.default as string) || ""}
                className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
              />
            </div>
          );
        }
        if (v.type === "choice") {
          const choiceValues = ((v.params.values as string[]) ?? []) as string[];
          return (
            <div key={v.name}>
              <label className="block text-[11px] text-text-tertiary mb-1">
                {(v.params.label as string) || v.name}
              </label>
              <select
                ref={
                  i === 0
                    ? (firstInputRef as React.RefObject<HTMLSelectElement>)
                    : undefined
                }
                value={values[v.name] ?? ""}
                onChange={(e) => updateValue(v.name, e.target.value)}
                className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50 transition-colors"
              >
                {choiceValues.map((cv) => (
                  <option key={cv} value={cv}>
                    {cv}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        return null;
      })}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5 rounded-md border border-border-subtle"
        >
          Cancel
        </button>
        <button
          onClick={onExpand}
          className="text-xs text-white bg-accent hover:bg-accent-hover transition-colors px-3 py-1.5 rounded-md"
        >
          Expand
        </button>
      </div>
    </div>
  );
}
