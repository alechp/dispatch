# Consolidated Spec: Remaining Features, Fixes & Future Work

## Status: Active Backlog
## Date: 2026-04-11
## Source: Consolidated from 11 completed specs

---

## Overview

This document consolidates all deferred work, open questions, and future enhancements identified across the original 11 Dispatch specification files — all of which have been fully implemented and archived. Items are organized by priority and domain.

---

## 1. macOS Live Expansion — Accessibility-Only Refactor

**Source:** `batch-4-fixes-and-oauth.md` Item 7 Phase B, `batch-3-ux-enhancements.md` Item 5 Phase 2
**Priority:** High
**Complexity:** Large

### Problem

Text expansion on macOS currently requires **two separate permissions** (Input Monitoring for CGEventTap + Accessibility for enigo text injection). This creates a confusing setup UX and is fragile — unsigned apps can have CGEventTap silently disabled after restart. Espanso solves this with a single Accessibility permission.

### Current State

- Phase A (diagnostics + permission UX) is implemented: separate status indicators, permission-specific System Settings links, diagnostic logging
- CGEventTap listener and enigo injector work when both permissions are granted
- No code signing configured in `tauri.conf.json`

### Proposed Solution

Replace the current dual-permission approach with an Accessibility-only model:

1. **Keyboard Monitoring:** Replace `rdev`/CGEventTap with `NSEvent.addGlobalMonitorForEvents` (Cocoa) or `AXObserver`
   - Both only require Accessibility permission
   - Eliminates Input Monitoring entirely
   - Single permission matches Espanso's proven approach

2. **Text Injection:** Keep enigo (already uses Accessibility) or evaluate `CGEventCreateKeyboardEvent` as alternative

3. **Code Signing:** Configure Developer ID signing in `tauri.conf.json` to prevent macOS from silently revoking CGEventTap access (relevant until the refactor is complete)

### Files Likely Affected

- `src-tauri/src/macos_listener.rs` — replace rdev listener with NSEvent monitor
- `src-tauri/src/macos_accessibility.rs` — simplify to single permission check
- `src-tauri/src/text_injector.rs` — evaluate if enigo is still the right choice
- `src-tauri/src/lib.rs` — update listener initialization
- `src/components/SnippetManager.tsx` — simplify permission UI to single Accessibility check
- `tauri.conf.json` — add code signing config

### Acceptance Criteria

- [ ] Live expansion works on macOS with only Accessibility permission granted
- [ ] Input Monitoring is no longer required
- [ ] Permission UI shows a single clear status indicator
- [ ] App is code-signed to prevent silent permission revocation

---

## 2. File Watcher / Auto-Sync on Save

**Source:** `source-snippets-visibility-editing-toggles.md` §6, `boilerplate-config-generator.md` §8
**Priority:** Medium
**Complexity:** Medium

### Problem

When users edit expansion config files externally (in their editor), they must manually click "Sync" in Dispatch to pick up changes. This breaks the flow for users who prefer editing TOML/YAML directly.

### Proposed Solution

Add a file system watcher (`notify` crate on Rust side) that monitors registered source file paths and auto-syncs when changes are detected.

1. Watch all paths from `snippet_sources` table where `is_enabled = 1`
2. Debounce filesystem events (300ms) to avoid partial-write triggers
3. On change: re-parse the file, diff against existing snippets, sync changes
4. Emit a frontend event so the UI can show a subtle "auto-synced" indicator
5. Add a setting to enable/disable auto-sync (default: off)

### Files Likely Affected

- `src-tauri/src/file_watcher.rs` — new file, `notify`-based watcher
- `src-tauri/src/lib.rs` — initialize watcher on startup
- `src-tauri/src/commands.rs` — add `set_auto_sync`/`get_auto_sync` commands
- `src/components/YaptureSettings.tsx` — auto-sync toggle in Sources section

### Acceptance Criteria

- [ ] Editing a source file externally and saving triggers auto-sync within 500ms
- [ ] No double-sync on rapid saves (debounce works)
- [ ] Watcher restarts when sources are added/removed
- [ ] Can be disabled via settings

---

## 3. Emoji Pack Enhancements

**Source:** `emoji-pack-text-expansion.md` §15 Open Questions, §10 Performance
**Priority:** Medium
**Complexity:** Small–Medium per item

### 3.1 Colon-Prefix Search Boost

When a palette search query starts with `:`, boost emoji results to the top and filter out non-emoji snippets. This gives users a fast `:smile` → emoji workflow without emoji results diluting normal snippet searches.

**Files:** `src/components/ExpanderPalette.tsx`, `src/components/CommandPalette.tsx`

### 3.2 Hide Emoji Rows from Default List View

The emoji pack adds 3,500+ rows to the snippet list. When the user is not searching, emoji pack rows should be hidden by default (the source group already defaults to collapsed, but consider hiding entirely from the "All" view unless the user has an active search query or has selected the emoji source filter).

**Files:** `src/components/SnippetManager.tsx`

### 3.3 Aliases as Real Triggers

Evaluate whether common aliases (e.g., `:thumbsup:` → 👍, `:lol:` → 😂) should become actual snippet triggers in addition to the GitHub shortcode triggers. Currently aliases are search-only via tags.

**Decision needed:** Measure whether users attempt to type common aliases that don't match. If so, generate a second trigger entry for the top ~50 most-searched aliases.

### 3.4 Kaomoji / Text Faces Pack

Create a second built-in pack for text-based emoticons:

| Trigger | Body |
|---------|------|
| `:shrug:` | `¯\_(ツ)_/¯` |
| `:tableflip:` | `(╯°□°)╯︵ ┻━┻` |
| `:lenny:` | `( ͡° ͜ʖ ͡°)` |
| `:disapproval:` | `ಠ_ಠ` |

This would follow the same managed-source architecture as the emoji pack.

**Files:** `src-tauri/templates/kaomoji-pack.toml` (new), `src-tauri/src/kaomoji_pack.rs` (new), commands/frontend mirroring emoji pack

---

## 4. Snippet List UX Improvements

**Source:** `hotkey-packs-layout-fixes.md` §6, `source-snippets-visibility-editing-toggles.md` §2.4.3, `expander-v2-command-palette-sources.md` §9
**Priority:** Medium
**Complexity:** Small per item

### 4.1 Persistent Collapse State

Remember which source groups the user has expanded/collapsed across sessions. Currently collapse state resets on every mount.

**Implementation:** Store collapsed group IDs in a DB setting (`collapsed_source_groups` as JSON array). Read on mount, write on toggle.

**Files:** `src/components/SnippetManager.tsx`, `src-tauri/src/db.rs`

### 4.2 Tab-Cycling: Favorites → Recent → All

Add a tab bar or segmented control above the snippet list to switch between Favorites, Recent, and All views. Currently these are only accessible via separate commands/filters.

**Files:** `src/components/SnippetManager.tsx`

### 4.3 Right-Click Context Menu on Snippets

Add a context menu on snippet rows with actions:
- Copy trigger / Copy body
- Edit
- Toggle favorite
- Disable entire source (for source-owned snippets)
- Delete

**Files:** `src/components/SnippetManager.tsx`

### 4.4 Visual Indicators for Newly-Synced Snippets

After a source sync, briefly highlight or badge newly-added snippet rows so the user can see what changed.

**Files:** `src/components/SnippetManager.tsx`, `src-tauri/src/commands.rs` (return added snippet IDs from sync)

---

## 5. Cursor Positioning After Expansion

**Source:** `session-tracker-text-expander.md` §3.4.3
**Priority:** Low
**Complexity:** Large

### Problem

The `$|$` cursor marker in snippet bodies is currently stripped during expansion. The expanded text is pasted as a flat string with no cursor placement.

### Proposed Solution

For clipboard-based expansion (current model), this is inherently limited — the system clipboard doesn't carry cursor position metadata.

Possible approaches for future consideration:
1. **IDE plugin integration:** A VS Code / JetBrains extension that receives expansion events and places the cursor
2. **macOS Accessibility cursor control:** After pasting, use Accessibility APIs to move the cursor left by the number of characters after the `$|$` position
3. **AppleScript for specific apps:** Send arrow-key events to position the cursor in supported editors

This is a significant architectural addition and should only be pursued once the core expansion system is stable and well-adopted.

---

## 6. Yapture v2 Push Implementation

**Source:** `global-shortcuts-yapture-v2.md` Phase C
**Priority:** Low (blocked)
**Complexity:** Medium

### Status

Blocked on Yapture v2 API stabilization. The v2 connection flow (OAuth, token storage, status display) is fully implemented, but the actual `push_v2()` notification push function is a stub waiting for the v2 API to finalize its push endpoint.

### When Unblocked

1. Implement `push_v2()` in `src-tauri/src/yapture.rs` using the v2 push endpoint
2. Update the push dispatcher to route to v1 or v2 based on which connection is active
3. Test with the v2 staging environment

---

## 7. Boilerplate Generator — Minor Enhancements

**Source:** `boilerplate-config-generator.md` §2.2, §8
**Priority:** Low
**Complexity:** Small

### 7.1 Dedicated CTA in Text Expander Main View

Add a small "Create expansion config in any folder" row with a "New Config File" button directly in the `SnippetManager` main view, between the Live Expansion toggle and the snippet list. Currently the generator is accessible via the command palette and the Sources view — a visible CTA in the main view would improve discoverability for new users.

**Files:** `src/components/SnippetManager.tsx`

### 7.2 YAML Validation UI

Show parse errors inline when a source file has invalid YAML/TOML syntax, instead of silently skipping malformed entries during sync.

**Files:** `src-tauri/src/file_parser.rs` (return structured errors), `src/components/YaptureSettings.tsx` (display in editor)

### 7.3 Template Customization

Let users define their own boilerplate templates instead of always using the built-in one. Store custom templates in the managed expansions directory.

---

## 8. Architecture Improvements

**Priority:** Low
**Complexity:** Varies

### 8.1 Drag-and-Drop Reordering

Allow users to reorder snippets within a source group via drag-and-drop. Requires adding a `sort_order` column to the snippets table.

**Source:** `hotkey-packs-layout-fixes.md` §6

### 8.2 Pack-Level Bulk Actions

Add bulk operations on entire source packs: export, duplicate, delete all, re-sort.

**Source:** `hotkey-packs-layout-fixes.md` §6

### 8.3 Animated Collapse Transitions

Add smooth height animations when expanding/collapsing source groups in the snippet list. Currently the transition is instant.

**Source:** `hotkey-packs-layout-fixes.md` §6

---

## Priority Summary

| Priority | Item | Complexity |
|----------|------|------------|
| **High** | macOS Accessibility-only refactor (§1) | Large |
| **Medium** | File watcher / auto-sync (§2) | Medium |
| **Medium** | Emoji colon-prefix search boost (§3.1) | Small |
| **Medium** | Hide emoji from default list (§3.2) | Small |
| **Medium** | Persistent collapse state (§4.1) | Small |
| **Medium** | Tab-cycling Favorites/Recent/All (§4.2) | Small |
| **Medium** | Kaomoji pack (§3.4) | Medium |
| **Low** | Right-click context menu (§4.3) | Small |
| **Low** | New snippet visual indicators (§4.4) | Small |
| **Low** | Cursor positioning (§5) | Large |
| **Low** | Yapture v2 push (§6) | Medium (blocked) |
| **Low** | Boilerplate CTA (§7.1) | Small |
| **Low** | YAML validation UI (§7.2) | Medium |
| **Low** | Template customization (§7.3) | Medium |
| **Low** | Drag-and-drop reordering (§8.1) | Medium |
| **Low** | Pack-level bulk actions (§8.2) | Small |
| **Low** | Animated collapse transitions (§8.3) | Small |

---

## Archived Specs

The following specs have been fully implemented and moved to `specs/archive/`:

1. `hotkeys-telemetry.md` — In-app hotkeys, global toggle, auto-mark-read, telemetry
2. `session-tracker-text-expander.md` — Project sessions dashboard, text expander core
3. `batch-3-ux-enhancements.md` — CMD+N nav, command palette, chart tooltips, toast system, etc.
4. `batch-4-fixes-and-oauth.md` — Hotkey defaults, OAuth, tmux focus, banner fixes, permission overhaul
5. `boilerplate-config-generator.md` — Config generator discoverability, rich template, integration test
6. `expander-v2-command-palette-sources.md` — CMD+SHIFT+K palette, sources, recents, favorites
7. `expansion-editor-v2.md` — Live expansion sync fix, TOML migration, JSON preview, CodeMirror, vim mode
8. `global-shortcuts-yapture-v2.md` — CMD+SHIFT+K window focus, Yapture token persistence, v1+v2 support
9. `hotkey-packs-layout-fixes.md` — Hotkey parity, snippet source groups, CSS layout fix
10. `source-snippets-visibility-editing-toggles.md` — Source filtering, in-app editor, creation feedback, toggle sync
11. `emoji-pack-text-expansion.md` — Full Unicode emoji pack with install/update/uninstall lifecycle
