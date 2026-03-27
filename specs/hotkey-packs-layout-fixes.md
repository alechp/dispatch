# Spec: Focus-Terminal Hotkey Parity, Snippet Packs & Layout Fixes

## Status: Draft
## Branch: `spec/hotkey-packs-layout-fixes`
## Depends on: `impl/source-visibility-editing-toggles`

---

## 1. Problem Statement

Three issues degrade the app experience:

1. **"t" hotkey doesn't focus terminal correctly** — Pressing "t" to focus terminal has reduced functionality compared to clicking the "Focus Terminal" button. The hotkey handler doesn't mark the notification as read, doesn't show a toast, and doesn't pass the notification ID to the backend (so Yapture bidirectional sync is skipped). The button click does all three.

2. **Snippets are a flat list with no grouping** — All snippets appear in a single flat list sorted by use count. Users with multiple source packs (e.g., "work-snippets", "personal", "defaults") have no way to visually distinguish which pack a snippet belongs to. Each snippet has a tiny source badge, but there's no section separation. Users should see collapsible pack sections.

3. **CSS layout bug hides the bottom bar and CTA elements** — The SnippetManager root uses `h-screen` but is rendered inside an already `h-screen` parent, causing the content to overflow. Three intermediate flex children (LiveExpansionToggle, New Config CTA, source filter chip) lack `shrink-0`, so they collapse on resize. The bottom bar (Import/Export/Sources) is pushed below the viewport. Users report it "flashes" briefly during window resize before disappearing.

---

## 2. Changes

### 2.1 Fix "t" Hotkey for Focus Terminal (Parity with Click)

**Problem**: The hotkey handler in `App.tsx` lines 243–250 has different behavior than the button click handler.

#### Current hotkey handler (`App.tsx:243`):
```ts
focusTerminal: () => {
  if (selectedIndex !== null) {
    const n = notifications[selectedIndex];
    if (n?.tmux_session) {
      handleFocusTerminal(n.id, n.tmux_session, n.tmux_window, n.tmux_pane);
    }
  }
},
```

#### Current click handler (`App.tsx:81`):
```ts
const handleFocusTerminal = useCallback(
  async (id: string, session: string, window: string | null, pane: string | null) => {
    markRead(id);
    trackEvent("notification_read", { targetId: id, metadata: { method: "terminal_focus" } });
    trackEvent("terminal_focused", { targetId: id, metadata: { session, window, pane } });
    await focusTerminal(session, window ?? undefined, pane ?? undefined, id);
    toastCtx.showToast(`Focused terminal: ${session}`);
  },
  [markRead, toastCtx]
);
```

**Analysis**: The hotkey handler already calls `handleFocusTerminal` which does markRead + toast + tracking. So the actual call chain is identical. The real issue is:

| Issue | Hotkey | Button Click |
|-------|--------|-------------|
| Requires notification selected | YES — `selectedIndex !== null` | N/A — button is on the card |
| Guards on `tmux_session` | YES — runtime check | YES — button only renders when present |
| Feedback when nothing is selected | NONE — silently fails | N/A |
| Feedback when no tmux_session | NONE — silently fails | N/A — button hidden |

**Root cause**: The "t" hotkey fails silently when:
1. No notification is selected (user presses "t" without first pressing j/k to select)
2. The selected notification has no `tmux_session` (not all notifications are terminal-related)

**Fix**: Add user feedback for these failure cases, and ensure the selection state is visible.

#### 2.1.1 Add Feedback for Silent Failures

In `App.tsx` `hotkeyActions.focusTerminal`:

```ts
focusTerminal: () => {
  if (selectedIndex === null) {
    toastCtx.showToast("Select a notification first (j/k)");
    return;
  }
  const n = notifications[selectedIndex];
  if (!n?.tmux_session) {
    toastCtx.showToast("No terminal session on this notification");
    return;
  }
  handleFocusTerminal(n.id, n.tmux_session, n.tmux_window, n.tmux_pane);
},
```

#### 2.1.2 Ensure Feed Screen Is Active

The "t" hotkey is scoped to "app" in `useHotkeys.ts`, meaning it fires on any screen. But `selectedIndex` and `notifications` only relate to the feed screen. If the user is on the expander or settings screen, "t" will silently fail or reference stale data.

Guard the action to only work on the feed/notifications screen:

```ts
focusTerminal: () => {
  if (activeScreen !== "feed" || feedView !== "notifications") {
    return; // Not on notifications — ignore
  }
  if (selectedIndex === null) {
    toastCtx.showToast("Select a notification first (j/k)");
    return;
  }
  const n = notifications[selectedIndex];
  if (!n?.tmux_session) {
    toastCtx.showToast("No terminal session on this notification");
    return;
  }
  handleFocusTerminal(n.id, n.tmux_session, n.tmux_window, n.tmux_pane);
},
```

Add `activeScreen` and `feedView` to the `hotkeyActions` useMemo dependency array.

---

### 2.2 Snippet Packs — Grouped by Source with Collapsible Sections

**Goal**: Replace the flat snippet list with collapsible source-grouped sections.

#### 2.2.1 Group Snippets by Source

In `SnippetManager.tsx`, after fetching snippets, group them by `source_name`:

```ts
const groupedSnippets = useMemo(() => {
  const groups: { name: string; sourceId: string | null; snippets: Snippet[] }[] = [];
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

  return groups;
}, [snippets]);
```

#### 2.2.2 Collapsed State

Track which groups are collapsed:

```ts
const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

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
```

#### 2.2.3 SourceGroupHeader Component

Add a new inline component:

```tsx
function SourceGroupHeader({
  name,
  count,
  isCollapsed,
  onToggle,
}: {
  name: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center w-full px-4 py-2 bg-surface-overlay/50 border-b border-border-subtle hover:bg-surface-overlay transition-colors group"
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
        className={`text-text-tertiary transition-transform ${isCollapsed ? "" : "rotate-90"}`}
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
      <span className="ml-2 text-[11px] font-medium text-text-secondary">{name}</span>
      <span className="ml-1.5 text-[10px] text-text-tertiary">({count})</span>
    </button>
  );
}
```

#### 2.2.4 Update List Rendering

Replace the flat `snippets.map(...)` with grouped rendering:

```tsx
<div className="flex-1 overflow-y-auto">
  {loading ? (
    /* ... loading state ... */
  ) : snippets.length === 0 ? (
    /* ... empty state ... */
  ) : (
    <div>
      {groupedSnippets.map((group) => (
        <div key={group.name}>
          <SourceGroupHeader
            name={group.name}
            count={group.snippets.length}
            isCollapsed={collapsedGroups.has(group.name)}
            onToggle={() => toggleGroup(group.name)}
          />
          {!collapsedGroups.has(group.name) &&
            group.snippets.map((snippet) => (
              <SnippetRow
                key={snippet.id}
                snippet={snippet}
                onClick={() => handleOpenEdit(snippet)}
                onRefresh={refresh}
              />
            ))}
        </div>
      ))}
    </div>
  )}
</div>
```

#### 2.2.5 Remove Redundant Source Badge from SnippetRow

Since snippets are now grouped by source, the per-row source badge (`source_name` badge in top-right) is redundant. Remove it from `SnippetRow` to reduce visual clutter:

```tsx
// Remove this block from SnippetRow:
{snippet.source_name && snippet.source_name !== "Defaults" && (
  <span className="text-[10px] text-text-tertiary bg-surface-overlay px-1.5 py-0.5 rounded ml-auto">
    {snippet.source_name}
  </span>
)}
```

#### 2.2.6 Expand All / Collapse All

Add toggle buttons in the top bar or above the snippet list:

```tsx
{groupedSnippets.length > 1 && (
  <div className="flex items-center justify-end px-4 py-1.5 border-b border-border-subtle">
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
```

#### 2.2.7 Search Behavior

When the user is searching (`search` is non-empty), show results flat (ungrouped) to avoid confusing empty groups. Only show grouped view when search is empty:

```ts
const shouldGroup = !search;
```

---

### 2.3 Fix CSS Layout Bug — SnippetManager Overflow

**Problem**: SnippetManager declares `h-screen` on its root but is rendered inside a parent that is also `h-screen`. This causes the component to overflow the viewport. Three flex children lack `shrink-0`, allowing them to collapse during flex calculation. The bottom bar is pushed below the visible area.

#### Layout Chain (Current — Broken):

```
App.tsx:328     → <div className="flex flex-col h-screen">
                    ├─ <Header>              (shrink-0 implied, ~44px)
                    └─ <SnippetManager>
SnippetManager  → <div className="flex flex-col h-screen bg-surface">  ← BUG: h-screen
                    ├─ Top bar               (shrink-0 ✓)
                    ├─ LiveExpansionToggle    (NO shrink-0 ✗)
                    ├─ New Config CTA         (NO shrink-0 ✗)
                    ├─ Source filter chip     (NO shrink-0 ✗)
                    ├─ Snippet list           (flex-1 overflow-y-auto ✓)
                    └─ Bottom bar             (shrink-0 ✓)
```

The inner `h-screen` is 100vh, but it starts below the Header (~44px). This pushes the bottom bar 44px below the viewport.

#### 2.3.1 Fix Root Container Height

Change SnippetManager root from `h-screen` to `flex-1 min-h-0`:

```tsx
// Before (line 188):
<div className="flex flex-col h-screen bg-surface">

// After:
<div className="flex flex-col flex-1 min-h-0 bg-surface">
```

`flex-1` makes it fill available space in the parent. `min-h-0` prevents flex min-content sizing from causing overflow.

#### 2.3.2 Add `shrink-0` to Utility Sections

Add `shrink-0` to three sections that are missing it:

**LiveExpansionToggle** (line 218) — The component itself needs shrink-0. Wrap or add to its root:
```tsx
<div className="shrink-0">
  <LiveExpansionToggle />
</div>
```

**New Config CTA** (line 221):
```tsx
// Before:
<div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle">

// After:
<div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle shrink-0">
```

**Source filter chip** (line 234):
```tsx
// Before:
<div className="flex items-center justify-between px-4 py-2 bg-accent/5 border-b border-border-subtle">

// After:
<div className="flex items-center justify-between px-4 py-2 bg-accent/5 border-b border-border-subtle shrink-0">
```

#### 2.3.3 Fix Other Screens Too

Check that other screens rendered inside the same parent `flex flex-col h-screen` don't also use `h-screen`:

- `TelemetryScreen` — check its root element
- `YaptureSettings` — check its root element
- `SessionContent` — check its root element

Any that use `h-screen` should be changed to `flex-1 min-h-0` for the same reason.

#### Layout Chain (Fixed):

```
App.tsx:328     → <div className="flex flex-col h-screen">
                    ├─ <Header>              (shrink-0, ~44px)
                    └─ <SnippetManager>
SnippetManager  → <div className="flex flex-col flex-1 min-h-0 bg-surface">
                    ├─ Top bar               (shrink-0 ✓)
                    ├─ LiveExpansionToggle    (shrink-0 ✓)
                    ├─ New Config CTA         (shrink-0 ✓)
                    ├─ Source filter chip     (shrink-0 ✓)
                    ├─ Snippet list           (flex-1 overflow-y-auto ✓)
                    └─ Bottom bar             (shrink-0 ✓)
```

---

## 3. Implementation Phases

### Phase 1: CSS Layout Fix (Critical — Unblocks Visibility of All Previous Work)

**Files:**
- `src/components/SnippetManager.tsx` — change root `h-screen` to `flex-1 min-h-0`, add `shrink-0` to LiveExpansionToggle wrapper, New Config CTA, source filter chip
- Check and fix root element of: `TelemetryScreen`, `YaptureSettings`, `SessionContent`

**Verify:** Bottom bar (Import/Export/Sources) and New Config CTA are visible at all window sizes. Resizing window does not cause elements to disappear.

### Phase 2: Focus Terminal Hotkey Fix

**Files:**
- `src/App.tsx` — update `focusTerminal` action in `hotkeyActions` with screen guard and toast feedback for failure cases; add `activeScreen`, `feedView` to dependency array

**Verify:** Press "t" without selection → toast "Select a notification first (j/k)". Select terminal notification → press "t" → terminal focuses + toast + marked read. Select non-terminal notification → press "t" → toast "No terminal session on this notification". Press "t" on expander screen → no action.

### Phase 3: Snippet Packs — Grouped by Source

**Files:**
- `src/components/SnippetManager.tsx` — add `groupedSnippets` memo, `collapsedGroups` state, `SourceGroupHeader` component, grouped rendering, expand/collapse all buttons, flat mode when searching, remove per-row source badge

**Verify:** Snippet list shows collapsible sections per source. Click header → collapses/expands. Search → flat results. Multiple packs → each in own section.

---

## 4. File-Level Change Summary

| File | Phase | Change |
|------|-------|--------|
| `src/components/SnippetManager.tsx` | 1, 3 | Fix root container height, add shrink-0 to 3 sections, add groupedSnippets/collapsedGroups, SourceGroupHeader, grouped rendering, remove per-row source badge |
| `src/App.tsx` | 2 | Add screen guard and failure toasts to focusTerminal hotkey action |
| `src/components/TelemetryScreen.tsx` | 1 | Check/fix root height (h-screen → flex-1 min-h-0 if needed) |
| `src/components/YaptureSettings.tsx` | 1 | Check/fix root height (h-screen → flex-1 min-h-0 if needed) |
| `src/components/SessionTracker.tsx` | 1 | Check/fix SessionContent root height if needed |

---

## 5. Conflict Analysis

- **Phase 1** and **Phase 3** both modify `SnippetManager.tsx` but touch different sections (root div + shrink-0 classes vs snippet list rendering). Can be done sequentially in one pass.
- **Phase 2** only touches `App.tsx`. Independent of phases 1 and 3.

**Recommended execution order**: Phase 1 (layout fix) first — this unblocks visibility of all previous work. Then Phase 2 (hotkey) and Phase 3 (packs) can be done in either order or in parallel since they touch different files.

---

## 6. Out of Scope

- **Persistent collapse state** — Saving expanded/collapsed state per source in localStorage. Can be added later.
- **Drag-and-drop reordering** — Reordering snippets between packs or within a pack.
- **Pack-level actions** — Bulk enable/disable/delete all snippets in a pack from the list view.
- **Animated collapse transitions** — CSS transitions for expand/collapse. Plain show/hide is sufficient for v1.
- **Custom sort within packs** — Snippets within each pack use the existing sort order (use_count DESC, updated_at DESC).
