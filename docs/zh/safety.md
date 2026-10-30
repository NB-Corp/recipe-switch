---
title: "安全模型、备份与回滚 — recipe-switch 中文文档"
description: "了解 recipe-switch 如何保护你的本地 AI 编程工具配置：写入前 Diff 预览、敏感凭据脱敏、硬链接预检拒绝、带标记的最小受管单元、手改指纹拦截、可逆事务恢复，以及按安装周期管理的原始备份。"
layout: doc
page_id: safety
h1: 安全模型、备份与回滚
kicker: 参考
---

`recipe-switch` 操作的是你每天写代码都要用的工具目录（`~/.codex`、`~/.claude`、`~/.kiki`、`~/.pi`、`~/.dsh`、`~/.kimi-code` 等）。它的核心工程原则是：**没有任何一次写入是暗箱操作，没有任何一行手动修改会被悄悄冲掉，任何时候都能逐字节回到从前。**

## 1. 每次写入前先看 Diff 预览

所有改动磁盘的命令（`install`、`switch`、`rollback`、`uninstall`、`restore-original`）都会先生成一份完整的执行计划：
- 在命令行中，不加 `--yes` 时默认只打印逐文件 unified diff（包含 `+`/`-` 行数统计、`CREATE`/`MODIFY`/`DELETE` 动作，以及换行符和末尾空行的变化），绝不写盘。
- 在 Web 面板中，底部抽屉会随着你勾选配方选项实时刷新每个文件的 diff。
- **敏感信息自动脱敏**：在展示 diff 时，任何形如 `Authorization`、`Proxy-Authorization`、`x-api-key`、`api_key`、`cookie`、`set-cookie`、`auth`、`*token`、`*secret`、`*password` 或 `Bearer ...` 的键值都会被替换为 `"[redacted]"`，防止截图或录屏时泄露密钥；而底层的 SHA-256 完整性校验始终比对真实字节。
- **过期预览拦截**：当你点击"确认写入"或带 `--yes` 执行时，引擎会再次核对所有目标文件的当前字节指纹。如果预览生成后文件在外部被改过，写入会立刻中止。

![Diff 预览]({{ '/screenshots/03-diff-preview.png' | relative_url }})

## 2. 硬链接预检：无法保证安全写入的位置会被直接拒绝

下面的崩溃恢复与逐字节还原保证都建立在**硬链接**之上：写入前的备份与原始快照都以原子硬链接方式捕获，备份内容不可能出现"拷到一半"的残缺状态。

在预览阶段，`recipe-switch` 会探测目标目录。**如果文件系统不支持硬链接（常见于 FAT/exFAT 分区、部分网络盘），操作会被直接阻断**，并明确说明"无法保证安全写入"。请把工具目录（或 `RECIPE_SWITCH_HOME`）移到支持硬链接的文件系统（如 NTFS、APFS、ext4）再试。

## 3. 最小化、带标记的受管单元（`src/units.mjs`）

为了改一个配置项而把整个 JSON/TOML/YAML 重新序列化，很容易弄丢你的注释、缩进或转义字符。`recipe-switch` 把每次改动拆成细粒度的**受管单元（managed units）**：

| 单元类型 | 托管范围 | 卸载 / 还原时的恢复方式 |
| --- | --- | --- |
| `file` | `recipe-switch` 专属目录下的完整文件（及 Kimi Code 带标记的 `SYSTEM.md`） | 恢复写入前的精确字节；若原本不存在则删除文件并清理新建的空目录 |
| `tomlKey` | TOML 表中带 `# managed by recipe-switch` 尾注的单行键值（如 Codex 与 Kiki 的 `config.toml`） | 恢复原本的那一行，或仅删掉该受管行，文件其余部分纹丝不动 |
| `jsonArrayItem` | JSON 数组中的单个字符串元素（如 `opencode.json` 的 `instructions`、`openclaw.json` 的 `plugins.allow`、DSH 的 `bundles`） | 按记录的原始源码跨度（`jsonSpans`）精确恢复空白与缩进；仅当数组及父对象是由本工具新建且变空时才一并移除 |
| `jsonKey` | JSON 对象中的单个属性（如 OpenClaw 的 `enabled`、DSH 的 `dependencies`） | 按写入前捕获的词法跨度恢复或移除新建键 |
| `jsonArrayRecord` | JSON 数组中按 `"id": "recipe-switch"` 匹配的单个对象（Kimi Code 的 `installed.json`） | 恢复原对象的原始文本跨度或移除该条记录 |
| `yamlArrayItem` | Hermes `config.yaml` 中 `plugins.enabled` 列表下的单个条目（`- recipe-switch`） | 应用精确的 `yamlPatch` 词法补丁或移除该项，保留周围注释与键 |

## 4. 手动修改检测（Drift）与外部冲突拦截

每次写入后，`recipe-switch` 都会记录每个受管单元的指纹。

- **手改识别**：如果你事后用编辑器手动改过 `main.md`、`recipe.json`，或者改掉了 `config.toml` 里的 `# managed by recipe-switch` 行，`status` 命令和 UI 卡片会立刻标出 **"有手改（Edited）"**。
- **操作自动停机**：存在手改时，执行 `switch`、`rollback` 或 `uninstall` 都会**停下来报错拦截**，绝不悄悄覆盖你手写的改动。
- **先备份再强制覆盖**：你可以先把自己的修改移到别处，也可以点击 UI 上的 **"仍然覆盖（先备份）"**（或 CLI 加 `--force`）。强制覆盖会在动文件之前，先把你当前的**手改版本完整备份**到 `~/.recipe-switch/backups/<op-id>/`，并在结果界面显示保存路径。
- **外部安装器保护**：如果目标位置已有非本工具创建的文件，或者已经用 `gpt-with-taste` 独立安装脚本装过（Codex 安装回执、Pi 独立扩展包、DSH `dsh-gpt-with-taste` bundle、或非托管的 Kimi `SYSTEM.md`），同样会拦截提醒，防止两套插件重复注入。

![工具卡片上的有手改提示]({{ '/screenshots/14-drift-card.png' | relative_url }})
![检测到手改时自动拦截并提供先备份覆盖按钮]({{ '/screenshots/13-blocked.png' | relative_url }})

## 5. 可逆事务、被替换旧文件与崩溃恢复（`src/engine.mjs`）

所有状态与备份默认保存在 `$RECIPE_SWITCH_HOME`（`~/.recipe-switch`）：
- `state.json` — 按工具目标记录的操作栈（每次 `install` / `switch` 的完整前后快照）。
- `backups/<op-id>/` — 每次操作前受影响文件的完整字节副本、被替换下来的旧文件，以及带 SHA-256 的 `index.json`。
- `pending.json` — 持久化的预写式补偿日志（write-ahead compensation journal）。

在真正写目标文件之前：
1. 进程间文件锁保证 CLI 与 Web UI 请求严格串行。
2. 真实规范路径检查（`assertBoundary`）确保没有任何符号链接或 Windows junction 能把写入导向工具目录之外。
3. 先写好 `backups/<op-id>/` 并将恢复信息刷入 `pending.json`。
4. **被替换下来的旧版本只保留到下一次操作。** 同卷替换时，被替换下来的旧文件会移进本次操作的备份目录（`backups/<op-id>/`）；**每个工具最多保留最近一次被替换下来的旧版本**：到下一次操作时，内容已经进入备份库的直接删除；内容不同的（说明之后有人写过），先存进新的备份再删。如果状态目录与目标文件不在同一个卷，旧文件就留在原文件旁边，路径写进备份记录和操作结果，卸载时不会自动删除，由用户自己清理。
5. 如果在多文件写入中途遭遇断电或进程崩溃，下一次运行任何 `recipe-switch` 命令时都会自动执行 `store.recover()`，将半途写入的文件精确回滚到操作前的字节。（如果崩溃后你又手动编辑了该文件，恢复逻辑会保留你的手动修改，并打印备份路径交由你决定。）

<div class="note warn" markdown="1">
**限制**：被替换的版本只保留到该工具的下一次操作；在那之后仍通过旧的、保持打开的文件句柄写入的内容不保证保存。
</div>

## 6. 撤回上一步 vs. 还原 vs. 原始状态备份

`recipe-switch` 提供三种不同粒度的回退方式：

| 操作 | CLI 命令 | UI 按钮 | 行为说明 |
| --- | --- | --- | --- |
| **撤回上一步** | `recipe-switch rollback <harness> [--yes]` | **撤回上一步** | 弹出操作栈顶的最近一次操作，回到上一份配方（若栈里只有一次安装，则回到初始状态）。 |
| **还原（卸载）** | `recipe-switch uninstall <harness> [--yes]` | **还原** | 逆序撤销该工具栈上的全部操作，恢复原始文件字节与源码跨度，并清理新建的空目录。 |
| **原始备份 / 恢复到装之前** | `recipe-switch originals <harness>`<br>`recipe-switch restore-original <harness> [--yes]` | **原始备份 / 恢复到装之前** | 查看或直接恢复当前安装周期开始时拍下的初始快照——无论中间经历过多少次切换或强制覆盖，都能一键回到装之前的模样。 |

### 原始备份按"安装周期"计

- **每个周期只拍一次快照。** 每次从未安装状态装上时，`recipe-switch` 为即将修改的文件拍一份基线快照；此后**周期内不再覆盖**，无论中间切换多少次或强制覆盖多少次。UI 中恢复按钮旁会直接显示快照日期。
- **周期结束即退役。** 完全卸载、或执行"恢复到装之前"后，该周期结束，快照随之退役；不再被任何记录引用的备份内容会立即释放。下次安装重新开周期、重新拍快照。
- **从旧版本升级自动补齐。** 从旧版 `recipe-switch` 升级过来的安装，会自动用已有记录补齐快照；拿不到完整原文时，快照会被标为**"重建版本"**，恢复前需要额外确认。
- **已经是装之前的状态时**，恢复按钮会直接禁用——没有可回退的内容。
- **备份目录只有当前用户可读。** Windows 下用 `icacls` 收紧目录权限；POSIX 系统下目录强制 `0700`、文件强制 `0600`。
- **占用空间很小。** 原始备份只给会被原地修改的已有文件存快照（原来不存在的文件只记一笔"原来不存在"），且文件内容按 SHA-256 去重——相同内容只存一份。

![撤回上一步预览]({{ '/screenshots/08-rollback-preview.png' | relative_url }})
![还原预览]({{ '/screenshots/09-uninstall-preview.png' | relative_url }})
