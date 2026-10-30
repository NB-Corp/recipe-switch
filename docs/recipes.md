---
title: "Recipes & Options Format (recipe.toml) — recipe-switch"
description: "Authoring guide for recipe-switch: connect recipe sources, structure a recipe.toml package, understand the six prompt and steering slots, and build checkbox options with when/unless, prepend/append, and Markdown section patches."
---

# Recipes & Options Format (`recipe.toml`)

[Home](index.md) · [Getting Started](getting-started.md) · [Harnesses](harnesses.md) · [Safety & Rollback](safety.md) · **Recipes & Options** · [FAQ](faq.md) · [简体中文](zh/recipes.md)

---

## What is a Recipe?

A **recipe** is a portable working style for AI coding harnesses. Under the hood, every recipe evaluates to **six behavior text slots**:

| Slot Key | UI Label (EN / 中文) | Purpose |
| --- | --- | --- |
| `main` | Main / 主代理 | System prompt for the primary interactive coding agent. |
| `sub` | Subagent / 子代理 | System prompt for delegated child/subagent executions. |
| `independent` | Independent / 独立 | System prompt for standalone, self-contained agent tasks. |
| `userSteer` | User reminder / 用户提醒 | Short per-turn steering injected when the user sends a message. |
| `subSteer` | Sub reminder / 子代理提醒 | Short per-turn steering injected into subagent turns. |
| `agentSteer` | Result reminder / 结果提醒 | Short steering injected when a subagent or background task returns results to the main agent. |

---

## Managing Recipe Sources

`recipe-switch` scans configured source paths in order (`~/.recipe-switch/config.json`):

```sh
# View current gpt-with-taste checkout and recipe sources
node bin/recipe-switch.mjs sources

# Add a directory of recipes or a single recipe.toml file
node bin/recipe-switch.mjs sources add ~/my-recipes

# Remove a source
node bin/recipe-switch.mjs sources remove ~/my-recipes

# Point to your gpt-with-taste checkout (used for harness adapters)
node bin/recipe-switch.mjs sources --gwt ~/code/gpt-with-taste
```

Supported source layouts (`src/sources.mjs`):
1. **A single `recipe.toml` file**, or a directory containing `recipe.toml` (or subdirectories with `.toml` files, excluding `mapping.toml`).
2. **An author repository** containing `recipe/recipe.toml` (or legacy `recipe/manifest.json`) plus `dist/<harness>/` build artifacts, such as [gpt-with-taste](https://github.com/NB-Corp/gpt-with-taste).

When two sources provide the same `id@version`, `recipe-switch` disambiguates the second key by appending its content revision hash (`id@version#abcdef`).

---

## `recipe.toml` Structure & Slot Inheritance

`recipe-switch` uses the same `recipe.toml` package schema as Kiki Recipes (`src/recipe-toml.mjs`).

```toml
schema_version = 1
id = "calm-reviewer"
name = "Calm Reviewer"
version = "0.2.1"
description = "Review-first behavior with optional security pass."

[prompts]
system = { file = "sub.md" }
steering = { text = "Stay inside the assigned slice." }

[prompts.main]
system = { file = "main.md" }
steering = { text = "Keep the review goal in view." }

[prompts.independent]
system = { file = "independent.md" }
steering = "off"
```

### How `[prompts]` Slots Map to the Six Behavior Texts

Each prompt slot can be a single `{ file = "..." }` or `{ text = "..." }` object, an array of such objects (joined with a blank line `\n\n` in declaration order), or `"off"`:

- **Common / Subagent branch (`[prompts]`)**:
  - `prompts.system` → **`sub`** (and serves as the fallback for `main` and `independent` if they are omitted or set to `"same"`).
  - `prompts.steering` → **`subSteer`**.
- **Main branch (`[prompts.main]`)**:
  - `prompts.main.system` → **`main`** (falls back to `prompts.system` if omitted).
  - `prompts.main.steering` → **`userSteer`**.
  - `prompts.main.steering_sources.agent.custom.steering` → **`agentSteer`** (falls back to `userSteer` unless `prompts.main.steering_sources.agent.mode = "off"`).
- **Independent branch (`[prompts.independent]`)**:
  - `prompts.independent.system` → **`independent`** (falls back to `prompts.system`, or `main` if `prompts.system` is omitted).
- **Explicit `"off"`**:
  - Setting `prompts.main = "off"` or `prompts.independent = "off"` (or a slot to `"off"`) sets that text to `null`. Kiki and the built-in snapshot plugins (Pi, DSH, Kimi Code, Hermes, OpenClaw) preserve disabled roles; single-entry adapters that require `main` (`codex`, `claude`, `omp`, `grok`, `opencode`) will refuse a recipe with `main = "off"` rather than silently substituting subagent text.

*(Note: `extends` is not directly evaluated by `recipe-switch`; install the materialized package instead.)*

---

## Defining Checkbox Options (`[options.<id>]`)

Options let users customize a recipe from the UI or via `--with a,b --without c` on the CLI. Options are evaluated in their TOML declaration order and **only modify text slots** — they never touch model settings, hooks, or permissions.

Every option requires a `name` (string) and `default` (boolean), with an optional `description`:

```toml
[options.brief]
name = "Brief replies"
description = "Prepends a brevity rule to every system prompt and appends a reminder to Main steering."
default = true
```

There are three ways an option can modify prompt slots:

### 1. Conditional Slot Items (`when` and `unless`)

Any `{ file = "..." }` or `{ text = "..." }` item inside `[prompts]` can carry `when = "<option_id>"` (kept when the option is `true`) or `unless = "<option_id>"` (kept when the option is `false`):

```toml
[prompts]
system = [
  { file = "sub.md" },
  { text = "Report blockers early.", unless = "quiet" }
]
steering = { text = "Stay inside the slice.", unless = "quiet" }

[prompts.main]
system = [{ file = "main.md" }, { file = "research.md", when = "research" }]
steering = [
  { text = "Keep the goal in view." },
  { text = "Cite file:line for findings.", when = "review" }
]
```

If all items in a slot are filtered out by `when`/`unless`, the slot remains declared with empty text `""` (not `"off"`).

### 2. Whole-Slot `prepend` and `append` Shorthand

Inside `[options.<id>]`, use `prepend.<branch>.<slot>` or `append.<branch>.<slot>` to add `{ file }` or `{ text }` items to the start or end of a declared slot when the option is on.

Valid slot targets: `common` | `main` | `independent` followed by `.system`, `.steering`, `.anchor`, or `.steering_sources.<source>`:

```toml
[options.brief]
name = "Brief replies"
default = true
prepend.common.system = { text = "Keep replies short." }
append.main.steering = { text = "Stay brief." }
```

### 3. Markdown Section Patches (`[[options.<id>.patch]]`)

To surgically edit a specific Markdown section inside an assembled slot when an option is enabled, add one or more `[[options.<id>.patch]]` blocks:

```toml
[options.review]
name = "Review section"
description = "Inserts a Review section before Tone in Main and appends a line inside Workflow."
default = false

[[options.review.patch]]
slot = "main.system"
section = "Tone"
action = "before"
content = { file = "review.md" }

[[options.review.patch]]
slot = "main.system"
section = "Workflow"
action = "append"
content = { text = "Finish with a self-review." }
```

- **`slot`**: Target slot (`common.system`, `main.system`, `independent.system`, `main.steering`, etc.).
- **`section`**: Exact Markdown heading text (at any `#`–`######` level; headings inside fenced code blocks ```` ``` ```` or `~~~` are ignored). A section spans from its heading line up to the next heading of the same or higher level. The heading must match exactly once in the assembled slot.
- **`action`**:
  - `prepend` — insert `content` at the start of the section's body (immediately after the heading) or at the start of the whole slot if `section` is omitted.
  - `append` — insert `content` at the end of the section's body (or end of the whole slot if `section` is omitted).
  - `before` — insert `content` (e.g., a new section) immediately before the target section's heading (`section` required).
  - `after` — insert `content` immediately after the target section (`section` required).
  - `replace` — replace the entire section (heading + body) with `content` (`section` required).
  - `remove` — delete the entire section (`section` required; takes no `content`).

See [`examples/options-sample/`](https://github.com/NB-Corp/recipe-switch/tree/main/examples/options-sample) in the repository for a complete reference package and its materialized outputs (`all-off`, `all-on`, `defaults`, `review-only`).
