# Spec: Expansion Editor V2

## Overview

Six issues to address in the Expansion Sources editor and underlying pipeline:
1. Saving a source file doesn't reflect in live expansion
2. Migrate config format from YAML to TOML
3. Add JSON preview alongside the TOML editor
4. Add copy-to-clipboard for editor content
5. Syntax highlighting in the editor
6. Vim keybinding support with mode toggle

---

## 1. Fix: Saved source changes not reflecting in live expansion

### Root Cause

The save pipeline (`write_source_file` → `sync_source_internal` → `refresh_trigger_cache`) is correct — it DOES refresh the trigger cache after saving. The actual issue is that **snippets with interactive variables (`form` or `choice`) are excluded from live expansion**.

In `trigger_cache.rs:58`:
```rust
if !entry.has_interactive_vars && buffer.ends_with(&entry.trigger) {
```

The default `:date` snippet has a `date`-type variable (non-interactive), so it SHOULD match. However, the `VariableDef` deserialization may be failing silently, causing `has_interactive_vars` to evaluate incorrectly.

### Investigation Steps

Check `models.rs` for the `VariableDef` struct — specifically whether the `type` field uses `#[serde(rename = "type")]` correctly. The variables JSON stored in DB uses `"type"` as the key (from `file_parser.rs` line 83: `"type": v.var_type`), but if `VariableDef` expects a different field name, `serde_json::from_str` would fail → `unwrap_or(false)` → all snippets pass through. That would mean `:date` IS in the cache and SHOULD match.

### More Likely Cause

The live expansion listener in `macos_listener.rs` has a **hardcoded prefix check** on line 90:
```rust
if !buf.contains(':') {
    return;
}
```

This should work for triggers starting with `:`, but there may be a timing/buffer issue. Additionally, the `ensure_default_source` command creates the source and syncs, but the sync happens outside the expansion handler's awareness if the trigger cache reference differs.

### Fix

Add **diagnostic logging** to narrow the issue:

1. **`trigger_cache.rs`**: After `refresh_trigger_cache`, log the count and first few triggers:
   ```rust
   eprintln!("[trigger-cache] refreshed: {} entries, first 5: {:?}",
       entries.len(),
       entries.iter().take(5).map(|e| &e.trigger).collect::<Vec<_>>());
   ```

2. **`macos_listener.rs`**: Log when a match is attempted but fails:
   ```rust
   eprintln!("[listener] buffer='{}', cache_size={}", buf, state.cache.read().len());
   ```

3. **Verify the trigger cache is shared**: Confirm that `ensure_default_source` and the listener both reference the same `Arc<RwLock<Vec<TriggerEntry>>>` from `AppState`. This should be the case since `state.trigger_cache` is used everywhere, but verify.

4. **Add a frontend toast** after save confirming the trigger cache state — call a new `get_trigger_cache_count` command that returns the cache size, and show "Saved — N triggers loaded" to give the user confidence.

### Files

| File | Change |
|------|--------|
| `src-tauri/src/trigger_cache.rs` | Add diagnostic logging to `refresh_trigger_cache` |
| `src-tauri/src/macos_listener.rs` | Add diagnostic logging to match path |
| `src-tauri/src/commands.rs` | Add `get_trigger_cache_count` command |
| `src/components/YaptureSettings.tsx` | Show trigger count in save toast |

---

## 2. Migrate config format from YAML to TOML

### Rationale

TOML is simpler for key-value config, has less footgun-prone whitespace rules, and is the standard for Rust projects (Cargo.toml). Users editing expansion configs benefit from a flatter, more readable format.

### TOML Schema

Current YAML:
```yaml
name: "Defaults"
snippets:
  - trigger: ":date"
    label: "Today's date"
    body: "{{date}}"
    tags: [utility, date]
    variables:
      - name: date
        type: date
        params:
          format: "%Y-%m-%d"
```

Equivalent TOML:
```toml
name = "Defaults"

[[snippets]]
trigger = ":date"
label = "Today's date"
body = "{{date}}"
tags = ["utility", "date"]

  [[snippets.variables]]
  name = "date"
  type = "date"

    [snippets.variables.params]
    format = "%Y-%m-%d"
```

### Changes

#### Backend

1. **`Cargo.toml`**: Add `toml = "0.8"` dependency (keep `serde_yaml` temporarily for migration)
2. **`file_parser.rs`**:
   - Add `parse_expansion_file_toml(path) → Result<ExpansionConfig>` using `toml::from_str`
   - Update `parse_expansion_file` to detect format by extension: `.toml` → TOML parser, `.yml`/`.yaml` → YAML parser (backward compat)
   - Update `parse_expansion_folder` to also match `.toml` extension
3. **`commands.rs`**:
   - `write_source_file`: Validate with `toml::from_str` for `.toml` files, `serde_yaml::from_str` for `.yml`/`.yaml`
   - `create_boilerplate_config`: Write `.toml` instead of `.yml` (change output filename to `dispatch-snippets.toml`)
4. **Templates**:
   - Convert `dispatch-defaults.yml` → `dispatch-defaults.toml`
   - Convert `dispatch-snippets.yml` → `dispatch-snippets.toml` (boilerplate template)
   - Update `BOILERPLATE_TEMPLATE` and `DEFAULTS_TEMPLATE` constants to point to new files
5. **`ensure_default_source`**: Change default filename to `dispatch-defaults.toml`

#### Migration

- Keep YAML parsing as fallback — existing users with `.yml` files still work
- New files created by the app use `.toml`
- No migration command needed; both formats coexist

#### Frontend

- No structural changes — the editor is already format-agnostic (textarea editing raw text)
- Update placeholder text / labels from "YAML" to "TOML" where mentioned

### Files

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `toml = "0.8"` |
| `src-tauri/src/file_parser.rs` | Add TOML parser, auto-detect by extension |
| `src-tauri/src/commands.rs` | Update validation + boilerplate to use TOML |
| `src-tauri/templates/dispatch-defaults.toml` | New TOML default template |
| `src-tauri/templates/dispatch-snippets.toml` | New TOML boilerplate template |

---

## 3. JSON Preview alongside TOML editor

### Design

Add a toggle in the `SourceFileEditor` header: **TOML** | **JSON** (two small tab buttons). Default is TOML (editable). JSON is read-only, derived live from the TOML content.

### Implementation

#### Frontend (`YaptureSettings.tsx` — `SourceFileEditor`)

1. Add `editorMode` state: `"toml" | "json"` (default: `"toml"`)
2. Add a `jsonPreview` derived value using a TOML-to-JSON converter
3. For TOML→JSON conversion in the browser: use the `smol-toml` npm package (tiny, zero-dep TOML parser) or `@iarna/toml`
4. When `editorMode === "json"`:
   - Show the JSON content in the editor (read-only)
   - Grey out the Save button
   - Show a "(read-only)" label
5. Toggle buttons sit in the editor header bar next to the source name

#### Package

- `bun add smol-toml` — lightweight TOML parser/serializer (~5KB)

#### Conversion Logic

```typescript
import { parse as parseTOML } from "smol-toml";

function tomlToJson(toml: string): string {
  try {
    const obj = parseTOML(toml);
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    return `// Parse error: ${e}`;
  }
}
```

### Files

| File | Change |
|------|--------|
| `package.json` | Add `smol-toml` |
| `src/components/YaptureSettings.tsx` | Add TOML/JSON toggle + JSON preview in `SourceFileEditor` |

---

## 4. Copy-to-clipboard icon in editor

### Design

Add a copy icon button in the `SourceFileEditor` header bar (next to the Save button). Copies the current editor content (TOML or JSON depending on active mode) to clipboard.

### Implementation

In `SourceFileEditor`, add a button before the Save button:

```tsx
<button
  onClick={async () => {
    const text = editorMode === "json" ? jsonPreview : content;
    await copyToClipboard(text);
    showToast("Copied to clipboard");
  }}
  className="p-1.5 text-text-tertiary hover:text-accent transition-colors rounded-md"
  title="Copy to clipboard"
>
  <CopyIcon />
</button>
```

The `copyToClipboard` function is already imported in `YaptureSettings.tsx`.

### Files

| File | Change |
|------|--------|
| `src/components/YaptureSettings.tsx` | Add copy button to `SourceFileEditor` header |

---

## 5. Syntax highlighting

### Approach

Replace the plain `<textarea>` with **CodeMirror 6** (`@codemirror/view`). CodeMirror 6 is modular, lightweight, and has built-in language support for TOML and JSON.

### Packages

```
bun add @codemirror/view @codemirror/state @codemirror/language @codemirror/lang-json codemirror @codemirror/theme-one-dark
bun add @codemirror/legacy-modes   # includes TOML StreamLanguage mode
```

Note: TOML doesn't have a first-class CodeMirror 6 language package. Use `@codemirror/legacy-modes` which provides a TOML StreamLanguage via `StreamLanguage.define(toml)`, or use the `codemirror-lang-toml` community package if available.

### Implementation

#### New Component: `CodeEditor.tsx`

Create `src/components/CodeEditor.tsx` — a reusable wrapper:

```tsx
interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: "toml" | "json";
  readOnly?: boolean;
}
```

Internally:
- Create an `EditorView` in a `useEffect`
- Apply dark theme (`oneDark` or custom theme matching the app's design tokens)
- Set language extension based on `language` prop
- Wire `onChange` via `EditorView.updateListener`
- Handle `readOnly` via `EditorState.readOnly` facet

#### Integration in `SourceFileEditor`

Replace the `<textarea>` with:
```tsx
<CodeEditor
  value={editorMode === "json" ? jsonPreview : content}
  onChange={editorMode === "toml" ? (val) => { setContent(val); setDirty(true); } : undefined}
  language={editorMode}
  readOnly={editorMode === "json"}
/>
```

### Files

| File | Change |
|------|--------|
| `package.json` | Add CodeMirror 6 packages |
| `src/components/CodeEditor.tsx` | New reusable CodeMirror wrapper |
| `src/components/YaptureSettings.tsx` | Replace `<textarea>` with `<CodeEditor>` |

---

## 6. Vim keybinding support

### Approach

CodeMirror 6 has an official vim extension: `@replit/codemirror-vim`. This provides full vim emulation including normal/insert/visual modes, motions, operators, marks, registers, `:` commands, and macros.

### Package

```
bun add @replit/codemirror-vim
```

### Implementation

#### Vim Toggle

Add a `vimEnabled` state persisted in the app's `settings` table (key: `"editor_vim_mode"`, value: `"0"` or `"1"`).

**Backend**: Use existing `get_setting`/`set_setting` — no new commands needed. Add two frontend API wrappers:
```typescript
async function getEditorVimMode(): Promise<boolean>
async function setEditorVimMode(enabled: boolean): Promise<void>
```

Alternatively, store in `localStorage` to avoid backend roundtrip (simpler, but doesn't persist across reinstalls). Recommendation: **use localStorage** since this is a purely UI preference.

#### CodeEditor Changes

1. Add `vim?: boolean` prop to `CodeEditor`
2. Conditionally include the vim extension:
   ```typescript
   import { vim } from "@replit/codemirror-vim";
   // In extensions array:
   ...(vimEnabled ? [vim()] : [])
   ```

#### ESC Key Handling

**Critical**: The app currently uses ESC for various UI actions (close modals, clear selection). When vim mode is active in the editor, ESC must be captured by CodeMirror to switch from insert → normal mode, NOT bubble up to the app.

Implementation:
- CodeMirror's vim extension already captures ESC internally
- Add `e.stopPropagation()` handling: CodeMirror's DOM is inside the settings panel, so ESC events from the editor won't reach app-level handlers if CodeMirror consumes them (which it does by default with the vim extension)
- **Test**: Verify that pressing ESC in insert mode switches to normal mode without closing the settings panel

#### Vim Mode Indicator

Show the current vim mode (NORMAL / INSERT / VISUAL) in the editor status bar. The `@replit/codemirror-vim` extension provides a `vim()` return that includes mode change callbacks.

Add a status element below the editor:
```
NORMAL | line 12, col 5        /path/to/file.toml        Modified
```

#### Visual Mode Multi-line Edits

The `@replit/codemirror-vim` extension supports visual mode (`v`), visual line mode (`V`), and visual block mode (`Ctrl+V`) out of the box. Operations like `d`, `y`, `c`, `>`, `<` work on visual selections.

No custom implementation needed — the library handles this.

#### Toggle UI

Add a small toggle in the `SourceFileEditor` header bar:

```tsx
<button
  onClick={() => setVimEnabled(!vimEnabled)}
  className={`text-[10px] px-2 py-0.5 rounded-md border transition-colors ${
    vimEnabled
      ? "bg-accent/15 text-accent border-accent/30"
      : "bg-surface-overlay text-text-tertiary border-border-subtle"
  }`}
>
  Vim
</button>
```

### Files

| File | Change |
|------|--------|
| `package.json` | Add `@replit/codemirror-vim` |
| `src/components/CodeEditor.tsx` | Add `vim` prop, conditional vim extension, mode indicator |
| `src/components/YaptureSettings.tsx` | Add vim toggle button, persist preference in localStorage |

---

## Dependency Summary

```
bun add smol-toml @codemirror/view @codemirror/state @codemirror/language @codemirror/lang-json @codemirror/legacy-modes @codemirror/theme-one-dark @replit/codemirror-vim codemirror
```

Rust: add `toml = "0.8"` to `src-tauri/Cargo.toml`

---

## Implementation Order

1. **Issue 1** (fix expansion) — diagnose + fix first since it's a functional bug
2. **Issue 2** (YAML → TOML) — backend format migration
3. **Issue 5** (syntax highlighting) — install CodeMirror, create `CodeEditor.tsx`
4. **Issue 6** (vim support) — add vim extension to `CodeEditor`
5. **Issue 3** (JSON preview) — add TOML/JSON toggle using `smol-toml`
6. **Issue 4** (copy button) — trivial UI addition

Issues 3-6 all touch the same `SourceFileEditor` component and can be done in a single pass after the CodeMirror foundation (issue 5) is in place.

---

## Verification

1. Open Settings → Expansion Sources → edit Defaults → change `:date` body → Save → type `:date` anywhere → verify expansion matches saved content
2. New Config File creates a `.toml` file; existing `.yml` sources still parse
3. Toggle TOML/JSON in editor — JSON shows correct structure, is read-only
4. Copy button copies current view (TOML or JSON) to clipboard
5. Editor shows syntax colors for TOML keys, strings, arrays, comments; JSON keys, strings, numbers
6. Click "Vim" toggle → type `i` to enter insert mode → edit text → ESC → back to normal mode → `dd` deletes line → `u` undoes → `V` enters visual line mode → select multiple lines → `d` deletes them → settings panel does NOT close on ESC
