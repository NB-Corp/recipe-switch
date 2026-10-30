---
title: "Safety, Backups & Rollback — recipe-switch"
description: "How recipe-switch protects your local AI coding tool configurations: dry-run diffs, secret redaction, hard-link preflight, hand-edit drift blocking, reversible transactions, and install-cycle original backups."
layout: doc
page_id: safety
h1: Safety, Backups & Rollback
kicker: Reference
---

`recipe-switch` edits configuration files inside your daily coding tools (`~/.codex`, `~/.claude`, `~/.kiki`, `~/.pi`, `~/.dsh`, `~/.kimi-code`, etc.). It is engineered so that **no write is a surprise, no manual edit is silently lost, and every change can be undone byte-for-byte.**

## 1. Dry-Run Diff Preview Before Every Write

Every command that modifies disk (`install`, `switch`, `rollback`, `uninstall`, `restore-original`) computes a full execution plan first:
- On the CLI, omitting `--yes` prints the exact unified diff (`+` / `-` line counts, file actions `CREATE`, `MODIFY`, `DELETE`, line-ending changes, and trailing newline changes) and exits without writing.
- In the Web UI, the bottom sheet renders the unified diff live as you toggle options.
- **Secret Redaction**: Any line in a diff matching patterns like `Authorization`, `Proxy-Authorization`, `x-api-key`, `api_key`, `cookie`, `set-cookie`, `auth`, `*token`, `*secret`, `*password`, or `Bearer ...` has its value replaced with `"[redacted]"` for display, while SHA-256 integrity checks still verify the real underlying bytes.
- **Stale Preview Rejection**: When you click **Write changes** or run with `--yes`, `recipe-switch` re-verifies the SHA-256 fingerprint of every target file. If any file changed on disk after the preview was generated, the apply aborts before writing a single byte.

![Diff preview]({{ '/screenshots/03-diff-preview.png' | relative_url }})

## 2. Hard-Link Preflight: File Systems That Cannot Promise Safe Writes Are Refused

The crash-recovery and byte-exact guarantees below depend on **hard links**: pre-write backups and original snapshots are captured as atomic hard links, so a backup can never be torn or half-copied.

During the preview stage, `recipe-switch` probes the target directory. **If the file system does not support hard links — common on FAT/exFAT volumes and some network drives — the operation is blocked outright**, with an explicit notice that safe writes cannot be guaranteed on that file system. Move the harness home (or `RECIPE_SWITCH_HOME`) to a hard-link-capable file system such as NTFS, APFS, or ext4 and try again.

## 3. Minimal, Marked Ownership (`src/units.mjs`)

`recipe-switch` never reformats an entire user config file just to change one setting. Each write is broken down into fine-grained **managed units**:

| Unit Type | What It Owns | How It Restores on Uninstall |
| --- | --- | --- |
| `file` | Whole files inside `recipe-switch`'s own directories (plus Kimi Code's marked `SYSTEM.md` wrapper) | Restores exact previous bytes, or deletes the file and cleans up empty created directories |
| `tomlKey` | A single `key = "…" # managed by recipe-switch` line inside a TOML table (`config.toml`) | Restores the exact previous line or removes the managed line while leaving the rest of the TOML file untouched |
| `jsonArrayItem` | One string item inside a JSON array (e.g., `opencode.json` → `instructions`, `openclaw.json` → `plugins.allow`, DSH `bundles`) | Restores the exact original source span (`jsonSpans`) including whitespace and indentation, and drops empty arrays/parent objects only if `recipe-switch` created them |
| `jsonKey` | One property inside a JSON object (e.g., OpenClaw `enabled`, DSH `dependencies`) | Restores the exact pre-edit lexical span or removes the created key/parent |
| `jsonArrayRecord` | One object matched by `"id": "recipe-switch"` inside a JSON array (`kimi-code` `installed.json`) | Restores the prior record raw span or removes the entry |
| `yamlArrayItem` | One block-list entry (`- recipe-switch`) under `plugins.enabled` in Hermes `config.yaml` | Applies the exact lexical `yamlPatch` or removes the item while preserving comments and surrounding keys |

## 4. Hand-Edit Detection ("Drift") & Foreign Guards

`recipe-switch` records the post-write fingerprint of every unit it manages.

- **Hand-edit drift**: If you open a managed `main.md`, edit `recipe.json`, or alter a `# managed by recipe-switch` line in `config.toml` by hand, `status` and the UI immediately flag the tool as **Edited / 有手改**.
- **Blocking on switch / rollback / uninstall**: Attempting to switch recipes, roll back, or uninstall when a file has hand-edit drift **stops with a blocked notice**.
- **Explicit backed-up override**: You can either move your manual edits out first, or explicitly override (`--force` on the CLI, or **Overwrite anyway (backed up)** in the UI). When forced, `recipe-switch` backs up your live hand-edited version into `~/.recipe-switch/backups/<op-id>/` and prints the exact path where your replaced version was saved.
- **Foreign installer guards**: If a target already has an unmanaged file at a managed path, or already loads `gpt-with-taste` via its standalone installer (`codex` receipt, `pi` package, `dsh-gpt-with-taste` bundle, or an unmanaged Kimi `SYSTEM.md`), `recipe-switch` blocks takeover until you restore the old installer or pass `--force`.

![Drift indicator on tool card]({{ '/screenshots/14-drift-card.png' | relative_url }})
![Blocked switch with overwrite option]({{ '/screenshots/13-blocked.png' | relative_url }})

## 5. Reversible Transactions, Displaced Files & Crash Recovery (`src/engine.mjs`)

All state and backups live in `$RECIPE_SWITCH_HOME` (default `~/.recipe-switch`):
- `state.json` — per-target operation stack (`install` and `switch` records with full unit before/after snapshots).
- `backups/<op-id>/` — exact pre-write file copies plus `index.json` with SHA-256 digests and displaced old files.
- `pending.json` — durable write-ahead compensation journal.

Before mutating any target file:
1. A file lock serializes operations across concurrent CLI invocations and UI requests.
2. Canonical path checks (`assertBoundary`) verify that no symlink or Windows junction redirects any target file outside the harness home directory.
3. Pre-write copies are saved to `backups/<op-id>/` and `pending.json` is flushed to disk.
4. **Displaced old files are kept only until the next operation.** When replacing an existing file on the same disk volume, the displaced old file is moved into the operation's `backups/<op-id>/` directory. Each harness keeps **at most the most recent displaced version**: on the following operation, a displaced file whose content already entered the backup store is deleted outright, while one whose content differs (someone wrote to it afterwards) is saved into the new operation's backup before deletion. If the state directory and the target live on different volumes, the old file is kept next to the target file, its path is recorded in the backup metadata and printed in the operation result, and `uninstall` will not delete it automatically so you can clean it up yourself.
5. If an error or crash interrupts a multi-file write before `state.json` commits, the very next command automatically runs `store.recover()`, reverting any partially written files back to their pre-operation bytes. (If you edited a file after the crash, recovery preserves your manual edit and reports the backup path for a manual decision.)

<div class="note warn" markdown="1">
**Limit:** a displaced version survives only until that harness's next operation. Content written afterwards through an old, still-open file handle is not guaranteed to be preserved.
</div>

## 6. Rollback vs. Uninstall vs. Original State Backup

`recipe-switch` provides three ways to go back:

| Action | CLI Command | UI Button | What It Does |
| --- | --- | --- | --- |
| **Rollback one step** | `recipe-switch rollback <harness> [--yes]` | **Undo last change / 撤回上一步** | Pops the latest operation off the target's stack and restores the previous recipe (or the original state if only one recipe was installed). |
| **Uninstall** | `recipe-switch uninstall <harness> [--yes]` | **Restore / 还原** | Unwinds every operation in the target's stack in reverse order, restores original file bytes/spans, and removes empty directories created by `recipe-switch`. |
| **Original State Backup & Restore** | `recipe-switch originals <harness>`<br>`recipe-switch restore-original <harness> [--yes]` | **原始备份 / 恢复到装之前** | Inspects or directly restores the baseline snapshot captured when the current install cycle began, regardless of how many switches or forced overrides happened since. |

### Original Backups Are Counted Per "Install Cycle"

- **One snapshot per cycle.** Each time a harness is installed from a not-installed state, `recipe-switch` takes exactly one baseline snapshot of the files it is about to modify. The snapshot is **not overwritten for the rest of that cycle**, no matter how many switches or forced overrides follow. The snapshot date is shown next to the restore button in the UI.
- **A cycle ends** when the harness is fully uninstalled or restored to its pre-install state. The snapshot retires with it, and any backup blobs no longer referenced by anything are released immediately. The next installation starts a new cycle with a fresh snapshot.
- **Upgrades backfill automatically.** Installations upgraded from an older `recipe-switch` version automatically reconstruct the snapshot from existing records. Where the complete original bytes can no longer be recovered, the snapshot is marked as a **reconstructed version (重建版本)** and restoring it requires an extra confirmation.
- **Already at the pre-install state?** The restore button is disabled — there is nothing to go back to.
- **Only your user can read the backup directory.** On Windows, `recipe-switch` tightens the ACL with `icacls`; on POSIX systems it enforces `0700` on directories and `0600` on files.
- **Tiny footprint.** Only existing files that will be modified in place get a content snapshot (files that did not exist are recorded as "originally absent"), and identical content is stored once by SHA-256 — never duplicated.

![Rollback preview]({{ '/screenshots/08-rollback-preview.png' | relative_url }})
![Uninstall preview]({{ '/screenshots/09-uninstall-preview.png' | relative_url }})
