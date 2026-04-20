# Spec: Emoji Pack for Text Expansion

## Status: Draft
## Branch: `spec/emoji-pack-text-expansion`
## Depends on: `impl/expander-v2-command-palette-sources`

---

## 1. Overview

Add a new built-in, installable **Emoji Pack** for Dispatch Text Expander so users can type and insert emojis quickly from either:

1. **Live expansion** by typing a short trigger such as `:smile:`
2. **The command palette / expander flow** by searching for an emoji by name, alias, or category

The pack should feel comprehensive enough that users can rely on Dispatch as their primary emoji entry workflow instead of memorizing OS pickers or maintaining a hand-written emoji YAML file.

This is **not** a one-off handful of defaults. It is a first-class source pack with:

- thousands of generated snippets
- stable trigger naming rules
- aliases for common words
- install / uninstall / update flows
- pack-aware UX in the Text Expander screen

The implementation should fit the existing architecture:

- emoji entries are stored as regular snippets
- the pack is represented as a managed `snippet_source`
- Unicode emoji glyphs remain plain snippet bodies
- live expansion keeps using suffix trigger matching from `trigger_cache.rs`

---

## 2. Goals

### 2.1 Primary Goal

Let users type essentially any common emoji quickly using memorable text triggers.

### 2.2 Product Goals

1. **Coverage**: include the full modern emoji set users reasonably expect, not just smileys
2. **Memorability**: triggers should follow familiar `:shortcode:` conventions
3. **Discoverability**: users should be able to browse/search emojis visually inside Dispatch
4. **Low friction**: installing the pack should be one click
5. **Safety**: generated content should be deterministic and updateable without corrupting user snippets
6. **Performance**: thousands of emoji snippets must not noticeably degrade load time or trigger matching

### 2.3 Non-Goals

1. Building a custom emoji renderer or emoji picker outside the existing expander surfaces
2. Replacing macOS system emoji search globally
3. Supporting arbitrary user-defined aliases inside the built-in dataset in v1
4. Handling skin-tone/gender composition with dynamic runtime logic in v1 if static generated triggers are sufficient

---

## 3. Why This Fits the Current Architecture

Dispatch already has the right primitives:

- `snippet_sources` can represent external or generated packs
- snippets already support Unicode bodies
- `trigger_cache.rs` matches plain string triggers and sorts by longest trigger first
- the Snippet Manager already groups rows by source/pack

That means the emoji feature should be implemented as a **generated snippet pack**, not as custom matcher logic.

This keeps the system coherent:

- import/export remains consistent
- favorites/recents keep working automatically
- live expansion needs no emoji-specific branch
- command palette search can reuse the snippet index

---

## 4. User Experience

### 4.1 Installation

In the Text Expander screen, users should see a built-in pack card:

```text
Emoji Pack
Type emojis with :shortcodes: and search by name
[Install Pack]
```

Install behavior:

1. User clicks `Install Pack`
2. Dispatch generates or copies the emoji source file into its managed expansions directory
3. Dispatch creates a `snippet_source` row for the pack if one does not already exist
4. Dispatch syncs the source into the snippets table
5. A toast confirms installation and reports the number of imported emoji snippets

Example toast:

```text
Installed Emoji Pack — 3,782 emoji snippets available
```

### 4.2 Everyday Use: Live Expansion

Examples:

- typing `:smile:` expands to `😄`
- typing `:thumbs_up:` expands to `👍`
- typing `:rocket:` expands to `🚀`
- typing `:flag_us:` expands to `🇺🇸`

The live expansion path should behave exactly like any other snippet source.

### 4.3 Everyday Use: Palette Search

The command palette / expander view should support searching emojis by:

- trigger: `:shrug:`
- canonical name: `grinning face`
- common alias: `lol`, `happy`, `thumbsup`
- category: `animals`, `food`, `flags`

Search results should visibly preview the emoji glyph first:

```text
😄  :smile:       Smiling face with open mouth
🚀  :rocket:      Rocket
🇺🇸  :flag_us:    Flag: United States
```

### 4.4 Pack Management

Once installed, users should be able to:

- enable/disable the entire pack
- sync/update the pack
- uninstall the pack
- see pack metadata such as emoji count and source version

Uninstalling the pack should only remove snippets belonging to that source. It must not touch user-created snippets.

---

## 5. Trigger Design

### 5.1 Trigger Format

Use a GitHub/Slack-style shortcode shape:

```text
:short_name:
```

Reasons:

1. Familiar to most users
2. Works with the existing suffix matcher
3. Avoids ambiguity with normal prose
4. Keeps emoji triggers visually distinct from regular snippets

### 5.2 Canonicalization Rules

Generate canonical triggers from emoji names using these rules:

1. Lowercase all names
2. Replace spaces and hyphens with underscores
3. Remove commas, apostrophes, and other punctuation not needed for readability
4. Prefix and suffix with `:`
5. Keep region codes concise for flags
6. Keep family / gender / skin-tone variants explicit rather than magical

Examples:

| Emoji | Name | Trigger |
|------|------|---------|
| 😄 | Smiling Face With Open Mouth | `:smiling_face_with_open_mouth:` |
| 😄 | Preferred alias | `:smile:` |
| 👍 | Thumbs Up | `:thumbs_up:` |
| 👍🏻 | Thumbs Up: Light Skin Tone | `:thumbs_up_light_skin_tone:` |
| 🇺🇸 | Flag: United States | `:flag_us:` |
| ❤️ | Red Heart | `:red_heart:` |

### 5.3 Canonical vs Friendly Triggers

The pack should not expose only verbose CLDR-style names. Users need short, practical triggers.

Each emoji should have:

1. **One canonical trigger** used as the actual snippet trigger
2. **Zero or more aliases** stored as searchable metadata

For v1, Dispatch should avoid creating multiple duplicate snippets pointing to the same emoji unless that materially improves live expansion. Search aliases are cheaper than trigger aliases.

Recommended rule:

- pick the shortest high-confidence familiar trigger as the real `trigger`
- store all other names/aliases in tags or dedicated metadata for search

Examples:

| Emoji | Real trigger | Search aliases |
|------|--------------|----------------|
| 😄 | `:smile:` | `smiling_face_with_open_mouth`, `happy`, `grinning` |
| 👍 | `:thumbs_up:` | `thumbsup`, `like`, `approve` |
| 😂 | `:joy:` | `laughing`, `tears_of_joy`, `lol` |

### 5.4 Collision Rules

Emoji triggers can collide with existing defaults or user snippets.

Required behavior:

1. User snippets always win over built-in/generated pack snippets
2. A sync conflict must be reported, not silently overwrite a user snippet
3. The pack sync summary should report skipped collisions

Example:

```text
Emoji Pack synced — 3,768 added, 14 skipped (trigger conflicts)
```

To support this, source sync should treat generated emoji snippets like any other source import and preserve existing non-source-owned rows.

---

## 6. Data Source

### 6.1 Source of Truth

The emoji dataset should be generated from a checked-in source file, not manually curated entry by entry inside Rust code.

Recommended source strategy:

1. Commit a machine-readable emoji dataset under `src-tauri/templates/` or `src-tauri/resources/`
2. Generate the actual pack YAML/TOML from that dataset
3. Check in the generated output or generate it during a backend command

The source data should include:

- emoji glyph
- official name
- short name / preferred shortcode
- aliases
- category/group
- optional keywords
- optional sort order
- optional version metadata

### 6.2 Format

A JSON file is the easiest source of truth:

```json
{
  "version": "emoji-15.1",
  "items": [
    {
      "emoji": "😄",
      "name": "Smiling Face With Open Mouth",
      "trigger": ":smile:",
      "aliases": ["smiling_face_with_open_mouth", "happy", "grinning"],
      "category": "Smileys & Emotion",
      "keywords": ["face", "happy", "joy"]
    }
  ]
}
```

The generated snippet source file can remain YAML so it matches the rest of the source-pack workflow.

### 6.3 Managed Source Output

Dispatch should generate a managed file in its expansions directory, for example:

```text
~/.config/dispatch/expansions/emoji-pack.yml
```

Example generated snippet:

```yaml
name: "Emoji Pack"

snippets:
  - trigger: ":smile:"
    label: "😄 Smiling Face With Open Mouth"
    body: "😄"
    tags:
      - emoji
      - smileys_emotion
      - happy
      - grinning
      - smiling_face_with_open_mouth
```

This works with the current parser because tags are already supported and the body is just Unicode text.

---

## 7. Data Model Changes

### 7.1 Source Type

Today snippets may have `source_type = "file"` or default/builtin semantics. Add a dedicated managed source type:

```text
source_type = "managed"
```

For the emoji pack, that makes it easier to distinguish:

- user-authored snippets
- file-imported snippets
- Dispatch-generated packs

If introducing a new `source_type` is more expensive than useful, reuse `"file"` in v1 and store metadata on the source row instead. But a managed type is preferable for clarity.

### 7.2 Snippet Source Metadata

The current `snippet_sources` table does not store pack metadata. Add optional columns:

```sql
ALTER TABLE snippet_sources ADD COLUMN source_kind TEXT;
ALTER TABLE snippet_sources ADD COLUMN source_version TEXT;
ALTER TABLE snippet_sources ADD COLUMN item_count INTEGER;
ALTER TABLE snippet_sources ADD COLUMN managed_key TEXT;
```

Recommended values for Emoji Pack:

| Column | Value |
|------|------|
| `source_kind` | `emoji_pack` |
| `source_version` | `emoji-15.1` |
| `item_count` | generated snippet count |
| `managed_key` | `builtin:emoji-pack` |

This lets the UI show update/install state cleanly and prevents duplicate installs of the same built-in pack.

### 7.3 Search Metadata

For v1, aliases and categories can live in `tags`. That avoids a schema change.

Example tags payload:

```json
["emoji","smileys_emotion","happy","grinning","smiling_face_with_open_mouth"]
```

If search quality is inadequate, a later follow-up can add explicit alias metadata instead of overloading tags.

---

## 8. Backend Changes

### 8.1 New Command: Install Emoji Pack

Add a Tauri command:

```rust
#[tauri::command]
pub async fn install_emoji_pack(
    state: State<'_, Arc<AppState>>,
) -> Result<models::SyncResult, String> { ... }
```

Responsibilities:

1. Ensure the managed expansions directory exists
2. Materialize `emoji-pack.yml`
3. Upsert a `snippet_source` row with stable metadata
4. Sync it through the existing source import pipeline
5. Refresh the trigger cache
6. Return a sync summary

### 8.2 New Command: Update Emoji Pack

```rust
#[tauri::command]
pub async fn update_emoji_pack(
    state: State<'_, Arc<AppState>>,
) -> Result<models::SyncResult, String> { ... }
```

This should regenerate the managed file from the latest bundled dataset and resync.

### 8.3 New Command: Uninstall Emoji Pack

```rust
#[tauri::command]
pub async fn uninstall_emoji_pack(
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> { ... }
```

Responsibilities:

1. Find the source by `managed_key`
2. Delete the source row
3. Let cascade delete remove the source-owned snippets
4. Remove the generated file if present
5. Refresh the trigger cache

### 8.4 Sync Pipeline Reuse

Do not create a special emoji import path that bypasses `sync_source_internal`.

The correct path is:

1. dataset -> generated YAML
2. generated YAML -> existing parser
3. parser -> existing source sync
4. source sync -> snippets table

That keeps all pack behavior consistent with other snippet sources.

### 8.5 Search Improvements

`list_snippets` currently searches trigger/label/body/tags depending on implementation in `db.rs`. Ensure it searches emoji aliases via tags so palette lookup works.

Required search matches:

1. trigger contains query
2. label contains query
3. tags contains query
4. category keyword contains query

---

## 9. Frontend Changes

### 9.1 Snippet Manager: Built-In Pack Card

Add a pack card near the sources/config controls:

```text
Emoji Pack
Type emojis with :shortcodes:
Coverage: 3,782 items
Version: Emoji 15.1
[Install] [Update] [Disable] [Remove]
```

State should depend on whether a source with `managed_key = builtin:emoji-pack` exists.

### 9.2 Pack Presentation in List

The existing grouped-by-source list already helps here. Once installed, the pack should appear as its own collapsible section:

```text
Emoji Pack (3782)
```

Because this source is large, the group should default to **collapsed** when the user is not actively searching.

### 9.3 Search Result Rendering

Emoji snippets should render differently from normal text snippets in the palette and list:

1. large emoji glyph preview on the left
2. shortcode trigger in monospace
3. human-readable label
4. category metadata in muted text

If per-source special-casing is undesirable, infer emoji rows by tag `emoji`.

### 9.4 Favorites and Recents

No special backend work should be needed. Emoji snippets should be favoritable and should appear in recents like any other snippet.

### 9.5 Empty / Uninstalled State

When the emoji pack is not installed, the Text Expander screen should include a direct CTA:

```text
Need emoji typing?
Install the built-in Emoji Pack for :shortcode: expansion.
```

---

## 10. Performance Requirements

This is the main engineering risk. A full emoji pack may add several thousand trigger entries.

### 10.1 Risks

1. `trigger_cache` becomes substantially larger
2. Snippet list rendering may become sluggish
3. Search queries may return too many rows
4. Initial sync/install may take noticeable time

### 10.2 Required Mitigations

1. Keep emoji rows in a dedicated source group
2. Default the source group to collapsed
3. Limit command-palette results to a sensible count, sorted by match quality
4. Avoid duplicate trigger aliases as full snippets in v1
5. Keep tags compact and normalized

### 10.3 Acceptable Limits

Target outcomes:

1. Trigger cache refresh remains fast enough that enabling the pack feels immediate
2. Typing in live expansion does not show perceptible lag
3. Searching the command palette for a common query like `heart` or `flag` returns in under ~100 ms on a typical dev laptop

If the pack size causes visible regression, the fallback is:

- ship only a curated common subset in v1
- defer full coverage until search/indexing is improved

But the preferred direction is full coverage with disciplined indexing.

---

## 11. Edge Cases

### 11.1 Skin Tone Variants

Support common skin-tone variants as explicit generated entries.

Examples:

- `:thumbs_up:` -> `👍`
- `:thumbs_up_light_skin_tone:` -> `👍🏻`
- `:thumbs_up_medium_skin_tone:` -> `👍🏽`

Do not require users to compose modifiers manually.

### 11.2 Gendered Variants

Where the Unicode emoji set has distinct common variants, generate explicit entries with explicit names.

Examples:

- `:person_shrugging:`
- `:man_shrugging:`
- `:woman_shrugging:`

### 11.3 Flags

Use concise country-code triggers for common discoverability:

- `:flag_us:`
- `:flag_gb:`
- `:flag_jp:`

Optionally keep full country names in aliases/tags.

### 11.4 ZWJ Sequences

Treat zero-width-joiner sequences as ordinary body strings. No special runtime support should be needed as long as the dataset is stored and serialized correctly.

### 11.5 Text vs Emoji Presentation

Some characters have variation-selector issues. The bundled dataset should choose the intended emoji-presentation form where necessary so the inserted body is stable.

Example:

- prefer `❤️` instead of a text-style heart where appropriate

---

## 12. Migration / Rollout

### 12.1 Existing Users

This feature should be opt-in. Do not auto-install thousands of emoji snippets for all existing users on upgrade.

Reasons:

1. avoids surprising trigger collisions
2. avoids bloating the trigger cache without consent
3. keeps rollout reversible

### 12.2 Fresh Installs

For new users, the pack should still be optional, but the onboarding/empty state should advertise it.

### 12.3 Updates

If the bundled emoji dataset version changes:

1. the pack card should show that an update is available
2. clicking `Update` regenerates and resyncs
3. snippets removed from the upstream dataset should be removed from the managed source on sync

---

## 13. File-Level Implementation Plan

### 13.1 Backend

Likely touched files:

- `src-tauri/src/commands.rs`
- `src-tauri/src/db.rs`
- `src-tauri/src/file_parser.rs` (only if validation/search metadata needs refinement)
- `src-tauri/src/trigger_cache.rs` (only if performance instrumentation is needed)
- `src-tauri/src/models.rs`
- `src-tauri/src/lib.rs`

New files likely needed:

- `src-tauri/templates/emoji-pack-source.json`
- `src-tauri/templates/emoji-pack.yml` or generator input/output files

### 13.2 Frontend

Likely touched files:

- `src/lib/snippets.ts`
- `src/lib/types.ts`
- `src/components/SnippetManager.tsx`
- `src/components/CommandPalette.tsx` or `src/components/ExpanderPalette.tsx`

### 13.3 Optional Tooling

If generation is easier via a script, add a repo script that rebuilds the managed YAML from the JSON source. That script should be deterministic and checked into the repo.

---

## 14. Testing

### 14.1 Backend Tests

1. dataset parser loads the bundled emoji dataset
2. generated YAML parses with the existing `file_parser.rs`
3. install command creates a stable source row
4. sync imports the expected number of snippets
5. uninstall removes only emoji-pack snippets
6. collisions with a user snippet are skipped, not overwritten

### 14.2 Search Tests

Verify lookups by:

1. trigger: `:smile:`
2. label: `rocket`
3. alias: `thumbsup`
4. category: `flags`

### 14.3 Live Expansion Tests

At minimum, test representative categories:

1. simple face emoji
2. skin-tone variant
3. flag
4. ZWJ sequence

### 14.4 UI Tests / Manual Validation

1. install flow works from Snippet Manager
2. source group defaults to collapsed
3. palette renders emoji glyph previews correctly
4. disabling the pack removes its triggers from live expansion

---

## 15. Open Questions

1. Should aliases be searchable only, or should some common aliases also become real triggers?
2. Should the initial dataset include all Unicode emoji variants, or a curated set of user-facing entries only?
3. Should emoji rows be hidden from the default list view until the user searches, to reduce visual noise?
4. Should the command palette boost emoji results when the query starts with `:`?
5. Should Dispatch expose a second built-in pack later for kaomoji/text faces (`¯\\_(ツ)_/¯`, `(╯°□°)╯︵ ┻━┻`)?

---

## 16. Recommendation

Implement v1 as an **optional managed snippet source** backed by a bundled generated dataset and searchable alias tags.

That approach is the best fit for Dispatch because it:

1. reuses the current source/sync/trigger architecture
2. minimizes special-case runtime logic
3. keeps uninstall/update semantics clean
4. gives users both `:shortcode:` live expansion and palette-based emoji search

The main discipline needed is around dataset quality and performance. If those are handled carefully, Dispatch can support an emoji pack without changing the fundamental text expansion model.
