---
title: "FAQ — How to Change System Prompts & Switch AI Coding Tool Behavior — recipe-switch"
description: "Frequently asked questions: how to change Claude Code system prompts, Codex AGENTS.md vs model_instructions_file, Kimi Code SYSTEM.md, Hermes and OpenClaw plugins, and how to roll back or recover hand edits."
---

# Frequently Asked Questions (FAQ)

[Home](index.md) · [Getting Started](getting-started.md) · [Harnesses](harnesses.md) · [Safety & Rollback](safety.md) · [Recipes & Options](recipes.md) · **FAQ** · [简体中文](zh/faq.md)

---

### How do I change the Claude Code system prompt without breaking `settings.json`?

Claude Code lets you append a system prompt file and load hook plugins at session start. When you run `recipe-switch install claude <recipe> --yes`, `recipe-switch` **never touches `~/.claude/settings.json`**. Instead, it writes `~/.claude/recipe-switch/main.md` and `~/.claude/recipe-switch/plugin/` (which injects User, Subagent, and Result reminders through Claude Code hooks) and gives you a clean launch command:

```sh
claude --append-system-prompt-file "~/.claude/recipe-switch/main.md" --plugin-dir "~/.claude/recipe-switch/plugin"
```

When you switch recipes later, `recipe-switch` updates those files in place so the same launch command or shell alias immediately uses the new recipe.

---

### OpenAI Codex `AGENTS.md` vs `model_instructions_file` in `config.toml` — what is the difference?

In OpenAI Codex, `AGENTS.md` is typically used for repository-specific or directory-scoped instructions, whereas `model_instructions_file` in `~/.codex/config.toml` sets the global base instructions file for the model. `recipe-switch` writes its managed prompt to `~/.codex/prompts/recipe-switch/main.md` (plus `sub.md`) and sets `model_instructions_file = ".../prompts/recipe-switch/main.md" # managed by recipe-switch` in `~/.codex/config.toml`. That way your project-level `AGENTS.md` files stay untouched and compose cleanly with your global behavior recipe.

---

### How do I swap the system prompt and per-turn reminders in Kimi Code CLI?

Kimi Code CLI reads `~/.kimi-code/SYSTEM.md` for the system prompt and loads plugins from `~/.kimi-code/plugins/installed.json`. When you run `recipe-switch install kimi-code <recipe> --yes`, `recipe-switch`:
1. Writes a marked `~/.kimi-code/SYSTEM.md` that starts with `${base_prompt}` (preserving Kimi Code's built-in core instructions) followed by the recipe's Main prompt.
2. Installs a managed plugin under `~/.kimi-code/plugins/managed/recipe-switch/` that injects `userSteer` on every `UserPromptSubmit` event.

If you already have a custom, non-managed `SYSTEM.md`, `recipe-switch` blocks installation so it never overwrites your file silently.

---

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
In the local web UI (`recipe-switch ui`), open the tool card and click **Undo last change**, **Restore**, or **Original backup / Restore to before install**.

---

### What happens if I edit a prompt or config file by hand after installing a recipe?

`recipe-switch` fingerprints every file, TOML line, JSON key/item, and YAML list entry it manages. If you edit a managed file by hand (or delete the `# managed by recipe-switch` comment), `recipe-switch status` and the UI mark the tool as **Edited (`drift`)**.

Any subsequent `switch`, `rollback`, or `uninstall` will **stop and block** rather than overwriting your manual work. You can either copy your manual edits elsewhere first, or pass `--force` (in the UI: **Overwrite anyway (backed up)**). Even when forced, `recipe-switch` saves a complete copy of your hand-edited file into `~/.recipe-switch/backups/<op-id>/` before replacing it and prints the exact backup path.

---

### Does `recipe-switch` touch my API keys, model choices, providers, or MCP servers?

**No.** `recipe-switch` only writes behavior prompt files and the minimal config keys needed to load them. It never reads or modifies your model selection, API keys, provider URLs, MCP servers, or agent role definitions. Furthermore, when displaying unified diffs in the CLI or UI, any adjacent lines in your config files that look like secrets (`api_key`, `token`, `password`, `Authorization`, `Bearer`) are automatically redacted.

---

### Why does OpenClaw ask for "Grant recipe-switch conversation access"?

OpenClaw's security policy requires non-bundled plugins to have `plugins.entries.<id>.hooks.allowConversationAccess = true` in `openclaw.json` before `before_prompt_build` hooks can run.
- By default, `recipe-switch` **does not** grant permissions behind your back; it leaves `allowConversationAccess` unset and notes that the hook will stay inactive until enabled.
- In the Web UI, you can explicitly check **Grant recipe-switch conversation access** in Tool settings to let `recipe-switch` write that key (and restore its prior state on uninstall).
- If your `openclaw.json` explicitly sets `allowConversationAccess: false`, `allowPromptInjection: false`, `plugins.enabled: false`, or lists `recipe-switch` in `plugins.deny`, `recipe-switch` will never override your denial — even with `--force`.

---

### Why does Hermes Agent say `Main/Sub unavailable; per-turn steering via pre_llm_call only`?

Full Main and Subagent system prompt injection in Hermes relies on `PluginContext.register_middleware("llm_request", ...)`. Before installing, `recipe-switch` checks `<home>/hermes-agent/hermes_cli/plugins.py` (or `<home>/hermes_cli/plugins.py`) as plain text. If your local Hermes checkout is an older version without `register_middleware` (or if the source file isn't in the Hermes home), `recipe-switch` safely falls back to installing the `pre_llm_call` steering hook only. Upgrade Hermes and run `recipe-switch install hermes <recipe> --yes` again to enable full Main/Sub system prompts. Note that Hermes's native `codex_app_server`, auxiliary calls, and max-iteration summary calls bypass `llm_request` middleware by design.

---

### Why are Cursor, Gemini CLI, and Qoder listed under "Not covered"?

`recipe-switch` only writes to tools where a clean, file-backed global instruction or extension contract is verified:
- **Cursor**: Global user rules are stored in an internal application database rather than a plain config file, and `.cursor/rules` files are per-project.
- **Gemini CLI**: Only project-level `GEMINI.md` is confirmed by donor docs; no native source checkout has confirmed a global instruction slot or extension contract yet.
- **Qoder**: The plugin/hook route is known from Ponytail, but an adapter has not been bundled into `recipe-switch` yet.
