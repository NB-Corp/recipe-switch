---
title: "常见问题（FAQ）— 怎么给 Claude Code / Codex / Kimi Code 换系统提示词与回滚 — recipe-switch"
description: "recipe-switch 常见问题解答：怎么给 Claude Code 换系统提示词、Codex AGENTS.md 与 model_instructions_file 的区别、怎么给 Kimi Code 换系统提示词、怎么回滚到安装前状态，以及手动改过文件怎么办。"
---

# 常见问题（FAQ）

[首页](index.md) · [快速开始](getting-started.md) · [各工具说明](harnesses.md) · [安全与回滚](safety.md) · [配方与选项格式](recipes.md) · **常见问题 FAQ** · [English](../faq.md)

---

### 怎么给 Claude Code 换系统提示词（how to change Claude Code system prompt），而且不改乱 `settings.json`？

Claude Code 支持在启动时通过命令行参数追加系统提示词文件并加载本地插件目录。当你运行 `recipe-switch install claude <recipe> --yes` 时，`recipe-switch` **完全不碰 `~/.claude/settings.json` 和你的 `CLAUDE.md`**，而是把提示词和 hook 插件写进独立的 `~/.claude/recipe-switch/` 目录，并输出一条启动命令：

```sh
claude --append-system-prompt-file "~/.claude/recipe-switch/main.md" --plugin-dir "~/.claude/recipe-switch/plugin"
```

你可以把这条命令设成 shell alias。以后用 `recipe-switch` 切换其他配方或调整选项开关时，它会直接原地更新 `~/.claude/recipe-switch/` 下的文件，同一条启动命令即可直接加载新配方，同时完整支持用户、子代理和任务结果的每轮提醒（steering）。

---

### OpenAI Codex 的 `AGENTS.md` 和 `config.toml` 里的 `model_instructions_file` 有什么区别？

在 OpenAI Codex 中，`AGENTS.md` 通常用于存放与具体代码仓库或目录绑定的项目级规则；而 `~/.codex/config.toml` 中的 `model_instructions_file` 则是全局的基础指令入口。

`recipe-switch` 会将配方写入 `~/.codex/prompts/recipe-switch/{main,sub}.md`，并在 `~/.codex/config.toml` 中设置单行 `model_instructions_file = ".../prompts/recipe-switch/main.md" # managed by recipe-switch`。这样你的全局工作方式（怎么思考、怎么验证、怎么沟通）由 `recipe-switch` 统一管理切换，而各个项目仓库里的 `AGENTS.md` 依然各司其职、互不冲突。

---

### 怎么给 Kimi Code 换系统提示词和每轮提醒？

Kimi Code CLI 从 `~/.kimi-code/SYSTEM.md` 读取系统提示词，并从 `~/.kimi-code/plugins/installed.json` 加载插件。执行 `recipe-switch install kimi-code <recipe> --yes` 后，工具会做两件事：
1. 生成带 `<!-- managed by recipe-switch -->` 标记的 `~/.kimi-code/SYSTEM.md`，文件开头写上 `${base_prompt}`（保留 Kimi Code 内置的核心系统提示词），紧接着拼上配方的 Main 提示词。
2. 在 `~/.kimi-code/plugins/managed/recipe-switch/` 下安装受管插件并注册到 `installed.json`，在每次 `UserPromptSubmit` 时自动注入用户回合提醒（`userSteer`）。

如果你原本就有自己手写的 `SYSTEM.md`，`recipe-switch` 会自动拦截并提醒你先处理，绝不会静默覆盖你的文件。

---

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
   （对应 Web 面板中的**"原始备份 / 恢复到装之前"**，无论中间切换过多少次或做过强制覆盖，都能直接恢复到第一次安装前的初始状态。）

---

### 原始备份和每次操作的备份会占很多磁盘空间吗？被替换下来的旧文件放哪了？

**占用空间很小：只存被改动文件的原样一份，相同内容去重。**
- **原始备份（`originals` / `restore-original`）**：只在第一次写入时记录。只给会被原地修改的已有文件存快照，原来不存在的文件只记一笔"原来不存在"。内容按 `sha256` 存一份，相同的内容不重复存。只有当某个工具恢复到装之前、并且完全卸载以后，才会释放已经没人用的内容。
- **被替换下来的旧文件**：同一磁盘卷时，会移进本次操作的备份目录（`~/.recipe-switch/backups/<op-id>/`）。如果 `recipe-switch` 的状态目录和目标文件不在同一个卷，旧文件就留在原文件旁边，路径写进备份记录和操作结果；卸载时不会自动删除，由你自己清理。

---

### 装上配方后，我又手动改了提示词或配置文件，会发生什么？

`recipe-switch` 对它托管的每一个文件、每一行 TOML 键值、每一个 JSON 键/数组项和 YAML 列表项都记录了指纹。只要你手动修改过这些受管内容（或删掉了 `# managed by recipe-switch` 注释），运行 `status` 或打开 Web 面板就会看到 **"有手改（Edited）"** 标记。

此时无论你点切换、撤回还是还原，程序都会**自动停下拦截**，保护你的手改内容不被冲掉。你可以先把自己的修改移走；或者点击 **"仍然覆盖（先备份）"**（CLI 加 `--force`）——程序会在覆盖前先把你的手改版本完整备份到 `~/.recipe-switch/backups/<op-id>/`，并在结果里告诉你备份文件的具体路径。

---

### `recipe-switch` 会改我的模型、API Key、Provider 或 MCP 配置吗？

**绝不会。** `recipe-switch` 只写提示词文件和挂载它们所需的最小配置项，绝不触碰模型选择、provider 地址、登录凭据、MCP 服务或角色定义。而且在 CLI 和 UI 展示 diff 预览时，配置文件中相邻行里形如 `Authorization`、`api_key`、`token`、`password`、`cookie`、`Bearer` 的值都会自动做 `[redacted]` 脱敏显示。

---

### 为什么 OpenClaw 里有一个"授予 recipe-switch 插件对话访问权限"开关？

OpenClaw 的安全策略规定，非内置插件必须在 `openclaw.json` 中具备 `plugins.entries.recipe-switch.hooks.allowConversationAccess = true` 权限，其 `before_prompt_build` 钩子才会生效。
- 默认情况下，`recipe-switch` **不会**替你修改权限，而是保持该字段未设置，并在预览说明里提示你；
- 如果你使用 Web 面板，可以在工具设置里主动勾选**"授予 recipe-switch 插件对话访问权限"**，明确授权工具写入该键值（卸载时会自动还原）；
- 如果你的 `openclaw.json` 里原本显式写了 `allowConversationAccess: false`、`allowPromptInjection: false`、`plugins.enabled: false` 或把插件写进了 `plugins.deny`，即便传 `--force` 也绝不会越权覆盖，需你先手动修改。

---

### 为什么 Hermes 显示 `Main/Sub unavailable（不可用）; per-turn steering via pre_llm_call only`？

`recipe-switch` 在安装前会用 Python（`python` 或 `py -3`）对宿主源码做 AST 解析，不执行宿主代码。必须同时确认两件事：
1. `PluginContext`（包括同模块内继承的父类）真的定义了 `register_middleware`；
2. 请求路径（`run_agent.py` 以及 `agent/` 下的相关文件）里确实会调度 `llm_request`。

如果本机没有 Python、AST 解析失败，或者两件事缺任何一件，都只安装每轮提醒（steering）。主/子代理系统提示要等 Hermes 升级后才生效，降级原因会直接显示在总览（`status`）、UI 和预览里。另外请注意，Hermes 的原生 `codex_app_server`、辅助调用（auxiliary）和最大轮次总结（max-iteration summary）不经过插件。

---

### 为什么 Gemini CLI、Cursor 和 Qoder 显示在"暂不支持"里？

`recipe-switch` 只在确认了安全、文件级的全局指令入口或插件契约后才会写入：
- **Gemini CLI**：目前外部资料仅确认了项目级的 `GEMINI.md`，尚无原生源码核实全局指令槽位或扩展契约。
- **Cursor**：全局用户规则存在应用内部设置数据库里，而 `.cursor/rules` 文件只按项目生效，没有合适的文件级全局写入点。
- **Qoder**：从 Ponytail 已知插件清单与 hook 路径，但本仓库尚未内置对应的源码核验与适配器。
