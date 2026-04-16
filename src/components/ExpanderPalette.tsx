import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSnippets } from "../hooks/useSnippets";
import { expandSnippet } from "../lib/snippets";
import { isEmojiSnippet, parseTags } from "../lib/snippetDisplay";
import { FormView, parseVariables, hasFormVariables } from "./FormView";
import type { SnippetVariable } from "../lib/types";

function isEmojiOrKaomoji(snippet: { tags: string | null }): boolean {
  const tags = parseTags(snippet.tags);
  return tags.includes("emoji") || tags.includes("kaomoji");
}

interface ExpanderPaletteProps {
  onClose: () => void;
  onExpand: (text: string) => void;
}

export function ExpanderPalette({ onClose, onExpand }: ExpanderPaletteProps) {
  const [search, setSearch] = useState("");
  const { snippets: rawSnippets } = useSnippets(search || undefined);

  // Colon-prefix emoji boost: filter to emoji/kaomoji only when search starts with ":"
  // Otherwise sort non-emoji first, emoji/kaomoji to the bottom
  const snippets = useMemo(() => {
    if (search.startsWith(":")) {
      return rawSnippets.filter(isEmojiOrKaomoji);
    }
    return [...rawSnippets].sort((a, b) => {
      const aIsEmoji = isEmojiOrKaomoji(a) ? 1 : 0;
      const bIsEmoji = isEmojiOrKaomoji(b) ? 1 : 0;
      return aIsEmoji - bIsEmoji;
    });
  }, [rawSnippets, search]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [formSnippetId, setFormSnippetId] = useState<string | null>(null);
  const [formVariables, setFormVariables] = useState<SnippetVariable[]>([]);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-snippet-item]");
    const item = items[selectedIndex];
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const formVarsForForm = useMemo(
    () => formVariables.filter((v) => v.type === "form" || v.type === "choice"),
    [formVariables]
  );

  const handleSelect = useCallback(
    async (index: number) => {
      const snippet = snippets[index];
      if (!snippet) return;

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
    [snippets, onExpand, onClose]
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (formSnippetId) {
        if (e.key === "Escape") {
          e.preventDefault();
          handleCancelForm();
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
        case "j":
          if (e.key === "j" && e.target instanceof HTMLInputElement) break;
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, snippets.length - 1));
          break;
        case "ArrowUp":
        case "k":
          if (e.key === "k" && e.target instanceof HTMLInputElement) break;
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          handleSelect(selectedIndex);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [formSnippetId, snippets.length, selectedIndex, handleSelect, onClose, handleCancelForm]
  );

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
        {/* Search input */}
        <div className="border-b border-border-subtle">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search snippets..."
            className="w-full bg-surface border-0 px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
        </div>

        {/* Results or Form */}
        {formSnippetId ? (
          <FormView
            variables={formVarsForForm}
            values={formValues}
            onValuesChange={setFormValues}
            onExpand={handleFormExpand}
            onCancel={handleCancelForm}
          />
        ) : (
          <div
            ref={listRef}
            className="max-h-[300px] overflow-y-auto"
          >
            {snippets.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-text-tertiary">
                  {search ? "No matching snippets." : "No snippets available."}
                </p>
              </div>
            ) : (
              <>
                {snippets.slice(0, 100).map((snippet, i) => {
                  const emojiSnippet = isEmojiSnippet(snippet);
                  const tags = parseTags(snippet.tags).filter((tag) => tag !== "emoji");

                  return (
                    <button
                      key={snippet.id}
                      data-snippet-item
                      onClick={() => handleSelect(i)}
                      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                        i === selectedIndex
                          ? "bg-surface-overlay"
                          : "hover:bg-surface-overlay/50"
                      }`}
                    >
                      {emojiSnippet ? (
                        <>
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-xl shrink-0">
                            {snippet.body}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-mono text-accent shrink-0">
                                {snippet.trigger}
                              </span>
                              {snippet.label && (
                                <span className="text-xs text-text-primary truncate">
                                  {snippet.label}
                                </span>
                              )}
                            </div>
                            {tags.length > 0 && (
                              <div className="mt-0.5 flex flex-wrap gap-1.5">
                                {tags.slice(0, 4).map((tag) => (
                                  <span
                                    key={tag}
                                    className="text-[10px] text-text-tertiary bg-surface-overlay/50 px-1.5 py-0.5 rounded"
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="text-sm font-mono text-accent shrink-0">
                            {snippet.trigger}
                          </span>
                          {snippet.label && (
                            <span className="text-xs text-text-secondary truncate">
                              {snippet.label}
                            </span>
                          )}
                        </>
                      )}
                    </button>
                  );
                })}
                {snippets.length > 100 && (
                  <div className="px-4 py-2 text-center">
                    <p className="text-[11px] text-text-tertiary">
                      {snippets.length - 100} more results — refine your search
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
