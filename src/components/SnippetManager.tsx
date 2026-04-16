import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useSnippets } from "../hooks/useSnippets";
import { useToast } from "../hooks/useToast";
import {
  createSnippet,
  updateSnippet,
  deleteSnippet,
  toggleSnippetFavorite,
  expandSnippet,
  getEmojiPackStatus,
  installEmojiPack,
  uninstallEmojiPack,
  updateEmojiPack,
  getKaomojiPackStatus,
  installKaomojiPack,
  uninstallKaomojiPack,
  updateKaomojiPack,
  updateSnippetSource,
  refreshTriggers,
  listFavoriteSnippets,
  listRecentSnippets,
  listSnippets,
} from "../lib/snippets";
import {
  getLiveExpansionEnabled,
  setLiveExpansionEnabled,
  requestAccessibilityPermission,
  getExpansionDiagnostics,
  openPrivacySettings,
  testTextInjection,
  copyToClipboard,
} from "../lib/liveExpansion";
import { FormView, parseVariables, hasFormVariables } from "./FormView";
import { isEmojiSnippet } from "../lib/snippetDisplay";
import type { ExpansionDiagnostics } from "../lib/liveExpansion";
import type { EmojiPackStatus, Snippet, SnippetVariable } from "../lib/types";

interface SnippetManagerProps {
  onBack: () => void;
}

type ViewMode = "list" | "edit";

const VARIABLE_TYPES: SnippetVariable["type"][] = [
  "echo",
  "date",
  "clipboard",
  "shell",
  "form",
  "choice",
  "random",
];

// ---------------------------------------------------------------------------
// Pack category constants
// ---------------------------------------------------------------------------

interface PackCategory {
  tag: string;
  label: string;
  icon: string;
}

const EMOJI_CATEGORIES: PackCategory[] = [
  { tag: "smileys_emotion",  label: "Smileys & Emotion", icon: "\u{1F600}" },
  { tag: "people_body",      label: "People & Body",     icon: "\u{1F44B}" },
  { tag: "animals_nature",   label: "Animals & Nature",  icon: "\u{1F436}" },
  { tag: "food_drink",       label: "Food & Drink",      icon: "\u{1F354}" },
  { tag: "travel_places",    label: "Travel & Places",   icon: "\u2708\uFE0F" },
  { tag: "activities",       label: "Activities",        icon: "\u26BD" },
  { tag: "objects",          label: "Objects",           icon: "\u{1F4A1}" },
  { tag: "symbols",          label: "Symbols",           icon: "\u{1F523}" },
  { tag: "flags",            label: "Flags",             icon: "\u{1F3F3}\uFE0F" },
];

const KAOMOJI_CATEGORIES: PackCategory[] = [
  { tag: "happy",       label: "Happy",       icon: "\u2267\u25E1\u2266" },
  { tag: "sad",         label: "Sad",         icon: "\uFF08T_T\uFF09" },
  { tag: "angry",       label: "Angry",       icon: "(\u256C \u00D2\uFE3F\u00D3)" },
  { tag: "love",        label: "Love",        icon: "\u2661" },
  { tag: "surprise",    label: "Surprise",    icon: "\u2211(\uFF9F\u0414\uFF9F)" },
  { tag: "confused",    label: "Confused",    icon: "(\uFF1F_\uFF1F)" },
  { tag: "animals",     label: "Animals",     icon: "\u0295\u2022\u1D25\u2022\u0294" },
  { tag: "actions",     label: "Actions",     icon: "\u1555(\u141B)\u1557" },
  { tag: "expressions", label: "Expressions", icon: "( \u0361\u00B0 \u035C\u0296 \u0361\u00B0)" },
  { tag: "greetings",   label: "Greetings",   icon: "\uFF3F*^-^/" },
  { tag: "music",       label: "Music",       icon: "\u266A\uFF5E" },
  { tag: "fighting",    label: "Fighting",    icon: "\u1566(\u00F2_\u00F3)\u1564" },
  { tag: "magic",       label: "Magic",       icon: "\uFF89\u25D5\u30EE\u25D5)\uFF89" },
  { tag: "bears",       label: "Bears",       icon: "\u0295\u00B7\u1D25\u00B7\u0294" },
];

const PACK_CATEGORIES: Record<string, PackCategory[]> = {
  "Emoji Pack": EMOJI_CATEGORIES,
  "Kaomoji Pack": KAOMOJI_CATEGORIES,
};

const PACK_GROUPS = ["Emoji Pack", "Kaomoji Pack"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed as string[];
    return [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// SourceGroupHeader
// ---------------------------------------------------------------------------

function SourceGroupHeader({
  name,
  count,
  isCollapsed,
  onToggle,
  searchOpen,
  onToggleSearch,
}: {
  name: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  searchOpen?: boolean;
  onToggleSearch?: () => void;
}) {
  return (
    <div className="flex items-center w-full px-4 py-2 bg-surface-overlay/50 border-b border-border-subtle group">
      <button
        onClick={onToggle}
        className="flex items-center flex-1 min-w-0 hover:opacity-80 transition-opacity"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-text-tertiary transition-transform shrink-0 ${isCollapsed ? "" : "rotate-90"}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="ml-2 text-[11px] font-medium text-text-secondary">{name}</span>
        <span className="ml-1.5 text-[10px] text-text-tertiary">({count})</span>
      </button>
      {!isCollapsed && onToggleSearch && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSearch(); }}
          className={`p-1 rounded transition-colors shrink-0 ${
            searchOpen
              ? "text-accent"
              : "text-text-tertiary/0 group-hover:text-text-tertiary hover:!text-text-secondary"
          }`}
          title="Search in group"
        >
          <SearchIcon />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SnippetManager({ onBack }: SnippetManagerProps) {
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<{ id: string; name: string } | null>(null);
  const { snippets, loading, refresh } = useSnippets(search || undefined, undefined, sourceFilter?.id);

  const [view, setView] = useState<ViewMode>("list");
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);

  // Tab-cycling between All / Favorites / Recent (§4.2)
  const [listTab, setListTab] = useState<"all" | "favorites" | "recent">("all");
  const [favoriteSnippets, setFavoriteSnippets] = useState<Snippet[]>([]);
  const [recentSnippets, setRecentSnippets] = useState<Snippet[]>([]);

  // Pack status for stub group headers
  const [emojiPackStatus, setEmojiPackStatus] = useState<EmojiPackStatus | null>(null);
  const [kaomojiPackStatus, setKaomojiPackStatus] = useState<EmojiPackStatus | null>(null);
  // On-demand loaded pack snippets keyed by source id
  const [packSnippets] = useState<Record<string, Snippet[]>>({});

  // Fetch pack statuses on mount
  useEffect(() => {
    getEmojiPackStatus().then(setEmojiPackStatus).catch(() => {});
    getKaomojiPackStatus().then(setKaomojiPackStatus).catch(() => {});
  }, []);

  // Refresh pack statuses when snippets refresh
  const refreshAll = useCallback(async () => {
    await refresh();
    setCategorySnippets({});
    getEmojiPackStatus().then(setEmojiPackStatus).catch(() => {});
    getKaomojiPackStatus().then(setKaomojiPackStatus).catch(() => {});
  }, [refresh]);

  // Group snippets by source, injecting pack stubs when not searching
  const groupedSnippets = useMemo(() => {
    const groups: { name: string; sourceId: string | null; snippets: Snippet[]; packCount?: number }[] = [];
    const groupMap = new Map<string, typeof groups[0]>();

    for (const snippet of snippets) {
      const key = snippet.source_name || "Defaults";
      let group = groupMap.get(key);
      if (!group) {
        group = { name: key, sourceId: snippet.source_id, snippets: [] };
        groupMap.set(key, group);
        groups.push(group);
      }
      group.snippets.push(snippet);
    }

    // When not searching, inject stub groups for installed packs not already present
    if (!search) {
      const packInfos: { status: EmojiPackStatus | null; name: string }[] = [
        { status: emojiPackStatus, name: "Emoji Pack" },
        { status: kaomojiPackStatus, name: "Kaomoji Pack" },
      ];
      for (const { status, name } of packInfos) {
        if (!status?.installed || !status.source) continue;
        if (groupMap.has(name)) continue;
        const sourceId = status.source.id;
        // Use on-demand loaded snippets if available
        const loaded = packSnippets[sourceId] ?? [];
        const group = {
          name,
          sourceId,
          snippets: loaded,
          packCount: status.source.item_count ?? status.expected_count ?? 0,
        };
        groupMap.set(name, group);
        groups.push(group);
      }
    }

    return groups;
  }, [snippets, search, emojiPackStatus, kaomojiPackStatus, packSnippets]);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("dispatch_collapsed_groups");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return new Set<string>(parsed);
      }
    } catch {
      // ignore corrupt data
    }
    // Auto-collapse large packs by default
    return new Set<string>(PACK_GROUPS);
  });

  // Persist collapsed groups to localStorage
  useEffect(() => {
    localStorage.setItem(
      "dispatch_collapsed_groups",
      JSON.stringify([...collapsedGroups])
    );
  }, [collapsedGroups]);

  // Group sub-search state
  const [groupSearchOpen, setGroupSearchOpen] = useState<Set<string>>(new Set());
  const [groupSearchText, setGroupSearchText] = useState<Record<string, string>>({});
  const [packSearchResults, setPackSearchResults] = useState<Record<string, Snippet[]>>({});
  const [packSearchLoading, setPackSearchLoading] = useState<Record<string, boolean>>({});
  const packSearchTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const toggleGroupSearch = useCallback((groupName: string) => {
    setGroupSearchOpen((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
        // Clear search text when closing
        setGroupSearchText((t) => { const n = { ...t }; delete n[groupName]; return n; });
      } else {
        next.add(groupName);
      }
      return next;
    });
  }, []);

  const handleGroupSearchChange = useCallback((groupName: string, sourceId: string | null, isPack: boolean, text: string) => {
    setGroupSearchText((prev) => ({ ...prev, [groupName]: text }));
    if (isPack && sourceId) {
      // Debounced server-side search for pack groups
      if (packSearchTimers.current[groupName]) {
        clearTimeout(packSearchTimers.current[groupName]);
      }
      if (!text.trim()) {
        setPackSearchResults((prev) => { const n = { ...prev }; delete n[groupName]; return n; });
        setPackSearchLoading((prev) => ({ ...prev, [groupName]: false }));
        return;
      }
      setPackSearchLoading((prev) => ({ ...prev, [groupName]: true }));
      packSearchTimers.current[groupName] = setTimeout(async () => {
        try {
          const data = await listSnippets(text.trim(), undefined, sourceId, 200);
          setPackSearchResults((prev) => ({ ...prev, [groupName]: data }));
        } catch (err) {
          console.error("Pack search failed:", err);
        } finally {
          setPackSearchLoading((prev) => ({ ...prev, [groupName]: false }));
        }
      }, 250);
    }
  }, []);

  // Category browser state
  const [activePackCategory, setActivePackCategory] = useState<Record<string, string | null>>({});
  const [categorySnippets, setCategorySnippets] = useState<Record<string, Snippet[]>>({});
  const [categoryLoading, setCategoryLoading] = useState<Record<string, boolean>>({});

  const loadCategorySnippets = useCallback(async (sourceId: string, categoryTag: string) => {
    const cacheKey = `${sourceId}:${categoryTag}`;
    setActivePackCategory((prev) => ({ ...prev, [sourceId]: categoryTag }));
    if (categorySnippets[cacheKey]) return;
    setCategoryLoading((prev) => ({ ...prev, [cacheKey]: true }));
    try {
      const data = await listSnippets(undefined, categoryTag, sourceId);
      setCategorySnippets((prev) => ({ ...prev, [cacheKey]: data }));
    } catch (err) {
      console.error("Failed to load category snippets:", err);
    } finally {
      setCategoryLoading((prev) => ({ ...prev, [cacheKey]: false }));
    }
  }, [categorySnippets]);

  // Fetch favorites / recents when those tabs are selected
  useEffect(() => {
    if (listTab === "favorites") {
      listFavoriteSnippets()
        .then(setFavoriteSnippets)
        .catch((err) => console.error("Failed to load favorites:", err));
    } else if (listTab === "recent") {
      listRecentSnippets(20)
        .then(setRecentSnippets)
        .catch((err) => console.error("Failed to load recents:", err));
    }
  }, [listTab]);

  const toggleGroup = useCallback((groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  }, []);

  const handleOpenCreate = useCallback(() => {
    setEditingSnippet(null);
    setView("edit");
  }, []);

  const handleOpenEdit = useCallback((snippet: Snippet) => {
    setEditingSnippet(snippet);
    setView("edit");
  }, []);

  const handleBackToList = useCallback(() => {
    setView("list");
    setEditingSnippet(null);
    refreshAll();
  }, [refreshAll]);

  if (view === "edit") {
    return (
      <SnippetEditView
        snippet={editingSnippet}
        onBack={handleBackToList}
        onSaved={handleBackToList}
      />
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-surface">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle bg-surface shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <ChevronLeftIcon />
          Back
        </button>
        <input
          type="text"
          placeholder="Search snippets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
        />
        <button
          onClick={handleOpenCreate}
          className="flex items-center justify-center w-7 h-7 rounded-md bg-accent hover:bg-accent-hover text-white transition-colors shrink-0"
          title="Add snippet"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Live Expansion Toggle */}
      <div className="shrink-0"><LiveExpansionToggle /></div>

      <div className="shrink-0">
        <EmojiPackCard onChanged={refreshAll} />
        <KaomojiPackCard onChanged={refreshAll} />
      </div>

      {/* Source filter chip */}
      {sourceFilter && (
        <div className="flex items-center justify-between px-4 py-2 bg-accent/5 border-b border-border-subtle shrink-0">
          <span className="text-[11px] text-accent font-medium">
            Showing: {sourceFilter.name}
          </span>
          <button
            onClick={() => setSourceFilter(null)}
            className="text-[11px] text-text-tertiary hover:text-text-primary transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Tab bar: All / Favorites / Recent (§4.2) */}
      <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border-subtle bg-surface-overlay/30 shrink-0">
        {(["all", "favorites", "recent"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setListTab(tab)}
            className={`text-[11px] px-2.5 py-1 rounded-md transition-colors ${
              listTab === tab
                ? "bg-accent/15 text-accent font-medium"
                : "text-text-tertiary hover:text-text-secondary"
            }`}
          >
            {tab === "all" ? "All" : tab === "favorites" ? "\u2605 Favorites" : "\u25F7 Recent"}
          </button>
        ))}
      </div>

      {/* Snippet list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-text-tertiary">Loading snippets...</p>
          </div>
        ) : listTab === "favorites" ? (
          favoriteSnippets.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-text-tertiary">No favorite snippets yet.</p>
            </div>
          ) : (
            <div>
              {favoriteSnippets.map((snippet) => (
                <SnippetRow
                  key={snippet.id}
                  snippet={snippet}
                  onClick={() => handleOpenEdit(snippet)}
                  onRefresh={refreshAll}
                />
              ))}
            </div>
          )
        ) : listTab === "recent" ? (
          recentSnippets.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-text-tertiary">No recently used snippets.</p>
            </div>
          ) : (
            <div>
              {recentSnippets.map((snippet) => (
                <SnippetRow
                  key={snippet.id}
                  snippet={snippet}
                  onClick={() => handleOpenEdit(snippet)}
                  onRefresh={refreshAll}
                />
              ))}
            </div>
          )
        ) : snippets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <p className="text-sm text-text-tertiary">No snippets found.</p>
            <button
              onClick={handleOpenCreate}
              className="text-xs text-accent hover:text-accent-hover transition-colors"
            >
              Create your first snippet
            </button>
          </div>
        ) : !search ? (
          <div>
            {groupedSnippets.length > 1 && (
              <div className="flex items-center justify-end px-4 py-1.5 border-b border-border-subtle shrink-0">
                <button
                  onClick={() => setCollapsedGroups(new Set())}
                  className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors mr-2"
                >
                  Expand All
                </button>
                <button
                  onClick={() => setCollapsedGroups(new Set(groupedSnippets.map(g => g.name)))}
                  className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
                >
                  Collapse All
                </button>
              </div>
            )}
            {groupedSnippets.map((group) => {
              const isPack = PACK_GROUPS.includes(group.name);
              const isExpanded = !collapsedGroups.has(group.name);
              const searchText = groupSearchText[group.name] ?? "";
              const hasPackSearch = isPack && searchText.trim().length > 0;

              // Client-side filter for non-pack groups
              const filteredSnippets = !isPack && searchText.trim()
                ? group.snippets.filter((s) => {
                    const q = searchText.trim().toLowerCase();
                    return (
                      s.trigger.toLowerCase().includes(q) ||
                      (s.label ?? "").toLowerCase().includes(q) ||
                      s.body.toLowerCase().includes(q)
                    );
                  })
                : group.snippets;

              return (
                <div key={group.name}>
                  <SourceGroupHeader
                    name={group.name}
                    count={group.packCount ?? group.snippets.length}
                    isCollapsed={!isExpanded}
                    onToggle={() => toggleGroup(group.name)}
                    searchOpen={groupSearchOpen.has(group.name)}
                    onToggleSearch={() => toggleGroupSearch(group.name)}
                  />
                  {isExpanded && groupSearchOpen.has(group.name) && (
                    <GroupSearchBar
                      value={searchText}
                      onChange={(v) => handleGroupSearchChange(group.name, group.sourceId, isPack, v)}
                      placeholder={isPack ? `Search ${group.name}...` : "Filter snippets..."}
                    />
                  )}
                  {isExpanded && (
                    isPack && group.sourceId ? (
                      hasPackSearch ? (
                        packSearchLoading[group.name] ? (
                          <div className="flex items-center justify-center py-6">
                            <p className="text-xs text-text-tertiary">Searching...</p>
                          </div>
                        ) : (packSearchResults[group.name] ?? []).length === 0 ? (
                          <div className="flex items-center justify-center py-6">
                            <p className="text-xs text-text-tertiary">No results for "{searchText.trim()}"</p>
                          </div>
                        ) : (
                          (packSearchResults[group.name] ?? []).map((snippet) => (
                            <SnippetRow
                              key={snippet.id}
                              snippet={snippet}
                              onClick={() => handleOpenEdit(snippet)}
                              onRefresh={refreshAll}
                            />
                          ))
                        )
                      ) : (
                        <PackCategoryBrowser
                          packName={group.name}
                          sourceId={group.sourceId}
                          activeCategory={activePackCategory[group.sourceId] ?? null}
                          categorySnippets={categorySnippets}
                          categoryLoading={categoryLoading}
                          onSelectCategory={loadCategorySnippets}
                          onEditSnippet={handleOpenEdit}
                          onRefresh={refreshAll}
                        />
                      )
                    ) : (
                      filteredSnippets.length === 0 && searchText.trim() ? (
                        <div className="flex items-center justify-center py-6">
                          <p className="text-xs text-text-tertiary">No results for "{searchText.trim()}"</p>
                        </div>
                      ) : (
                        filteredSnippets.map((snippet) => (
                          <SnippetRow
                            key={snippet.id}
                            snippet={snippet}
                            onClick={() => handleOpenEdit(snippet)}
                            onRefresh={refreshAll}
                          />
                        ))
                      )
                    )
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div>
            {snippets.map((snippet) => (
              <SnippetRow
                key={snippet.id}
                snippet={snippet}
                onClick={() => handleOpenEdit(snippet)}
                onRefresh={refreshAll}
              />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

function EmojiPackCard({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const [status, setStatus] = useState<EmojiPackStatus | null>(null);
  const [busy, setBusy] = useState<"install" | "update" | "remove" | "toggle" | null>(null);
  const { showToast } = useToast();

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getEmojiPackStatus();
      setStatus(next);
    } catch (err) {
      console.error("Failed to load emoji pack status:", err);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const handleInstall = useCallback(async () => {
    setBusy("install");
    try {
      const result = await installEmojiPack();
      showToast(`Installed Emoji Pack — +${result.added} ~${result.updated} -${result.removed}`);
      await refreshStatus();
      await onChanged();
    } catch (err) {
      console.error("Emoji pack install failed:", err);
      showToast(`Failed to install Emoji Pack: ${err}`);
    } finally {
      setBusy(null);
    }
  }, [onChanged, refreshStatus, showToast]);

  const handleUpdate = useCallback(async () => {
    setBusy("update");
    try {
      const result = await updateEmojiPack();
      showToast(`Updated Emoji Pack — +${result.added} ~${result.updated} -${result.removed}`);
      await refreshStatus();
      await onChanged();
    } catch (err) {
      console.error("Emoji pack update failed:", err);
      showToast(`Failed to update Emoji Pack: ${err}`);
    } finally {
      setBusy(null);
    }
  }, [onChanged, refreshStatus, showToast]);

  const handleRemove = useCallback(async () => {
    setBusy("remove");
    try {
      await uninstallEmojiPack();
      showToast("Removed Emoji Pack");
      await refreshStatus();
      await onChanged();
    } catch (err) {
      console.error("Emoji pack remove failed:", err);
      showToast(`Failed to remove Emoji Pack: ${err}`);
    } finally {
      setBusy(null);
    }
  }, [onChanged, refreshStatus, showToast]);

  const handleToggle = useCallback(async () => {
    if (!status?.source) return;
    setBusy("toggle");
    try {
      await updateSnippetSource(status.source.id, {
        isEnabled: status.source.is_enabled === 0,
      });
      await refreshTriggers();
      showToast(status.source.is_enabled === 1 ? "Emoji Pack disabled" : "Emoji Pack enabled");
      await refreshStatus();
      await onChanged();
    } catch (err) {
      console.error("Emoji pack toggle failed:", err);
      showToast(`Failed to update Emoji Pack: ${err}`);
    } finally {
      setBusy(null);
    }
  }, [onChanged, refreshStatus, showToast, status]);

  const installed = status?.installed ?? false;
  const enabled = status?.source?.is_enabled === 1;
  const count = status?.source?.item_count ?? status?.expected_count ?? null;
  const version = status?.source?.source_version ?? status?.version ?? "Latest";

  return (
    <div className="px-4 py-3 border-b border-border-subtle bg-accent/5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-primary">Emoji Pack</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
              installed
                ? enabled
                  ? "border-success/30 text-success bg-success/10"
                  : "border-warning/30 text-warning bg-warning/10"
                : "border-border-subtle text-text-tertiary bg-surface-overlay/60"
            }`}>
              {installed ? (enabled ? "Installed" : "Disabled") : "Not installed"}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-text-secondary">
            Type emojis with <code className="font-mono text-accent">:shortcodes:</code> directly from Text Expander.
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-text-tertiary">
            <span>Version: {version}</span>
            <span>Count: {count ?? "..."}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!installed ? (
            <button
              onClick={handleInstall}
              disabled={busy !== null}
              className="text-[11px] text-white bg-accent hover:bg-accent-hover transition-colors px-2.5 py-1 rounded-md disabled:opacity-50"
            >
              {busy === "install" ? "Installing..." : "Install"}
            </button>
          ) : (
            <>
              <button
                onClick={handleUpdate}
                disabled={busy !== null}
                className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
              >
                {busy === "update" ? "Updating..." : "Update"}
              </button>
              <button
                onClick={handleToggle}
                disabled={busy !== null}
                className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
              >
                {busy === "toggle" ? "Saving..." : enabled ? "Disable" : "Enable"}
              </button>
              <button
                onClick={handleRemove}
                disabled={busy !== null}
                className="text-[11px] text-error hover:text-red-400 transition-colors disabled:opacity-50"
              >
                {busy === "remove" ? "Removing..." : "Remove"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KaomojiPackCard
// ---------------------------------------------------------------------------

function KaomojiPackCard({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const [status, setStatus] = useState<EmojiPackStatus | null>(null);
  const [busy, setBusy] = useState<"install" | "update" | "remove" | "toggle" | null>(null);
  const { showToast } = useToast();

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getKaomojiPackStatus();
      setStatus(next);
    } catch (err) {
      console.error("Failed to load kaomoji pack status:", err);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const handleInstall = useCallback(async () => {
    setBusy("install");
    try {
      const result = await installKaomojiPack();
      showToast(`Installed Kaomoji Pack — +${result.added} ~${result.updated} -${result.removed}`);
      await refreshStatus();
      await onChanged();
    } catch (err) {
      console.error("Kaomoji pack install failed:", err);
      showToast(`Failed to install Kaomoji Pack: ${err}`);
    } finally {
      setBusy(null);
    }
  }, [onChanged, refreshStatus, showToast]);

  const handleUpdate = useCallback(async () => {
    setBusy("update");
    try {
      const result = await updateKaomojiPack();
      showToast(`Updated Kaomoji Pack — +${result.added} ~${result.updated} -${result.removed}`);
      await refreshStatus();
      await onChanged();
    } catch (err) {
      console.error("Kaomoji pack update failed:", err);
      showToast(`Failed to update Kaomoji Pack: ${err}`);
    } finally {
      setBusy(null);
    }
  }, [onChanged, refreshStatus, showToast]);

  const handleRemove = useCallback(async () => {
    setBusy("remove");
    try {
      await uninstallKaomojiPack();
      showToast("Removed Kaomoji Pack");
      await refreshStatus();
      await onChanged();
    } catch (err) {
      console.error("Kaomoji pack remove failed:", err);
      showToast(`Failed to remove Kaomoji Pack: ${err}`);
    } finally {
      setBusy(null);
    }
  }, [onChanged, refreshStatus, showToast]);

  const handleToggle = useCallback(async () => {
    if (!status?.source) return;
    setBusy("toggle");
    try {
      await updateSnippetSource(status.source.id, {
        isEnabled: status.source.is_enabled === 0,
      });
      await refreshTriggers();
      showToast(status.source.is_enabled === 1 ? "Kaomoji Pack disabled" : "Kaomoji Pack enabled");
      await refreshStatus();
      await onChanged();
    } catch (err) {
      console.error("Kaomoji pack toggle failed:", err);
      showToast(`Failed to update Kaomoji Pack: ${err}`);
    } finally {
      setBusy(null);
    }
  }, [onChanged, refreshStatus, showToast, status]);

  const installed = status?.installed ?? false;
  const enabled = status?.source?.is_enabled === 1;
  const count = status?.source?.item_count ?? status?.expected_count ?? null;
  const version = status?.source?.source_version ?? status?.version ?? "Latest";

  return (
    <div className="px-4 py-3 border-b border-border-subtle bg-purple-500/5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-primary">Kaomoji Pack</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
              installed
                ? enabled
                  ? "border-success/30 text-success bg-success/10"
                  : "border-warning/30 text-warning bg-warning/10"
                : "border-border-subtle text-text-tertiary bg-surface-overlay/60"
            }`}>
              {installed ? (enabled ? "Installed" : "Disabled") : "Not installed"}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-text-secondary">
            Text faces like <code className="font-mono text-accent">:shrug:</code>, <code className="font-mono text-accent">:tableflip:</code>, <code className="font-mono text-accent">:lenny:</code>
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-text-tertiary">
            <span>Version: {version}</span>
            <span>Count: {count ?? "..."}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!installed ? (
            <button
              onClick={handleInstall}
              disabled={busy !== null}
              className="text-[11px] text-white bg-accent hover:bg-accent-hover transition-colors px-2.5 py-1 rounded-md disabled:opacity-50"
            >
              {busy === "install" ? "Installing..." : "Install"}
            </button>
          ) : (
            <>
              <button
                onClick={handleUpdate}
                disabled={busy !== null}
                className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
              >
                {busy === "update" ? "Updating..." : "Update"}
              </button>
              <button
                onClick={handleToggle}
                disabled={busy !== null}
                className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
              >
                {busy === "toggle" ? "Saving..." : enabled ? "Disable" : "Enable"}
              </button>
              <button
                onClick={handleRemove}
                disabled={busy !== null}
                className="text-[11px] text-error hover:text-red-400 transition-colors disabled:opacity-50"
              >
                {busy === "remove" ? "Removing..." : "Remove"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupSearchBar
// ---------------------------------------------------------------------------

function GroupSearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border-subtle bg-surface-overlay/20">
      <SearchIcon />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Search in group..."}
        className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="text-text-tertiary hover:text-text-primary transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PackCategoryBrowser
// ---------------------------------------------------------------------------

function PackCategoryBrowser({
  packName,
  sourceId,
  activeCategory,
  categorySnippets,
  categoryLoading,
  onSelectCategory,
  onEditSnippet,
  onRefresh,
}: {
  packName: string;
  sourceId: string;
  activeCategory: string | null;
  categorySnippets: Record<string, Snippet[]>;
  categoryLoading: Record<string, boolean>;
  onSelectCategory: (sourceId: string, categoryTag: string) => void;
  onEditSnippet: (snippet: Snippet) => void;
  onRefresh: () => void;
}) {
  const categories = PACK_CATEGORIES[packName] ?? [];
  const cacheKey = activeCategory ? `${sourceId}:${activeCategory}` : null;
  const snippets = cacheKey ? categorySnippets[cacheKey] ?? [] : [];
  const isLoading = cacheKey ? categoryLoading[cacheKey] ?? false : false;
  const activeCat = categories.find((c) => c.tag === activeCategory);

  return (
    <div>
      {/* Category icon strip */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border-subtle bg-surface-overlay/30 overflow-x-auto">
        {categories.map((cat) => (
          <button
            key={cat.tag}
            onClick={() => onSelectCategory(sourceId, cat.tag)}
            className={`flex items-center justify-center w-8 h-8 rounded-lg text-sm shrink-0 transition-all ${
              activeCategory === cat.tag
                ? "bg-accent/15 ring-1.5 ring-accent/40"
                : "hover:bg-surface-raised"
            }`}
            title={cat.label}
          >
            {cat.icon}
          </button>
        ))}
      </div>

      {/* Active category content */}
      {activeCategory === null ? (
        <div className="flex items-center justify-center py-6">
          <p className="text-xs text-text-tertiary">Select a category above</p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-6">
          <p className="text-xs text-text-tertiary">Loading {activeCat?.label ?? activeCategory}...</p>
        </div>
      ) : (
        <>
          {activeCat && (
            <div className="px-4 py-1.5 border-b border-border-subtle">
              <span className="text-[11px] font-medium text-text-secondary">
                {activeCat.label}
              </span>
              <span className="text-[10px] text-text-tertiary ml-1.5">
                ({snippets.length})
              </span>
            </div>
          )}
          {snippets.map((snippet) => (
            <SnippetRow
              key={snippet.id}
              snippet={snippet}
              onClick={() => onEditSnippet(snippet)}
              onRefresh={onRefresh}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SnippetRow
// ---------------------------------------------------------------------------

function SnippetRow({
  snippet,
  onClick,
  onRefresh,
}: {
  snippet: Snippet;
  onClick: () => void;
  onRefresh?: () => void;
}) {
  const tags = parseTags(snippet.tags);
  const emojiSnippet = isEmojiSnippet(snippet);
  const [copied, setCopied] = useState(false);
  const [isFav, setIsFav] = useState(snippet.is_favorite === 1);
  const { showToast } = useToast();

  // Try-expand state
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const expanded = await expandSnippet(snippet.id);
        await copyToClipboard(expanded);
        setCopied(true);
        showToast("Copied to clipboard");
        setTimeout(() => setCopied(false), 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    },
    [snippet.id, showToast]
  );

  const handleToggleFav = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const newVal = await toggleSnippetFavorite(snippet.id);
        setIsFav(newVal);
        onRefresh?.();
      } catch (err) {
        console.error("Toggle favorite failed:", err);
      }
    },
    [snippet.id, onRefresh]
  );

  const handleTry = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setTestResult(null);
      setTestError(null);

      const vars = parseVariables(snippet.variables);
      if (hasFormVariables(vars)) {
        // Build defaults and show inline form
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
        setShowForm(true);
      } else {
        // Expand immediately
        try {
          const expanded = await expandSnippet(snippet.id);
          setTestResult(expanded);
        } catch (err) {
          setTestError(String(err));
        }
      }
    },
    [snippet.id, snippet.variables]
  );

  const handleFormExpand = useCallback(async () => {
    try {
      const expanded = await expandSnippet(snippet.id, formValues);
      setTestResult(expanded);
      setShowForm(false);
    } catch (err) {
      setTestError(String(err));
      setShowForm(false);
    }
  }, [snippet.id, formValues]);

  const handleFormCancel = useCallback(() => {
    setShowForm(false);
    setFormValues({});
  }, []);

  const handleCopyResult = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!testResult) return;
      await copyToClipboard(testResult);
      showToast("Copied to clipboard");
    },
    [testResult, showToast]
  );

  const handleDismissResult = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setTestResult(null);
    setTestError(null);
  }, []);

  const isFromFile = snippet.source_type === "file";
  const formVarsForForm = useMemo(() => {
    const vars = parseVariables(snippet.variables);
    return vars.filter((v) => v.type === "form" || v.type === "choice");
  }, [snippet.variables]);

  return (
    <div className="relative group">
      <button
        onClick={onClick}
        className="w-full text-left px-4 py-3 border-b border-border-subtle hover:bg-surface-raised transition-colors"
      >
        {emojiSnippet ? (
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent/10 text-xl shrink-0">
              {snippet.body}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1 min-w-0">
                <button
                  onClick={handleToggleFav}
                  className={`text-xs shrink-0 transition-colors ${isFav ? "text-warning" : "text-text-tertiary/30 hover:text-text-tertiary"}`}
                  title={isFav ? "Remove from favorites" : "Add to favorites"}
                >
                  {isFav ? "\u2605" : "\u2606"}
                </button>
                <span className="text-sm font-mono text-accent">{snippet.trigger}</span>
                {snippet.label && (
                  <span className="text-xs text-text-primary truncate">
                    {snippet.label}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {tags.filter((tag) => tag !== "emoji").slice(0, 4).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary"
                  >
                    {tag}
                  </span>
                ))}
                {snippet.use_count > 0 && (
                  <span className="text-[10px] text-text-tertiary ml-auto">
                    used {snippet.use_count}x
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-1">
              <button
                onClick={handleToggleFav}
                className={`text-xs shrink-0 transition-colors ${isFav ? "text-warning" : "text-text-tertiary/30 hover:text-text-tertiary"}`}
                title={isFav ? "Remove from favorites" : "Add to favorites"}
              >
                {isFav ? "\u2605" : "\u2606"}
              </button>
              <span className="text-sm font-mono text-accent">{snippet.trigger}</span>
              {snippet.label && (
                <span className="text-xs text-text-secondary truncate">
                  {snippet.label}
                </span>
              )}
            </div>
            <p className="text-xs font-mono text-text-tertiary line-clamp-2 mb-1">
              {snippet.body}
            </p>
            <div className="flex items-center gap-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary"
                >
                  {tag}
                </span>
              ))}
              {snippet.use_count > 0 && (
                <span className="text-[10px] text-text-tertiary ml-auto">
                  used {snippet.use_count}x
                </span>
              )}
            </div>
          </>
        )}
        <div className="flex items-center gap-2 mt-1">
          {isFromFile && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent/10 text-accent">
              file
            </span>
          )}
        </div>
      </button>

      {/* Try + Copy button overlays */}
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
        <button
          onClick={handleTry}
          className="p-1.5 rounded-md bg-surface-overlay border border-border-subtle text-text-tertiary hover:text-accent hover:border-accent/30 transition-all"
          title="Try snippet"
        >
          <PlayIcon />
        </button>
        <button
          onClick={handleCopy}
          className="p-1.5 rounded-md bg-surface-overlay border border-border-subtle text-text-tertiary hover:text-accent hover:border-accent/30 transition-all"
          title="Copy expanded snippet"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>

      {/* Inline form for interactive variables */}
      {showForm && (
        <div
          className="border-b border-border-subtle bg-surface-raised/50"
          onClick={(e) => e.stopPropagation()}
        >
          <FormView
            variables={formVarsForForm}
            values={formValues}
            onValuesChange={setFormValues}
            onExpand={handleFormExpand}
            onCancel={handleFormCancel}
          />
        </div>
      )}

      {/* Inline test result */}
      {testResult !== null && (
        <div
          className="border-l-2 border-success mx-4 my-2 px-3 py-2 bg-success/5 rounded-r-md"
          onClick={(e) => e.stopPropagation()}
        >
          <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap break-words mb-2">
            {testResult}
          </pre>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyResult}
              className="text-[10px] text-accent hover:text-accent-hover transition-colors"
            >
              Copy
            </button>
            <button
              onClick={handleDismissResult}
              className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Inline test error */}
      {testError !== null && (
        <div
          className="border-l-2 border-error mx-4 my-2 px-3 py-2 bg-error/5 rounded-r-md"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-xs text-error break-words mb-2">{testError}</p>
          <button
            onClick={handleDismissResult}
            className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SnippetEditView
// ---------------------------------------------------------------------------

function SnippetEditView({
  snippet,
  onBack,
  onSaved,
}: {
  snippet: Snippet | null;
  onBack: () => void;
  onSaved: () => void;
}) {
  const isEdit = snippet !== null;

  const [trigger, setTrigger] = useState(snippet?.trigger ?? "");
  const [label, setLabel] = useState(snippet?.label ?? "");
  const [body, setBody] = useState(snippet?.body ?? "");
  const [tagsInput, setTagsInput] = useState(
    parseTags(snippet?.tags ?? null).join(", ")
  );
  const [enabled, setEnabled] = useState(snippet?.is_enabled ?? 1);
  const [variables, setVariables] = useState<SnippetVariable[]>(
    parseVariables(snippet?.variables ?? null)
  );
  const [editingVarIndex, setEditingVarIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const tagsArr = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const tagsJson = tagsArr.length > 0 ? JSON.stringify(tagsArr) : undefined;
      const varsJson =
        variables.length > 0 ? JSON.stringify(variables) : undefined;

      if (isEdit) {
        await updateSnippet(snippet.id, {
          trigger,
          label: label || undefined,
          body,
          tags: tagsJson,
          variables: varsJson,
          is_enabled: enabled,
        });
      } else {
        await createSnippet({
          trigger,
          label: label || undefined,
          body,
          tags: tagsJson,
          variables: varsJson,
        });
      }
      onSaved();
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  }, [trigger, label, body, tagsInput, enabled, variables, isEdit, snippet, onSaved]);

  const handleDelete = useCallback(async () => {
    if (!snippet) return;
    try {
      await deleteSnippet(snippet.id);
      onSaved();
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }, [snippet, onSaved]);

  const handleAddVariable = useCallback(() => {
    const newVar: SnippetVariable = { name: "", type: "echo", params: {} };
    setVariables((prev) => [...prev, newVar]);
    setEditingVarIndex(variables.length);
  }, [variables.length]);

  const handleUpdateVariable = useCallback(
    (index: number, updated: SnippetVariable) => {
      setVariables((prev) => prev.map((v, i) => (i === index ? updated : v)));
    },
    []
  );

  const handleRemoveVariable = useCallback((index: number) => {
    setVariables((prev) => prev.filter((_, i) => i !== index));
    setEditingVarIndex(null);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-surface">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <ChevronLeftIcon />
          Back to list
        </button>
        {isEdit && (
          <button
            onClick={handleDelete}
            className="text-xs text-error hover:text-red-400 transition-colors px-2 py-1 rounded-md"
          >
            Delete
          </button>
        )}
      </div>

      {/* Warning for source-imported snippets */}
      {isEdit && snippet?.source_type === "file" && (
        <div className="px-4 py-2 bg-warning/10 border-b border-warning/20">
          <p className="text-[11px] text-warning">
            This snippet is imported from a source file. Edits here only apply locally
            and will be overwritten on next sync. Edit the source file directly for
            permanent changes.
          </p>
        </div>
      )}

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Trigger */}
        <div>
          <FieldLabel label="Trigger" value={trigger} />
          <input
            type="text"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            placeholder=":trigger"
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>

        {/* Label */}
        <div>
          <FieldLabel label="Label" value={label} />
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Optional label"
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>

        {/* Body */}
        <div>
          <FieldLabel label="Body" value={body} />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder="Snippet content..."
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors resize-y"
          />
        </div>

        {/* Variables */}
        <div>
          <label className="block text-xs font-semibold text-text-secondary mb-2">
            Variables
          </label>
          {variables.length === 0 ? (
            <p className="text-xs text-text-tertiary mb-2">No variables defined.</p>
          ) : (
            <div className="space-y-2 mb-2">
              {variables.map((v, i) => (
                <div
                  key={i}
                  className="rounded-lg bg-surface-raised border border-border-subtle p-3"
                >
                  {editingVarIndex === i ? (
                    <VariableEditor
                      variable={v}
                      onChange={(updated) => handleUpdateVariable(i, updated)}
                      onDone={() => setEditingVarIndex(null)}
                      onRemove={() => handleRemoveVariable(i)}
                    />
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-accent">
                          {v.name || "(unnamed)"}
                        </span>
                        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-surface-overlay text-text-tertiary">
                          {v.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setEditingVarIndex(i)}
                          className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleRemoveVariable(i)}
                          className="text-[11px] text-error hover:text-red-400 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <button
            onClick={handleAddVariable}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            + Add Variable
          </button>
        </div>

        {/* Tags */}
        <div>
          <FieldLabel label="Tags" value={tagsInput} />
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="Comma-separated tags"
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>

        {/* Enabled toggle */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="snippet-enabled"
            checked={enabled === 1}
            onChange={(e) => setEnabled(e.target.checked ? 1 : 0)}
            className="rounded border-border-subtle accent-accent"
          />
          <label
            htmlFor="snippet-enabled"
            className="text-xs text-text-secondary"
          >
            Enabled
          </label>
        </div>
      </div>

      {/* Save button */}
      <div className="px-4 py-3 border-t border-border-subtle bg-surface shrink-0">
        <button
          onClick={handleSave}
          disabled={saving || !trigger || !body}
          className="w-full py-2 rounded-md bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VariableEditor
// ---------------------------------------------------------------------------

function VariableEditor({
  variable,
  onChange,
  onDone,
  onRemove,
}: {
  variable: SnippetVariable;
  onChange: (v: SnippetVariable) => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  const updateParam = (key: string, value: unknown) => {
    onChange({ ...variable, params: { ...variable.params, [key]: value } });
  };

  return (
    <div className="space-y-3">
      {/* Name */}
      <div>
        <label className="block text-[11px] text-text-tertiary mb-1">Name</label>
        <input
          type="text"
          value={variable.name}
          onChange={(e) => onChange({ ...variable, name: e.target.value })}
          placeholder="variable_name"
          className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
        />
      </div>

      {/* Type */}
      <div>
        <label className="block text-[11px] text-text-tertiary mb-1">Type</label>
        <select
          value={variable.type}
          onChange={(e) =>
            onChange({
              ...variable,
              type: e.target.value as SnippetVariable["type"],
              params: {},
            })
          }
          className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50 transition-colors"
        >
          {VARIABLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Type-specific params */}
      <VariableParamsEditor variable={variable} updateParam={updateParam} />

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onDone}
          className="text-[11px] text-accent hover:text-accent-hover transition-colors"
        >
          Done
        </button>
        <button
          onClick={onRemove}
          className="text-[11px] text-error hover:text-red-400 transition-colors"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VariableParamsEditor
// ---------------------------------------------------------------------------

function VariableParamsEditor({
  variable,
  updateParam,
}: {
  variable: SnippetVariable;
  updateParam: (key: string, value: unknown) => void;
}) {
  switch (variable.type) {
    case "echo":
      return (
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1">
            Value
          </label>
          <input
            type="text"
            value={(variable.params.value as string) ?? ""}
            onChange={(e) => updateParam("value", e.target.value)}
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>
      );

    case "date":
      return (
        <>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              Format
            </label>
            <input
              type="text"
              value={(variable.params.format as string) ?? ""}
              onChange={(e) => updateParam("format", e.target.value)}
              placeholder="%Y-%m-%d"
              className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              Offset
            </label>
            <input
              type="text"
              value={(variable.params.offset as string) ?? ""}
              onChange={(e) => updateParam("offset", e.target.value)}
              placeholder="e.g. -1d, +2h"
              className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>
        </>
      );

    case "clipboard":
      return (
        <p className="text-[11px] text-text-tertiary">
          No parameters needed. Clipboard contents will be inserted.
        </p>
      );

    case "shell":
      return (
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1">
            Command
          </label>
          <textarea
            value={(variable.params.cmd as string) ?? ""}
            onChange={(e) => updateParam("cmd", e.target.value)}
            rows={3}
            placeholder="echo 'hello'"
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary font-mono placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors resize-y"
          />
        </div>
      );

    case "form":
      return (
        <>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              Label
            </label>
            <input
              type="text"
              value={(variable.params.label as string) ?? ""}
              onChange={(e) => updateParam("label", e.target.value)}
              placeholder="Field label"
              className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              Default value
            </label>
            <input
              type="text"
              value={(variable.params.default as string) ?? ""}
              onChange={(e) => updateParam("default", e.target.value)}
              className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!variable.params.multiline}
              onChange={(e) => updateParam("multiline", e.target.checked)}
              className="rounded border-border-subtle accent-accent"
            />
            <span className="text-[11px] text-text-tertiary">Multiline</span>
          </div>
        </>
      );

    case "choice":
      return (
        <ListParamEditor
          label="Label"
          labelValue={(variable.params.label as string) ?? ""}
          onLabelChange={(v) => updateParam("label", v)}
          items={((variable.params.values as string[]) ?? []) as string[]}
          onItemsChange={(items) => updateParam("values", items)}
          itemPlaceholder="Choice value"
        />
      );

    case "random":
      return (
        <ListParamEditor
          items={((variable.params.values as string[]) ?? []) as string[]}
          onItemsChange={(items) => updateParam("values", items)}
          itemPlaceholder="Random value"
        />
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// ListParamEditor (for choice/random values lists)
// ---------------------------------------------------------------------------

function ListParamEditor({
  label,
  labelValue,
  onLabelChange,
  items,
  onItemsChange,
  itemPlaceholder,
}: {
  label?: string;
  labelValue?: string;
  onLabelChange?: (v: string) => void;
  items: string[];
  onItemsChange: (items: string[]) => void;
  itemPlaceholder: string;
}) {
  const [newItem, setNewItem] = useState("");

  const addItem = () => {
    const trimmed = newItem.trim();
    if (trimmed) {
      onItemsChange([...items, trimmed]);
      setNewItem("");
    }
  };

  return (
    <>
      {label && onLabelChange && (
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1">
            {label}
          </label>
          <input
            type="text"
            value={labelValue ?? ""}
            onChange={(e) => onLabelChange(e.target.value)}
            className="w-full bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>
      )}
      <div>
        <label className="block text-[11px] text-text-tertiary mb-1">
          Values
        </label>
        {items.length > 0 && (
          <div className="space-y-1 mb-2">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-text-primary flex-1 truncate font-mono">
                  {item}
                </span>
                <button
                  onClick={() =>
                    onItemsChange(items.filter((_, idx) => idx !== i))
                  }
                  className="text-[10px] text-error hover:text-red-400 transition-colors shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addItem();
              }
            }}
            placeholder={itemPlaceholder}
            className="flex-1 bg-surface-overlay border border-border-subtle rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 transition-colors"
          />
          <button
            onClick={addItem}
            className="text-[11px] text-accent hover:text-accent-hover transition-colors shrink-0"
          >
            Add
          </button>
        </div>
      </div>
    </>
  );
}


// ---------------------------------------------------------------------------
// LiveExpansionToggle
// ---------------------------------------------------------------------------

function LiveExpansionToggle() {
  const [enabled, setEnabled] = useState(false);
  const [diag, setDiag] = useState<ExpansionDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const refreshDiagnostics = useCallback(async () => {
    try {
      const [isEnabled, diagnostics] = await Promise.all([
        getLiveExpansionEnabled(),
        getExpansionDiagnostics(),
      ]);
      setEnabled(isEnabled);
      setDiag(diagnostics);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshDiagnostics();
  }, [refreshDiagnostics]);

  const handleToggle = useCallback(async () => {
    if (diag && !diag.accessibility) {
      await requestAccessibilityPermission();
      // Refresh after user potentially grants permission
      setTimeout(refreshDiagnostics, 1000);
      return;
    }
    const newValue = !enabled;
    try {
      await setLiveExpansionEnabled(newValue);
      setEnabled(newValue);
      refreshDiagnostics();
    } catch (err) {
      console.error("[LiveExpansion] toggle failed:", err);
    }
  }, [enabled, diag, refreshDiagnostics]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testTextInjection();
      setTestResult(result);
    } catch (err) {
      setTestResult(`Error: ${err}`);
    } finally {
      setTesting(false);
    }
  }, []);

  if (loading) return null;

  const hasAccess = diag?.accessibility ?? false;
  const listenerActive = diag?.listener_active ?? false;
  const eventCount = diag?.event_count ?? 0;
  const triggerCount = diag?.trigger_count ?? 0;
  const allGood = hasAccess && listenerActive;

  return (
    <div className="px-4 py-3 border-b border-border-subtle bg-surface-raised/50 space-y-2">
      {/* Toggle row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">
            Live Expansion
          </span>
          {/* Quick status checkmarks */}
          <span
            className={`text-[11px] ${hasAccess ? "text-success" : "text-error"}`}
            title={hasAccess ? "Accessibility: granted" : "Accessibility: not granted"}
          >
            {hasAccess ? "\u2713" : "\u2717"}
          </span>
          <span
            className={`text-[11px] ${listenerActive ? "text-success" : enabled ? "text-warning" : "text-text-tertiary"}`}
            title={listenerActive ? "Keyboard listener: active" : enabled ? "Keyboard listener: inactive" : "Keyboard listener: disabled"}
          >
            {listenerActive ? "\u2713" : enabled ? "\u25CB" : "\u2717"}
          </span>
        </div>
        <button
          onClick={handleToggle}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
            enabled
              ? "bg-accent"
              : "bg-surface-overlay border border-border-subtle"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* Permission checklist */}
      <div className="space-y-1">
        <PermissionRow
          label="Accessibility"
          description="Keyboard listener + text injection"
          granted={hasAccess}
          onOpenSettings={() => openPrivacySettings("Accessibility")}
        />
        {hasAccess && enabled && (
          <div className="flex items-center gap-2">
            <span
              className={`text-[11px] ${listenerActive ? "text-success" : "text-warning"}`}
            >
              {listenerActive ? "\u2713" : "\u25CB"}
            </span>
            <span className="text-[11px] text-text-secondary">
              Keyboard listener
              <span className="text-text-tertiary ml-1">
                — {listenerActive ? "active" : "waiting for permission (retrying...)"}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Status line */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-text-tertiary">
          {!enabled
            ? "Disabled"
            : allGood
              ? `Listening — ${triggerCount} trigger${triggerCount !== 1 ? "s" : ""} loaded — ${eventCount} events`
              : !hasAccess
                ? "Grant Accessibility permission to enable keyboard listener"
                : "Waiting for keyboard listener to start..."}
        </span>
        {enabled && (
          <button
            onClick={handleTest}
            disabled={testing}
            className="text-[10px] text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
          >
            {testing ? "Testing..." : "Test Injection"}
          </button>
        )}
        <button
          onClick={refreshDiagnostics}
          className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors ml-auto"
        >
          Refresh
        </button>
      </div>

      {/* Test result */}
      {testResult && (
        <div
          className={`text-[10px] px-2 py-1.5 rounded ${
            testResult.startsWith("OK")
              ? "bg-success/10 text-success"
              : "bg-error/10 text-error"
          }`}
        >
          {testResult}
        </div>
      )}
    </div>
  );
}

function PermissionRow({
  label,
  description,
  granted,
  onOpenSettings,
}: {
  label: string;
  description: string;
  granted: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`text-[11px] ${granted ? "text-success" : "text-error"}`}
      >
        {granted ? "\u2713" : "\u2717"}
      </span>
      <span className="text-[11px] text-text-secondary flex-1">
        {label}
        <span className="text-text-tertiary ml-1">— {description}</span>
      </span>
      {!granted && (
        <button
          onClick={onOpenSettings}
          className="text-[10px] text-accent hover:text-accent-hover transition-colors shrink-0"
        >
          Open Settings
        </button>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// FieldLabel — label with inline copy button
// ---------------------------------------------------------------------------

function FieldLabel({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const { showToast } = useToast();

  const handleCopy = useCallback(async () => {
    if (!value) return;
    await copyToClipboard(value);
    setCopied(true);
    showToast("Copied to clipboard");
    setTimeout(() => setCopied(false), 1500);
  }, [value, showToast]);

  return (
    <div className="flex items-center justify-between mb-1">
      <label className="text-xs font-semibold text-text-secondary">
        {label}
      </label>
      {value && (
        <button
          onClick={handleCopy}
          className="p-0.5 text-text-tertiary hover:text-accent transition-colors"
          title={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function SearchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-success"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
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
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
