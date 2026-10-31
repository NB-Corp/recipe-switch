---
title: "安全模型、备份与回滚 — recipe-switch 中文文档"
description: "了解 recipe-switch 如何保护你的本地 AI 编程工具配置：写入前 Diff 预览、敏感凭据脱敏、硬链接预检拒绝、带标记的最小受管单元、手改指纹拦截、可逆事务恢复，以及按安装周期管理的原始备份。"
layout: doc
page_id: safety
h1: 安全模型、备份与回滚
kicker: 参考
---

`recipe-switch` 操作的是你每天写代码都要用的工具目录（`~/.codex`、`~/.claude`、`~/.kiki`、`~/.pi`、`~/.dsh`、`~/.kimi-code` 等）。它会先预览写入、备份精确字节，检测到手改时，除非你明确确认覆盖，否则会阻断。回滚恢复受管源码跨度，原始快照恢复保存的完整文件。下方事务说明列出了恢复竞态和旧句柄写入的保留截止点。

## 1. 每次写入前先看 Diff 预览

所有改动磁盘的命令（`install`、`switch`、`rollback`、`uninstall`、`restore-original`）都会先生成一份完整的执行计划：
- 在命令行中，不加 `--yes` 时默认只打印逐文件 unified diff（包含 `+`/`-` 行数统计、`CREATE`/`MODIFY`/`DELETE` 动作，以及换行符和末尾空行的变化），绝不写盘。
- 在 Web 面板中，底部抽屉会随着你勾选配方选项实时刷新每个文件的 diff。
- **敏感信息自动脱敏**：在展示 diff 时，任何形如 `Authorization`、`Proxy-Authorization`、`x-api-key`、`api_key`、`cookie`、`set-cookie`、`auth`、`*token`、`*secret`、`*password` 或 `Bearer ...` 的键值都会被替换为 `"[redacted]"`，防止截图或录屏时泄露密钥；而底层的 SHA-256 完整性校验始终比对真实字节。
- **过期预览拦截**：当你点击"确认写入"或带 `--yes` 执行时，引擎会再次核对所有目标文件的当前字节指纹。如果预览生成后文件在外部被改过，写入会立刻中止。

![Diff 预览]({{ '/screenshots/ui-07-install-preview.png' | relative_url }})

## 2. 硬链接预检：无法保证安全写入的位置会被直接拒绝

安全发布依赖**硬链接**：将已经写完整的临时文件链接到目标位置，且不会替换外部刚创建的新文件。在此之前，写入前的精确字节已持久化为按内容去重的 blob；被替换文件本身也会保留，以接住旧打开句柄上的后续写入。

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

![检测到手改时自动拦截并提供先备份覆盖按钮]({{ '/screenshots/ui-12-blocked.png' | relative_url }})
![查看你的改动]({{ '/screenshots/ui-13-see-edit.png' | relative_url }})

## 5. 可逆事务、被替换旧文件与崩溃恢复（`src/engine.mjs`）

所有状态与备份默认保存在 `$RECIPE_SWITCH_HOME`（`~/.recipe-switch`）：
- `state.json` — 按工具目标记录的操作栈（每次 `install` / `switch` 的完整前后快照）。
- `backups/<op-id>/` — `index.json` 记录操作前精确字节对应的 blob 引用与 SHA-256；目录内也会保留被替换下来的旧文件。
- `pending.json` — 持久化的预写式补偿日志（write-ahead compensation journal）。

在真正写目标文件之前：
1. 进程间文件锁保证 CLI 与 Web UI 请求严格串行。
2. 真实规范路径检查（`assertBoundary`）确保没有任何符号链接或 Windows junction 能把写入导向工具目录之外。
3. 先将操作前的精确字节持久化为 blob，在 `backups/<op-id>/index.json` 记录引用，再将恢复信息刷入 `pending.json`。
4. **每个受影响文件路径最多保留最近一次被替换的旧版本。** 同卷时，旧 inode 移进 `backups/<op-id>/`；跨卷时留在目标旁边，路径写进备份记录和操作结果。两种载体遵循同一套退休规则：下一次相关操作提交后（包括 `uninstall`）读取并退休旧载体，字节有变化时先存成“后来写入的版本”blob。截止点是**该工具下一次操作退休旧版本时的那一次读取**，不是整次操作结束；读取之后通过旧打开句柄写入的内容不保证保存。卸载本身也可能产生一份新的最近载体。
5. 多文件写入在 `state.json` 提交前出错或崩溃时，下一次读取状态的操作会执行 `store.recover()`，恢复操作前的字节。如果无法完成，`pending.json` 会保留，CLI/API/UI 会显示当前内容与期望内容的指纹、备份位置和恢复步骤。请先保留当前文件，再从备份恢复，或恢复硬链接能力后重试。

<div class="note warn" markdown="1">
**已知恢复竞态：** 如果硬链接不可用而恢复回退到 rename，在“检查目标不存在”和“rename”之间被外部重新创建的目标会被覆盖。检查与重命名不是原子操作；恢复前请停止其他写入者。常规手改拦截无法保护这个时间窗口。
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
- **写入正文前先落实私有权限。** 状态根目录、state/pending 日志、blobs、操作备份、probe 记录及临时文件都会先收紧权限。Windows 用 `icacls` 去掉继承和其他账户的显式授权，包括已有 Everyone/Users 授权；已有 SYSTEM 与 Administrators 授权可保留，供系统维护和恢复。POSIX 目录用 `0700`、文件用 `0600`，已有文件同样收紧；失败就拒绝写入。空替换文件会先取得原目标的 DACL（Windows）或属主/组与 mode（POSIX），避免私有配置中未改动的 API key 因替换而暴露。恢复时若已没有权限来源，使用私有权限，而不继承较宽的父目录权限。
- **工具授权与文件权限分别处理。** 不修改模型、provider、凭据和授权设置。OpenClaw 对话访问键只在 UI 明确勾选后写入，卸载时还原；已有 `false` 即便 `--force` 也不会覆盖。
- **占用空间很小。** 原始备份只给会被原地修改的已有文件存快照（原来不存在的文件只记一笔"原来不存在"），且文件内容按 SHA-256 去重——相同内容只存一份。

![原始备份与带日期的恢复按钮]({{ '/screenshots/ui-16-originals.png' | relative_url }})
