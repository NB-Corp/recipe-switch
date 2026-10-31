---
title: "Safety, Backups & Rollback — recipe-switch"
description: "How recipe-switch protects your local AI coding tool configurations: dry-run diffs, secret redaction, hard-link preflight, hand-edit drift blocking, reversible transactions, and install-cycle original backups."
layout: doc
page_id: safety
h1: Safety, Backups & Rollback
kicker: Reference
---

`recipe-switch` edits configuration files inside your daily coding tools (`~/.codex`, `~/.claude`, `~/.kiki`, `~/.pi`, `~/.dsh`, `~/.kimi-code`, etc.). It previews writes, backs up exact bytes, and blocks on detected manual edits unless you confirm an override. Rollback restores owned source spans; original snapshots restore complete saved files. The transaction section below explains the recovery race and old-handle retention cutoff.

## 1. Dry-Run Diff Preview Before Every Write

Every command that modifies disk (`install`, `switch`, `rollback`, `uninstall`, `restore-original`) computes a full execution plan first:
- On the CLI, omitting `--yes` prints the exact unified diff (`+` / `-` line counts, file actions `CREATE`, `MODIFY`, `DELETE`, line-ending changes, and trailing newline changes) and exits without writing.
- In the Web UI, the bottom sheet renders the unified diff live as you toggle options.
- **Secret Redaction**: Any line in a diff matching patterns like `Authorization`, `Proxy-Authorization`, `x-api-key`, `api_key`, `cookie`, `set-cookie`, `auth`, `*token`, `*secret`, `*password`, or `Bearer ...` has its value replaced with `"[redacted]"` for display, while SHA-256 integrity checks still verify the real underlying bytes.
- **Stale Preview Rejection**: When you click **Write changes** or run with `--yes`, `recipe-switch` re-verifies the SHA-256 fingerprint of every target file. If any file changed on disk after the preview was generated, the apply aborts before writing a single byte.

![Diff preview]({{ '/screenshots/ui-en-02-install.png' | relative_url }})

## 2. Hard-Link Preflight: File Systems That Cannot Promise Safe Writes Are Refused

Safe publication depends on **hard links**: a complete temporary file is linked into place without replacing a newly created destination. Before that, exact pre-write bytes are durably stored as content-addressed blobs; the displaced file itself is retained to capture writes made through old open handles.

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

![Blocked switch with overwrite option]({{ '/screenshots/ui-en-03-blocked.png' | relative_url }})
![Inspect your hand edit]({{ '/screenshots/ui-en-03b-see-edit.png' | relative_url }})

## 5. Reversible Transactions, Displaced Files & Crash Recovery (`src/engine.mjs`)

All state and backups live in `$RECIPE_SWITCH_HOME` (default `~/.recipe-switch`):
- `state.json` — per-target operation stack (`install` and `switch` records with full unit before/after snapshots).
- `backups/<op-id>/` — `index.json` references to exact pre-write bytes in content-addressed blobs, SHA-256 digests, and displaced old files.
- `pending.json` — durable write-ahead compensation journal.

Before mutating any target file:
1. A file lock serializes operations across concurrent CLI invocations and UI requests.
2. Canonical path checks (`assertBoundary`) verify that no symlink or Windows junction redirects any target file outside the harness home directory.
3. Exact pre-write bytes are stored as durable blobs, `backups/<op-id>/index.json` records their references, and `pending.json` is flushed to disk.
4. **Each affected file path retains at most its latest displaced version.** On the same volume, the old inode moves to `backups/<op-id>/`; across volumes, it remains beside the target and its path appears in the backup metadata and result. Both follow the same retirement rules: the next related committed operation (including `uninstall`) reads and retires the prior carrier, first saving changed bytes as a later-version blob. The cutoff is **that one read when the tool's next operation retires the old version**, not the end of the operation. Writes through an old open handle after that read are not guaranteed to survive. Uninstall can itself create a new latest carrier.
5. If an error or crash interrupts a multi-file write before `state.json` commits, the next operation that loads state runs `store.recover()` to restore pre-operation bytes. If recovery cannot finish, `pending.json` stays in place and CLI/API/UI report the current and expected content fingerprints, backup location and recovery steps. Preserve the current file before restoring from backup or retrying with hard-link support restored.

<div class="note warn" markdown="1">
**Known recovery race:** when hard links are unavailable and recovery falls back to rename, a target externally recreated between the “target absent” check and `rename` will be overwritten. This check and rename are not atomic; stop other writers before recovery. Ordinary drift blocking does not cover this interval.
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
- **Private storage before payload.** The state root, state/pending journals, blobs, operation backups, probe records and temporary files are secured before writing. Windows uses `icacls` to remove inheritance and other accounts' explicit grants, including pre-existing Everyone/Users grants; existing SYSTEM and Administrators grants may remain for maintenance and recovery. POSIX directories use `0700` and files `0600`, including existing files. Failure stops writing. Empty replacement targets receive the original DACL (Windows) or owner/group and mode (POSIX) before payload, so replacing a private config cannot expose an unchanged API key. Recovery without a permission source uses private permissions instead of wider parent inheritance.
- **Harness authorization is separate.** Models, providers, credentials and authorization settings are not changed. The OpenClaw conversation-access key is an explicit UI opt-in, restored on uninstall; an existing `false` is never overridden, even by `--force`.
- **Tiny footprint.** Only existing files that will be modified in place get a content snapshot (files that did not exist are recorded as "originally absent"), and identical content is stored once by SHA-256 — never duplicated.

![Original backup and dated restore action]({{ '/screenshots/ui-en-16-originals.png' | relative_url }})
