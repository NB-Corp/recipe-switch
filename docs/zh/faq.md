---
title: "常见问题（FAQ）— 怎么给 Claude Code / Codex / Kimi Code 换系统提示词与回滚 — recipe-switch"
description: "recipe-switch 常见问题解答：怎么给 Claude Code 换系统提示词、Codex AGENTS.md 与 model_instructions_file 的区别、怎么给 Kimi Code 换系统提示词、硬链接拒绝、按安装周期计的原始备份、Hermes 能力状态，以及手动改过文件怎么办。"
layout: doc
page_id: faq
h1: 常见问题（FAQ）
kicker: FAQ
---

### 怎么给 Claude Code 换系统提示词（how to change Claude Code system prompt），而且不改乱 `settings.json`？

Claude Code 支持在启动时通过命令行参数追加系统提示词文件并加载本地插件目录。当你运行 `recipe-switch install claude <recipe> --yes` 时，`recipe-switch` **完全不碰 `~/.claude/settings.json` 和你的 `CLAUDE.md`**，而是把提示词和 hook 插件写进独立的 `~/.claude/recipe-switch/` 目录，并输出一条启动命令：

```sh
claude --append-system-prompt-file "~/.claude/recipe-switch/main.md" --plugin-dir "~/.claude/recipe-switch/plugin"
```

你可以把这条命令设成 shell alias。以后用 `recipe-switch` 切换其他配方或调整选项开关时，它会直接原地更新 `~/.claude/recipe-switch/` 下的文件，同一条启动命令即可直接加载新配方，同时完整支持用户、子代理和任务结果的每轮提醒（steering）。

### OpenAI Codex 的 `AGENTS.md` 和 `config.toml` 里的 `model_instructions_file` 有什么区别？

在 OpenAI Codex 中，`AGENTS.md` 通常用于存放与具体代码仓库或目录绑定的项目级规则；而 `~/.codex/config.toml` 中的 `model_instructions_file` 则是全局的基础指令入口。

`recipe-switch` 会将配方写入 `~/.codex/prompts/recipe-switch/{main,sub}.md`，并在 `~/.codex/config.toml` 中设置单行 `model_instructions_file = ".../prompts/recipe-switch/main.md" # managed by recipe-switch`。这样你的全局工作方式（怎么思考、怎么验证、怎么沟通）由 `recipe-switch` 统一管理切换，而各个项目仓库里的 `AGENTS.md` 依然各司其职、互不冲突。

### 怎么给 Kimi Code 换系统提示词和每轮提醒？

Kimi Code CLI 从 `~/.kimi-code/SYSTEM.md` 读取系统提示词，并从 `~/.kimi-code/plugins/installed.json` 加载插件。执行 `recipe-switch install kimi-code <recipe> --yes` 后，工具会做两件事：
1. 生成带 `<!-- managed by recipe-switch -->` 标记的 `~/.kimi-code/SYSTEM.md`，文件开头写上 `${base_prompt}`（保留 Kimi Code 内置的核心系统提示词），紧接着拼上配方的 Main 提示词。
2. 在 `~/.kimi-code/plugins/managed/recipe-switch/` 下安装受管插件并注册到 `installed.json`，在每次 `UserPromptSubmit` 时自动注入用户回合提醒（`userSteer`）。

如果你原本就有自己手写的 `SYSTEM.md`，`recipe-switch` 会自动拦截并提醒你先处理，绝不会静默覆盖你的文件。

### 怎么回滚配方？怎么恢复到安装 `recipe-switch` 之前的状态？

取决于你想退到哪一步，有三种现成的方式：

1. **撤回上一步（回到上一份配方）**：
   ```sh
   node bin/recipe-switch.mjs rollback <harness> --yes
   ```
   （对应 Web 面板中的**"撤回上一步"**按钮。）
2. **还原 / 卸载（撤销全部操作栈）**：
   ```sh
   node bin/recipe-switch.mjs uninstall <harness> --yes
   ```
   （对应 Web 面板中的**"还原"**按钮，会逐字节恢复被修改的配置片段并删掉新建的空目录。）
3. **原始备份 / 恢复到装之前**：
   ```sh
   node bin/recipe-switch.mjs originals <harness>
   node bin/recipe-switch.mjs restore-original <harness> --yes
   ```
   （对应 Web 面板中的**"原始备份 / 恢复到装之前"**，无论中间切换过多少次或做过强制覆盖，都能直接恢复到当前安装周期开始时的初始快照。）

### 什么情况下 `recipe-switch` 会直接拒绝安装？

有两种情况会在写入任何东西之前就停下：
- **文件系统不支持硬链接。** 预览阶段会探测目标目录，FAT/exFAT 分区和部分网络盘会探测失败，操作被阻断并说明"无法保证安全写入"。请把工具目录挪到 NTFS/APFS/ext4 之类的文件系统再试。
- **你显式拒绝过某项权限。** 对 OpenClaw 而言，`openclaw.json` 里已有的 `allowConversationAccess: false`、`allowPromptInjection: false`、`plugins.enabled: false` 或 `plugins.deny` 条目会被直接尊重——即便传 `--force` 也绝不覆盖。

### 原始备份和每次操作的备份会占很多磁盘空间吗？被替换下来的旧文件放哪了？

**占用空间很小：只存被改动文件的原样一份，相同内容去重。**
- **原始备份按"安装周期"计**：每次从未安装状态装上时拍一份快照，周期内不覆盖。完全卸载或"恢复到装之前"后周期结束，快照退役，不再被引用的备份内容立即释放。只有会被原地修改的已有文件才存快照，内容按 SHA-256 去重。
- **被替换下来的旧版本只保留到下一次操作**：每个工具最多保留最近一次被替换下来的旧版本。到下一次操作时，内容已经进入备份库的直接删除；内容有变化的（说明之后有人写过）先存进新备份再删。跨卷时旧文件留在原文件旁边，卸载不会自动删除，由你自己清理。注意限制：在那次操作之后仍通过旧的、保持打开的文件句柄写入的内容不保证保存。

### 装上配方后，我又手动改了提示词或配置文件，会发生什么？

`recipe-switch` 对它托管的每一个文件、每一行 TOML 键值、每一个 JSON 键/数组项和 YAML 列表项都记录了指纹。只要你手动修改过这些受管内容（或删掉了 `# managed by recipe-switch` 注释），运行 `status` 或打开 Web 面板就会看到 **"有手改（Edited）"** 标记。

此时无论你点切换、撤回还是还原，程序都会**自动停下拦截**，保护你的手改内容不被冲掉。你可以先把自己的修改移走；或者点击 **"仍然覆盖（先备份）"**（CLI 加 `--force`）——程序会在覆盖前先把你的手改版本完整备份到 `~/.recipe-switch/backups/<op-id>/`，并在结果里告诉你备份文件的具体路径。

### `recipe-switch` 会改我的模型、API Key、Provider 或 MCP 配置吗？

**绝不会。** `recipe-switch` 只写提示词文件和挂载它们所需的最小配置项，绝不触碰模型选择、provider 地址、登录凭据、MCP 服务或角色定义。而且在 CLI 和 UI 展示 diff 预览时，配置文件中相邻行里形如 `Authorization`、`api_key`、`token`、`password`、`cookie`、`Bearer` 的值都会自动做 `[redacted]` 脱敏显示。

### 备份目录别人能读到吗？

不能。状态与备份目录（`~/.recipe-switch`）只有当前用户可读：Windows 下用 `icacls` 收紧权限；POSIX 系统下目录强制 `0700`、文件强制 `0600`。

### 为什么 OpenClaw 里有一个"授予 recipe-switch 插件对话访问权限"开关？

OpenClaw 的安全策略规定，非内置插件必须在 `openclaw.json` 中具备 `plugins.entries.recipe-switch.hooks.allowConversationAccess = true` 权限，其 `before_prompt_build` 钩子才会生效。
- **默认不授予**：`recipe-switch` 保持该字段未设置，并在预览说明里提示你钩子会保持非激活状态；不会背着你写任何权限；
- 如果你使用 Web 面板，可以在工具设置里主动勾选**"授予 recipe-switch 插件对话访问权限"**，明确授权工具写入该键值（卸载时会自动还原）；
- 如果你的 `openclaw.json` 里原本显式写了 `allowConversationAccess: false`、`allowPromptInjection: false`、`plugins.enabled: false` 或把插件写进了 `plugins.deny`，安装会被**直接阻断**——即便传 `--force` 也绝不越权覆盖，需你先手动修改。

### 为什么 Hermes 显示"未知：请启动一次 Hermes"，或只装了每轮提醒？

安装前，`recipe-switch` 使用 Python（`python` 或 `py -3`）对宿主源码做 AST 解析，绝不执行宿主代码。`PluginContext` 必须直接定义未被装饰、未被同名赋值遮蔽的 `register_middleware` 方法。
- 满足静态条件时，同时安装 `llm_request` 中间件（完整主/子代理提示词）与 `pre_llm_call` 钩子（每轮提醒）；
- Python 不可用、解析失败或静态信号缺失时，只安装每轮提醒，界面显示**主/子代理不可用**。先查看原因，按需配置 Python 或升级 Hermes，再重新安装。

满足静态条件的宿主，再按运行时回报显示其余三态之一：**已确认生效**（请求已经过中间件）、**已注册，尚未见到请求**、或**未知：请启动一次 Hermes**（尚无有效的运行时回报）。静态检查通过不等于已经生效。Hermes 的原生 `codex_app_server`、辅助调用和最大轮次总结不经过中间件。

### 原始快照上的"重建版本"标记是什么意思？

原始快照按安装周期计：从未安装状态装上时拍一份，直到卸载或恢复到装之前为止。从**旧版 `recipe-switch` 升级**过来的安装会自动用已有记录补齐快照；拿不到完整原文时，快照会被标为**"重建版本"**，恢复前需要额外确认。如果工具当前已经处于装之前的状态，恢复按钮会直接禁用。

### 为什么 Gemini CLI、Cursor 和 Qoder 显示在"暂不支持"里？

`recipe-switch` 只在确认了安全、文件级的全局指令入口或插件契约后才会写入：
- **Gemini CLI**：目前外部资料仅确认了项目级的 `GEMINI.md`，尚无原生源码核实全局指令槽位或扩展契约。
- **Cursor**：全局用户规则存在应用内部设置数据库里，而 `.cursor/rules` 文件只按项目生效，没有合适的文件级全局写入点。
- **Qoder**：从 Ponytail 已知插件清单与 hook 路径，但本仓库尚未内置对应的源码核验与适配器。
