---
title: "FAQ — How to Change System Prompts & Switch AI Coding Tool Behavior — recipe-switch"
description: "Frequently asked questions: how to change Claude Code system prompts, Codex AGENTS.md vs model_instructions_file, Kimi Code SYSTEM.md, Hermes and OpenClaw plugins, install-cycle backups, and how to recover hand edits."
layout: doc
page_id: faq
h1: Frequently Asked Questions
kicker: FAQ
---

### How do I change the Claude Code system prompt without breaking `settings.json`?

Claude Code lets you append a system prompt file and load hook plugins at session start. When you run `recipe-switch install claude <recipe> --yes`, `recipe-switch` **never touches `~/.claude/settings.json`**. Instead, it writes `~/.claude/recipe-switch/main.md` and `~/.claude/recipe-switch/plugin/` (which injects User, Subagent, and Result reminders through Claude Code hooks) and gives you a clean launch command:

```sh
claude --append-system-prompt-file "~/.claude/recipe-switch/main.md" --plugin-dir "~/.claude/recipe-switch/plugin"
```

When you switch recipes later, `recipe-switch` updates those files in place so the same launch command or shell alias immediately uses the new recipe.

### OpenAI Codex `AGENTS.md` vs `model_instructions_file` in `config.toml` — what is the difference?

In OpenAI Codex, `AGENTS.md` is typically used for repository-specific or directory-scoped instructions, whereas `model_instructions_file` in `~/.codex/config.toml` sets the global base instructions file for the model. `recipe-switch` writes its managed prompt to `~/.codex/prompts/recipe-switch/main.md` (plus `sub.md`) and sets `model_instructions_file = ".../prompts/recipe-switch/main.md" # managed by recipe-switch` in `~/.codex/config.toml`. That way your project-level `AGENTS.md` files stay untouched and compose cleanly with your global behavior recipe.

### How do I swap the system prompt and per-turn reminders in Kimi Code CLI?

Kimi Code CLI reads `~/.kimi-code/SYSTEM.md` for the system prompt and loads plugins from `~/.kimi-code/plugins/installed.json`. When you run `recipe-switch install kimi-code <recipe> --yes`, `recipe-switch`:
1. Writes a marked `~/.kimi-code/SYSTEM.md` that starts with `${base_prompt}` (preserving Kimi Code's built-in core instructions) followed by the recipe's Main prompt.
2. Installs a managed plugin under `~/.kimi-code/plugins/managed/recipe-switch/` that injects `userSteer` on every `UserPromptSubmit` event.

If you already have a custom, non-managed `SYSTEM.md`, `recipe-switch` blocks installation so it never overwrites your file silently.

### How do I roll back a recipe or restore my tool to how it was before installing `recipe-switch`?

You have three options depending on how far back you want to go:
- **Step back one change** (to the previous recipe):
  ```sh
  node bin/recipe-switch.mjs rollback <harness> --yes
  ```
- **Uninstall and unwind the operation stack** (restores original config lines/spans and deletes directories created by `recipe-switch`):
  ```sh
  node bin/recipe-switch.mjs uninstall <harness> --yes
  ```
- **Restore the pre-install original backup ("原始备份 / 恢复到装之前")**:
  ```sh
  node bin/recipe-switch.mjs originals <harness>
  node bin/recipe-switch.mjs restore-original <harness> --yes
  ```
In the local web UI (`recipe-switch ui`), open the tool card and click **Undo last change**, **Restore**, or **原始备份 / 恢复到装之前**.

### When does `recipe-switch` refuse to install at all?

Two situations stop an install before anything is written:
- **The file system cannot do hard links.** The preview stage probes the target directory; FAT/exFAT volumes and some network drives fail the probe, and the operation blocks with a notice that safe writes cannot be guaranteed there. Move the harness home to NTFS/APFS/ext4.
- **You explicitly denied a permission.** For OpenClaw, an existing `allowConversationAccess: false`, `allowPromptInjection: false`, `plugins.enabled: false`, or a `plugins.deny` entry is never overridden — even with `--force`.

### Do backups and original snapshots take up much disk space? What happens to replaced files?

**Storage overhead is tiny: `recipe-switch` only stores one copy of the original files it modifies, deduplicated by content.**
- **Original backups are counted per install cycle**: one snapshot is taken when a harness goes from not-installed to installed, and it is not overwritten for the rest of that cycle. Uninstall (or restore to the pre-install state) ends the cycle, retires the snapshot, and immediately releases any backup blobs nothing references anymore. Only existing files that will be modified in place are snapshotted; identical content is stored once by SHA-256.
- **Displaced old files are kept only until the next operation.** Each harness keeps at most the most recent displaced version. On the next operation, a displaced file already in the backup store is deleted outright; one whose content changed since (someone wrote to it afterwards) is saved into the new backup first. On a cross-volume setup the old file stays next to the target and `uninstall` leaves it for you to clean up. Note the limit: after that next operation, content written through an old still-open file handle is not guaranteed to survive.

### What happens if I edit a prompt or config file by hand after installing a recipe?

`recipe-switch` fingerprints every file, TOML line, JSON key/item, and YAML list entry it manages. If you edit a managed file by hand (or delete the `# managed by recipe-switch` comment), `recipe-switch status` and the UI mark the tool as **Edited (`drift`)**.

Any subsequent `switch`, `rollback`, or `uninstall` will **stop and block** rather than overwriting your manual work. You can either copy your manual edits elsewhere first, or pass `--force` (in the UI: **Overwrite anyway (backed up)**). Even when forced, `recipe-switch` saves a complete copy of your hand-edited file into `~/.recipe-switch/backups/<op-id>/` before replacing it and prints the exact backup path.

### Does `recipe-switch` touch my API keys, model choices, providers, or MCP servers?

**No.** `recipe-switch` only writes behavior prompt files and the minimal config keys needed to load them. It never reads or modifies your model selection, API keys, provider URLs, MCP servers, or agent role definitions. Furthermore, when displaying unified diffs in the CLI or UI, any adjacent lines in your config files that look like secrets (`api_key`, `token`, `password`, `Authorization`, `Bearer`) are automatically redacted.

### Who can read the backup directory?

Only you. The state and backup directory (`~/.recipe-switch`) is locked to the current user: on Windows `recipe-switch` tightens the ACL with `icacls`, and on POSIX systems it enforces `0700` on directories and `0600` on files.

### Why does OpenClaw ask for "Grant recipe-switch conversation access"?

OpenClaw's security policy requires non-bundled plugins to have `plugins.entries.<id>.hooks.allowConversationAccess = true` in `openclaw.json` before `before_prompt_build` hooks can run.
- **By default it is not granted.** `recipe-switch` leaves `allowConversationAccess` unset and notes that the hook will stay inactive until enabled; nothing is written behind your back.
- In the Web UI, you can explicitly check **Grant recipe-switch conversation access** in Tool settings to let `recipe-switch` write that key (and restore its prior state on uninstall).
- If your `openclaw.json` explicitly sets `allowConversationAccess: false`, `allowPromptInjection: false`, `plugins.enabled: false`, or lists `recipe-switch` in `plugins.deny`, installation is **blocked** — `recipe-switch` will never override your denial, even with `--force`.

### Why does Hermes show "未知：请启动一次 Hermes" or fall back to per-turn steering only?

Before installing, `recipe-switch` uses Python (`python` or `py -3`) to AST-parse the host source without executing it. `PluginContext` must directly define an undecorated, unshadowed `register_middleware` method.
- If eligible, both `llm_request` middleware (full Main/Sub prompts) and `pre_llm_call` (per-turn steering) are installed.
- If Python is unavailable, parsing fails or the static signal is missing, only per-turn steering is installed and the UI shows **Main/Sub unavailable**. Check the reason, make Python available or upgrade Hermes as needed, then reinstall.

For an eligible host, runtime reports determine the other three states: **Confirmed active** (a request reached the middleware), **Registered; no request seen yet**, or **Unknown: start Hermes once** (no valid runtime report). Static eligibility alone does not confirm activation. Hermes's native `codex_app_server`, auxiliary calls, and max-iteration summary calls bypass the middleware.

### What does "reconstructed version (重建版本)" mean on an original snapshot?

Original snapshots are counted per install cycle: one snapshot per installation from a clean state, kept until you uninstall or restore to the pre-install state. Installations **upgraded from an older `recipe-switch` version** backfill this snapshot automatically from existing records. Where the complete original bytes can no longer be recovered, the snapshot is marked as a **reconstructed version**, and restoring it asks for an extra confirmation. When the harness is already at its pre-install state, the restore button is simply disabled.

### Why are Cursor, Gemini CLI, and Qoder listed under "Not covered"?

`recipe-switch` only writes to tools where a clean, file-backed global instruction or extension contract is verified:
- **Cursor**: Global user rules are stored in an internal application database rather than a plain config file, and `.cursor/rules` files are per-project.
- **Gemini CLI**: Only project-level `GEMINI.md` is confirmed by donor docs; no native source checkout has confirmed a global instruction slot or extension contract yet.
- **Qoder**: The plugin/hook route is known from Ponytail, but an adapter has not been bundled into `recipe-switch` yet.
