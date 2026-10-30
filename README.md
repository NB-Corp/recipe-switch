# recipe-switch

Install, switch and roll back behavior recipes across coding harnesses, from a CLI or a local web page.

A recipe is a set of six behavior texts: Main, Sub, Independent, and the User, Sub and Agent Steer reminders. The loader puts a recipe into each harness through that harness's native entry point. Every change is previewed as a diff, backed up, and reversible. The loader never edits model, provider, credentials, MCP or role settings, or overrides an existing permission denial.

Requires Node.js 22 or newer. No npm packages.

## Quick start

```sh
node bin/recipe-switch.mjs status
node bin/recipe-switch.mjs recipes
node bin/recipe-switch.mjs install pi gpt-with-taste@0.1.0          # dry run: prints the diff
node bin/recipe-switch.mjs install pi gpt-with-taste@0.1.0 --yes    # apply
node bin/recipe-switch.mjs ui                                       # http://127.0.0.1:4517/
```

To try everything without touching your real homes, run `node scripts/demo.mjs --reset`. It creates fake harness homes under `.tmp/demo/` and opens the UI against them.

![Targets overview](docs/screenshots/01-overview.png)

Before anything is written, the preview shows each file the change touches. A hand edit blocks the apply:

![Diff preview](docs/screenshots/03-diff-preview.png)
![Hand edit blocks a switch](docs/screenshots/13-blocked.png)

## Commands

| Command | What it does |
| --- | --- |
| `status [--json]` | Each detected harness and target, the recipe the loader installed, other active instructions, hand-edit drift, blocking installers, and the harnesses not covered |
| `recipes [--json]` | Recipes from the configured sources |
| `sources [add\|remove <path>] [--gwt <dir>]` | Manage recipe sources and the gpt-with-taste checkout used for adapters |
| `install <harness> <recipe>` | Preview, or apply with `--yes`. On a managed target it becomes a switch |
| `switch <harness> <recipe>` | Same as install; reads better when a recipe is already active |
| `rollback <harness>` | Undo the latest install or switch: back to the previous recipe, or to the original state |
| `uninstall <harness>` | Undo every operation and restore the original files |
| `history <harness>` | Operations with their backup directories |
| `ui [--port N] [--no-open]` | Local web UI |

Common flags: `--home DIR` picks one target (required for DSH when several profiles exist), `--yes` applies, `--force` overrides the hand-edit and foreign-install guards. Harness options: `--models a,b` (Kiki), `--root-role main|independent` (DSH), `--providers p,q` and `--model-pattern REGEX` (Pi). A switch reuses the previous options unless you pass new ones.

## Harnesses and write points

| Harness | Home (override) | What the loader writes | Steer |
| --- | --- | --- | --- |
| OpenAI Codex | `CODEX_HOME`, `~/.codex` | `prompts/recipe-switch/{main,sub}.md` plus one line, `model_instructions_file = "…" # managed by recipe-switch`, in `config.toml` | None from the loader; gpt-with-taste's own `--hooks` plugin covers it |
| Claude Code | `CLAUDE_CONFIG_DIR`, `~/.claude` | `recipe-switch/main.md` and `recipe-switch/plugin/` (the gpt-with-taste plugin). Settings are not edited; the loader prints the `claude --append-system-prompt-file … --plugin-dir …` launch command | User, Sub, Agent through plugin hooks |
| Kiki | `KIKI_HOME`, `~/.kiki` | Recipe package in `recipe-switch/packages/<id>/` plus `recipe = "<package>" # managed by recipe-switch` on each chosen `[models."<alias>"]` | Native Recipe steering |
| Pi | `PI_CODING_AGENT_DIR`, `~/.pi/agent` | Built-in extension `extensions/recipe-switch/`. Switching rewrites only its `recipe.json`, which the extension re-reads on each request | User, Sub, completed results |
| DeepSeek Harness | `DSH_HOME`, `~/.dsh`; one target per profile | Built-in bundle `dsh-recipe-switch` under `profiles/<p>/node_modules/` and `profiles/<p>/.recipe-switch/`, one `dependencies` entry and one `dsh.profile.bundles` item in the profile `package.json`. Switching rewrites only `recipe.json`, which is re-read before each step | User, coordinator, subagent reports |
| Oh My Pi | `OMP_CODING_AGENT_DIR`, `~/.omp/agent` | `extensions/recipe-switch/` (gpt-with-taste OMP adapter) | Through the adapter (GPT models) |
| Grok Build | `GROK_HOME`, `~/.grok` | `rules/recipe-switch.md`; other rules keep loading | None: Grok hooks cannot add context |
| OpenCode | `OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode` | `recipe-switch/main.md` plus one item in the `instructions` array of `opencode.json` | None yet |
| Kimi Code CLI | `KIMI_CODE_HOME`, `~/.kimi-code` | Marked `SYSTEM.md` with `${base_prompt}` followed by Main; `plugins/managed/recipe-switch/{kimi.plugin.json,steer.mjs,recipe.json}` plus one object in `plugins/installed.json`. When Main is enabled, a non-managed `SYSTEM.md` blocks installation; with Main off it stays untouched. Restart after installation or Main changes; explicit agent profiles can override `SYSTEM.md` | User Steer re-read on each `UserPromptSubmit`; subagent profiles are unchanged |
| Hermes Agent | `HERMES_HOME`; Windows `%LOCALAPPDATA%/hermes`, otherwise `~/.hermes` | `plugins/recipe-switch/{plugin.yaml,__init__.py,recipe.json}` and one block-list item in `config.yaml` → `plugins.enabled`. Restart after plugin install/update. `llm_request` appends full Main/Sub to Chat system/developer messages, Anthropic/Bedrock system blocks or Responses instructions. Each session's first request freezes its text in the running plugin; switches affect new sessions. Native `codex_app_server`, auxiliary and max-iteration summary calls bypass this middleware. Flow-style YAML/anchors at the edited keys block installation | User/Sub Steer re-read at `pre_llm_call`; delegated children use Sub |
| OpenClaw | `OPENCLAW_STATE_DIR`, otherwise `<OPENCLAW_HOME or OS home>/.openclaw`; config override `OPENCLAW_CONFIG_PATH` | `extensions/recipe-switch/{package.json,openclaw.plugin.json,index.mjs,recipe.json}`; `plugins.entries.recipe-switch.enabled`, `.hooks.allowConversationAccess` and an item in an existing `plugins.allow`. An absent `allowConversationAccess` is enabled for this plugin and announced in the preview. Explicit `false` for it or `allowPromptInjection`, a disabled plugin system or a deny entry must be changed manually before installation; `--force` does not override them. Config must be strict JSON; JSON5-only syntax blocks installation. Restart Gateway after install; later switches take effect on the next prompt build. `AGENTS.md`/`SOUL.md` stay unchanged | Main/User Steer, or Sub/Sub Steer for subagent session keys |

The Pi and DSH plugins in `plugins/` are adapted from the gpt-with-taste runtimes, with the text source changed to the loader's snapshot. That lets one installed plugin carry any recipe.

### Not covered

| Harness | Reason |
| --- | --- |
| Gemini CLI | No native source to confirm the global instruction slot or extension contract |
| Cursor | User rules live in the app's settings database. File rules are per project |
| Qoder | The plugin and hook route is known from Ponytail, but there is no source or adapter here yet |

## Recipe sources

The default source is the sibling `../gpt-with-taste` checkout, set with `RECIPE_SWITCH_GWT` or `sources --gwt`. Its `recipe/manifest.json` and committed `dist/<harness>/` files are used directly. Add more sources with `sources add <path>`:

- A gpt-with-taste style repository (`recipe/manifest.json` plus `dist/`).
- A Kiki Recipe `.toml` file, or a directory of them, such as `../kimi/recipes`. The six texts are read from its `[prompts]`, `[prompts.main]` and `[prompts.independent]` slots. Harness files are rendered by gpt-with-taste's own `adapters/<harness>/build.mjs`, and Kiki receives the original package files.

Options are listed and applied in their TOML declaration order, including numeric ids. Unknown `--with` / `--without` ids are ignored with a warning. Explicit `main = "off"` and `independent = "off"` stay disabled: Kiki and the built-in snapshot plugins preserve them; an adapter or entry point that cannot represent the disabled role asks you to choose another recipe instead of filling it with common text.

## Safety model

- **Dry run first.** Every write shows a per-file unified diff, including line-ending and final-newline changes. Authorization, API-key, cookie and other secret-looking values are redacted for display. Apply compares the real, unredacted bytes with the preview.
- **Small, marked ownership.** The loader owns whole files inside its own `recipe-switch` directories, plus Kimi Code's marked `SYSTEM.md` wrapper around `${base_prompt}`. An existing non-managed file blocks installation unless explicitly forced. A Codex home managed by gpt-with-taste's installer, a Pi gpt-with-taste package, or a DSH `dsh-gpt-with-taste` bundle also blocks takeover. In other user files it owns tagged TOML lines, single JSON keys or array items/records, or marked YAML block-list items. Uninstall restores original source spans, including escaped strings and empty-container whitespace, while keeping unrelated edits.
- **Hand edits stop the loader.** Changes to owned content, including TOML/YAML marker comments, block switch, rollback and uninstall. `--force` backs up the live user version before replacing or retiring it. Files changed after a preview require another preview, even with force.
- **Confined paths.** Destination paths are checked against the chosen home using canonical paths before planning and writing; a junction cannot redirect an implicit target outside it. An explicit `OPENCLAW_CONFIG_PATH` has its own boundary. Package text and option-patch files must resolve inside their package.
- **Reversible transactions.** Operations stack per target in `$RECIPE_SWITCH_HOME/state.json` (default `~/.recipe-switch`), with exact pre-write copies in `backups/<op>/`. Store transactions serialize across server requests and CLI processes. All units are preflighted before mutation; write or state-save failure compensates completed writes. An interrupted operation leaves `pending.json`, recovered on the next normal command. If recovery finds a newer user edit, it keeps that edit and reports the file and backup for a manual decision. Uninstall restores original bytes and removes created directories.
- **Local only.** The UI listens on `127.0.0.1`, requires a per-process token, and rejects foreign `Origin` and unexpected `Host` headers.

## Tests

```sh
npm test
```

Tests run only against fake homes under `.tmp/test/`. The DSH test loads the installed bundle through the real DSH profile discovery and Cordis Loader when `DSH_PACKAGE_ROOT` points to an installed `@deepseek-ai/dsh`, or when the default nvm path exists. Otherwise it is skipped.
