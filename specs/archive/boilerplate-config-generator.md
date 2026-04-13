# Spec: Boilerplate Config Generator — Discoverability, Parsing & Variable Integration

## Status: Draft
## Branch: `spec/boilerplate-config-generator`
## Depends on: `impl/expander-v2-command-palette-sources`

---

## 1. Problem Statement

The boilerplate config generator (`create_boilerplate_config`) exists in the backend and has two UI entry points — both buried in the SnippetManager's "Sources" sub-view. Users cannot discover it because:

1. The "New Config" button in the bottom bar competes with Import/Export and is easy to miss
2. The "New Config File" button in SourcesView is 2 navigation levels deep (Text Expander > Sources > New Config File)
3. It's not available from the command palette at all
4. The generated boilerplate YAML template is minimal (single snippet, no variables, no comments explaining variable types)
5. After generation, there's no clear "what now?" — users don't know the config was auto-synced or how to edit it

### What we want

A boilerplate generator that is:
- **Discoverable** from 3 places: command palette, dedicated button in the Text Expander screen, and Sources view
- **Educational** — the generated YAML is a rich, commented template demonstrating all 7 variable types
- **Verified** — a round-trip test ensures the generated YAML parses cleanly into the snippet DB with variables intact
- **Feedback-rich** — users see a confirmation with next steps after generation

---

## 2. UI Entry Points

### 2.1 Command Palette Action

Add a new command to the `COMMANDS` array in `CommandPalette.tsx`:

```ts
{ label: "Create New Expansion Config", action: "new_config", category: "Actions" },
```

In `App.tsx` `handleCommandPaletteAction`:
```ts
case "new_config": handleNewConfig(); break;
```

Where `handleNewConfig()`:
1. Opens the native directory picker (`@tauri-apps/plugin-dialog`)
2. Prompts for a package name (defaults to folder name)
3. Calls `createBoilerplateConfig(path, name)` backend command
4. Shows success toast: `"Created dispatch-snippets.yml in {path} — synced {n} snippets"`
5. Navigates to Text Expander screen (`setActiveScreen("expander")`)

### 2.2 Dedicated Button in Text Expander (Live Expansion Section)

Add a "New Config" button directly below the Live Expansion toggle section in `SnippetManager.tsx`, visible on the main snippet list view. This should be a subtle but clear call-to-action:

```
┌─────────────────────────────────────────────────┐
│  < Back    [Search snippets...]            [+]  │
├─────────────────────────────────────────────────┤
│  Live Expansion                           [ON]  │
│  ✓ Accessibility — Keyboard listener + ...      │
│  ✓ Keyboard listener — active                   │
│  Listening — 5 triggers loaded — 0 events       │
├─────────────────────────────────────────────────┤
│  📄 Create expansion config in any folder       │
│                               [New Config File] │
├─────────────────────────────────────────────────┤
│  ☆  :shrug   Shrug emoji           Defaults     │
│  ☆  :date    Current date          Defaults     │
│  ...                                            │
```

Implementation: Add a small banner/row between the `LiveExpansionToggle` and the snippet list:

```tsx
{/* New Config CTA */}
<div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle">
  <span className="text-[11px] text-text-secondary">
    Create expansion config in any folder
  </span>
  <button
    onClick={handleNewConfig}
    className="text-[11px] text-accent hover:text-accent-hover transition-colors px-2.5 py-1 rounded-md border border-accent/30 hover:border-accent/50"
  >
    New Config File
  </button>
</div>
```

### 2.3 Sources View (Existing — No Change)

Keep the existing "New Config File" button in `SourcesView` as-is. It remains the primary place for power users managing multiple sources.

### 2.4 Remove from Bottom Bar

Remove the "New Config" button from the bottom bar (alongside Import/Export) since it's now more prominently placed above the snippet list AND in the command palette. The bottom bar returns to just Import, Export, Sources.

---

## 3. Rich Boilerplate Template

### 3.1 Current State

The current template generates a minimal YAML:

```yaml
name: "{name}"
snippets:
  - trigger: ":example"
    label: "Example snippet"
    body: "Hello from {name}!"
```

This gives users no guidance on variables, tags, or the full schema.

### 3.2 New Template

Replace with a comprehensive, commented template that demonstrates all variable types:

```yaml
# Dispatch Expansion Config
# Package: {name}
#
# This file defines text expansion snippets for Dispatch.
# Edit this file and snippets will auto-sync when you click "Sync" in Dispatch,
# or when auto-reload is enabled for this source.
#
# Trigger syntax: type your trigger text (e.g. ":hello") and Dispatch
# will expand it to the body text. Use {{variable_name}} for dynamic values.
#
# Variable types:
#   echo      — static text value
#   date      — current date/time with strftime formatting
#   clipboard — paste from clipboard
#   shell     — run a shell command, insert stdout
#   form      — prompt user for text input at expansion time
#   choice    — prompt user to pick from a list
#   random    — pick a random value from a list

name: "{name}"

snippets:
  # ── Basic snippet (no variables) ────────────────────────
  - trigger: ":hello"
    label: "Greeting"
    body: "Hello from {name}!"
    tags: [greeting, example]

  # ── Date variable ───────────────────────────────────────
  - trigger: ":today"
    label: "Today's date"
    body: "{{today}}"
    tags: [date, utility]
    variables:
      - name: today
        type: date
        params:
          format: "%Y-%m-%d"

  # ── Shell command ───────────────────────────────────────
  - trigger: ":branch"
    label: "Current git branch"
    body: "{{branch}}"
    tags: [git, dev]
    variables:
      - name: branch
        type: shell
        params:
          cmd: "git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'not a repo'"

  # ── Form input (prompted at expansion time) ─────────────
  - trigger: ":ticket"
    label: "Ticket reference"
    body: "[{{id}}] {{title}}"
    tags: [workflow]
    variables:
      - name: id
        type: form
        params:
          label: "Ticket ID"
          default: "PROJ-"
      - name: title
        type: form
        params:
          label: "Title"

  # ── Choice dropdown ─────────────────────────────────────
  - trigger: ":status"
    label: "Status update"
    body: "Status: {{status}} — {{note}}"
    tags: [workflow]
    variables:
      - name: status
        type: choice
        params:
          label: "Pick status"
          values:
            - In Progress
            - Blocked
            - Done
            - Needs Review
      - name: note
        type: form
        params:
          label: "Optional note"

  # ── Clipboard + echo ────────────────────────────────────
  - trigger: ":link"
    label: "Markdown link from clipboard"
    body: "[{{label}}]({{url}})"
    tags: [markdown, utility]
    variables:
      - name: url
        type: clipboard
      - name: label
        type: form
        params:
          label: "Link text"
          default: "link"
```

### 3.3 Backend Change

In `commands.rs`, replace the `template` string in `create_boilerplate_config` with the new template above. The `{name}` placeholders use Rust's `format!()` macro (already the case).

---

## 4. Parsing Verification

### 4.1 Round-Trip Guarantee

The generated YAML must parse cleanly through the existing `file_parser.rs` pipeline. This is already the case since the `create_boilerplate_config` command calls `sync_source_internal` after writing the file. However, there is no explicit verification or user-facing feedback about what was synced.

### 4.2 Post-Generation Sync Feedback

After `create_boilerplate_config` succeeds, the command already returns a `SnippetSource`. The frontend should use the returned source ID to immediately sync and report results:

```ts
// In handleNewConfig:
const source = await createBoilerplateConfig(path, name);
const result = await syncSnippetSource(source.id);
showToast(`Created config with ${result.added} snippets in ${path}`);
```

This confirms to the user that:
1. The file was written
2. It parsed successfully
3. N snippets are now available for expansion

### 4.3 Variable Integrity

The parser (`file_parser.rs`) already handles all variable types correctly:
- `ParsedVariable` deserializes `name`, `type`, and `params` (HashMap<String, serde_json::Value>)
- `variables_to_json()` converts to the JSON format expected by the `snippets` table
- `expander.rs` resolves each type at expansion time (`echo`, `date`, `clipboard`, `shell`, `form`, `choice`, `random`)

No changes needed to the parser or expander — they already handle the full schema.

### 4.4 Add Integration Test

Add a Rust test in `file_parser.rs` that verifies the boilerplate template parses correctly:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boilerplate_template_parses() {
        let template = include_str!("../templates/dispatch-snippets.yml");
        let config: ExpansionConfig = serde_yaml::from_str(template)
            .expect("Boilerplate template must parse");
        assert!(config.snippets.len() >= 5, "Template should have multiple example snippets");

        // Verify each snippet has required fields
        for snippet in &config.snippets {
            assert!(!snippet.trigger.is_empty(), "Trigger must not be empty");
            assert!(!snippet.body.is_empty(), "Body must not be empty");
        }

        // Verify variable types are represented
        let var_types: Vec<&str> = config.snippets.iter()
            .flat_map(|s| s.variables.iter().map(|v| v.var_type.as_str()))
            .collect();
        assert!(var_types.contains(&"date"), "Should have date variable");
        assert!(var_types.contains(&"shell"), "Should have shell variable");
        assert!(var_types.contains(&"form"), "Should have form variable");
        assert!(var_types.contains(&"choice"), "Should have choice variable");
        assert!(var_types.contains(&"clipboard"), "Should have clipboard variable");
    }
}
```

To support `include_str!`, extract the template YAML into a separate file at `src-tauri/templates/dispatch-snippets.yml`. The `create_boilerplate_config` command reads from this file instead of an inline string, ensuring the template that's tested is the same one that's generated.

---

## 5. Implementation Phases

### Phase 1: Rich Template + Test (Backend)

Files changed:
- **`src-tauri/templates/dispatch-snippets.yml`** — new file, the YAML template
- **`src-tauri/src/commands.rs`** — `create_boilerplate_config` reads template from file, uses `include_str!` or `format!` with the template
- **`src-tauri/src/file_parser.rs`** — add `#[cfg(test)]` round-trip test

Verify: `cargo test` passes, template parses with all variable types intact.

### Phase 2: Command Palette Integration (Frontend)

Files changed:
- **`src/components/CommandPalette.tsx`** — add `"Create New Expansion Config"` to COMMANDS
- **`src/App.tsx`** — handle `"new_config"` action in `handleCommandPaletteAction`, lift `handleNewConfig` to App level (currently duplicated in SnippetManager)

Verify: Open command palette, type "config" or "new", see the action, select it, directory picker opens.

### Phase 3: Dedicated Button in Text Expander (Frontend)

Files changed:
- **`src/components/SnippetManager.tsx`**:
  - Add "New Config File" CTA row between LiveExpansionToggle and snippet list
  - Remove "New Config" from the bottom bar (revert to just Import/Export/Sources)
  - Update `handleNewConfig` to sync + show detailed toast

Verify: Navigate to Text Expander, see "Create expansion config in any folder" row with button, click it, picker opens, toast shows snippet count.

### Phase 4: Sync Feedback Enhancement (Frontend)

Files changed:
- **`src/components/SnippetManager.tsx`** — after `createBoilerplateConfig`, call `syncSnippetSource(source.id)` and display count in toast
- **`src/App.tsx`** — same for the command palette handler

Verify: After creating a config, toast says "Created config with 6 snippets in /path/to/folder".

---

## 6. File-Level Change Summary

| File | Change |
|------|--------|
| `src-tauri/templates/dispatch-snippets.yml` | **New** — rich YAML template with all variable types |
| `src-tauri/src/commands.rs` | Read template from file, `include_str!` with `{name}` substitution |
| `src-tauri/src/file_parser.rs` | Add round-trip parse test for template |
| `src/components/CommandPalette.tsx` | Add `"Create New Expansion Config"` command |
| `src/App.tsx` | Handle `"new_config"` action, lift `handleNewConfig` to App |
| `src/components/SnippetManager.tsx` | Add CTA row below LiveExpansionToggle, remove "New Config" from bottom bar, enhance sync toast |

---

## 7. UX Flow

### Command Palette Path
```
CMD+K  →  type "config"  →  "Create New Expansion Config"  →  folder picker  →  package name prompt  →  toast: "Created config with 6 snippets in ~/Code/myproject"
```

### Text Expander Path
```
Click <> icon  →  see "Create expansion config in any folder [New Config File]"  →  click button  →  folder picker  →  package name prompt  →  toast + snippet list refreshes
```

### Sources Path (existing, unchanged)
```
Click <> icon  →  bottom bar "Sources"  →  "New Config File"  →  same flow
```

---

## 8. Out of Scope

- **File watcher / auto-sync on save** — currently manual "Sync" button; a file watcher would be a separate spec
- **YAML validation UI** — showing parse errors inline; currently silent skip in parser
- **In-app YAML editor** — editing the config file within Dispatch; users edit externally
- **Template customization** — letting users define their own boilerplate templates
