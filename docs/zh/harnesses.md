---
title: "各工具写入点与限制说明 — recipe-switch 中文文档"
description: "详细拆解 recipe-switch 在 OpenAI Codex、Claude Code、Kiki、Pi、DeepSeek Harness、OMP、Grok Build、OpenCode、Kimi Code、Hermes Agent 与 OpenClaw 中的写入文件、配置键与运行机制。"
layout: doc
page_id: harnesses
h1: 各工具写入点与限制说明
kicker: 参考
---
`recipe-switch` 针对每款 AI 编程工具（harness）原生的配置入口或插件机制做了专门适配（源码见 `src/drivers/`），绝不粗暴覆盖整个配置目录。

支持的 11 款工具按实现机制分为三类：
1. **原生文件与配置键挂载**（`src/drivers/native.mjs`）：**Codex**、**Claude Code**、**Kiki**、**Oh My Pi (OMP)**、**Grok Build**、**OpenCode**。
2. **内置快照扩展/Bundle**（`src/drivers/builtin.mjs`）：**Pi**、**DeepSeek Harness (DSH)**。扩展代码只需装一次，后续切换配方仅改写其目录下的 `recipe.json` 快照。
3. **源码核验的原生插件**（`src/drivers/plugins.mjs`）：**Kimi Code CLI**、**Hermes Agent**、**OpenClaw**。

---

## 1. OpenAI Codex (`codex`)

- **默认目录**：`~/.codex`（可用环境变量 `CODEX_HOME` 或 `--home` 覆盖）。
- **写入内容**：
  - `prompts/recipe-switch/main.md`
  - `prompts/recipe-switch/sub.md`
  - `prompts/recipe-switch/recipe.json`（托管元数据标记）
  - 在 `config.toml` 顶层写入单行键：`model_instructions_file = "<main.md 的 POSIX 路径>" # managed by recipe-switch`
- **每轮提醒（Steer）**：`recipe-switch` 本身不注入；由 `gpt-with-taste` 自身的 `--hooks` 插件负责。
- **保护与注意事项**：
  - 如果检测到 `config.toml` 已指向 `prompts/gpt-with-taste/main.md`，或 `gpt-with-taste` 仓库中存在指向该目录的 `.gpt-with-taste/install-receipt.json`，安装会自动拦截，提示你先执行 `gpt-with-taste scripts/install.mjs --restore`（或加 `--force` 强制接管）。
  - 安装或切换后请新开 Codex 会话。`sub.md` 放在磁盘上供角色组合（`developer_instructions`）使用，`recipe-switch` 不会修改你的角色定义。
  - 该入口不支持将主提示词显式设为 `main = "off"` 的配方。

---

## 2. Claude Code (`claude`)

- **默认目录**：`~/.claude`（可用环境变量 `CLAUDE_CONFIG_DIR` 或 `--home` 覆盖）。
- **写入内容**：
  - `recipe-switch/main.md`
  - `recipe-switch/independent.md`（当配方构建产物包含该文件时）
  - `recipe-switch/plugin/`（`gpt-with-taste` 的 Claude Code hook 插件目录）
  - `recipe-switch/recipe.json`
- **不改动的部分**：**绝不修改** `~/.claude/settings.json` 或你的全局 `CLAUDE.md`。
- **启动方式**：安装完成后会给出按会话生效的启动命令：
  ```sh
  claude --append-system-prompt-file "~/.claude/recipe-switch/main.md" --plugin-dir "~/.claude/recipe-switch/plugin"
  ```
- **每轮提醒（Steer）**：通过随附插件的 hooks 注入用户、子代理与结果提醒。后续切换配方会直接原地更新 `recipe-switch/` 下的文件，同一条启动命令或 alias 即可直接生效。

![Claude Code 预览]({{ '/screenshots/19-claude-preview.png' | relative_url }})
![Claude Code 启动命令展示]({{ '/screenshots/20-claude-launch.png' | relative_url }})

---

## 3. Kiki (`kiki`)

- **默认目录**：`~/.kiki`（可用环境变量 `KIKI_HOME` 或 `--home` 覆盖）。
- **必填工具设置**：`--models <alias1,alias2>`（在 Web UI 中会读取 `config.toml` 里的 `[models."<alias>"]` 渲染为"要绑定的模型"多选开关）。
- **写入内容**：
  - 将展开后的配方包完整写入 `recipe-switch/packages/<recipe-id>/`（含 `recipe.toml` 及各槽位文本文件）。
  - 在 `config.toml` 中为你选定的每个 `[models."<alias>"]` 写入单行键：`recipe = "<recipe.toml 路径>" # managed by recipe-switch`。
- **每轮提醒（Steer）**：完整使用 Kiki 原生 Recipe steering（涵盖 `main`、`sub`、`independent` 分支以及 `agent`、`task` 来源）。
- **注意事项**：新绑定立即生效，空闲会话在执行 **Rebuild context** 后生效。撤回或还原时会精准恢复这些模型原本绑定的 `recipe` 值。

![Kiki 模型绑定预览]({{ '/screenshots/10-kiki-preview.png' | relative_url }})

---

## 4. Pi (`pi`)

- **默认目录**：`~/.pi/agent`（可用环境变量 `PI_CODING_AGENT_DIR` 或 `--home` 覆盖）。
- **可选工具设置**：
  - `--providers <p,q>` — 只对指定 provider 生效（逗号分隔，留空表示全部）。
  - `--model-pattern <REGEX>` — 只对匹配该正则表达式的 `model.id` 生效（留空表示全部）。
- **写入内容**：
  - 在 `extensions/recipe-switch/` 下安装内置扩展：`runtime.mjs`、`projection.mjs`、`payload.mjs`、`index.js`（主角色入口）、`sub.js`、`independent.js`、`package.json`、`THIRD_PARTY_LICENSE` 与 `recipe.json`。
- **热切换与会话内命令**：
  - 首次安装扩展后在 Pi 中执行 `/reload` 或新开会话；之后每次用 `recipe-switch` 切换配方都只改写 `extensions/recipe-switch/recipe.json`，Pi 会在下一次请求时自动重读。
  - 在 Pi 会话内还可使用 `/recipe status`、`/recipe on`、`/recipe off`、`/recipe steer on`、`/recipe steer off`、`/recipe reset` 临时查看或开关。
- **冲突拦截**：若 `settings.json` 或 `extensions/` 中已挂载独立的 `gpt-with-taste` Pi 扩展，会自动拦截以免双重注入。

![Pi 已安装状态卡片]({{ '/screenshots/05-pi-installed-card.png' | relative_url }})

---

## 5. DeepSeek Harness (`dsh`)

- **默认目录**：`~/.dsh`（可用环境变量 `DSH_HOME` 覆盖）。工具会自动扫描 `profiles/<name>/package.json`，将**每个 profile 作为独立的安装目标**。当存在多个 profile 时，CLI 需通过 `--home ~/.dsh/profiles/<name>` 指定目标。
- **可选工具设置**：`--root-role main|independent`（根代理角色，默认为 `main`）。
- **写入内容（针对单个 profile）**：
  - 在 `profiles/<p>/.recipe-switch/dsh-recipe-switch/` 与 `profiles/<p>/node_modules/dsh-recipe-switch/` 同时写入内置 Cordis bundle（含 `index.mjs`、`package.json`、`cordis.patch.yml`、`LICENSE`、`recipe.json`；保留 `.recipe-switch/` 源副本是为了防止后续执行 `pnpm install` 时把 `node_modules` 里的包清掉）。
  - 在 `profiles/<p>/package.json` 中写入一项 `dependencies["dsh-recipe-switch"] = "file:.recipe-switch/dsh-recipe-switch"`，并在 `dsh.profile.bundles` 数组中加入 `"dsh-recipe-switch"`。
- **每轮提醒与热切换**：注册 `recipe-switch:behavior` 系统提示词段落，并在 `agent/pre-step` 阶段注入用户、协调器与子代理汇报提醒。切换配方只重写 `recipe.json`，每个 step 前自动重读（首次安装需新开 DSH 进程）。
- **冲突拦截**：若该 profile 已挂载 `dsh-gpt-with-taste` 则拦截；若挂载了 `dsh-kiki-recipe` 则给出非阻塞提示。

![DeepSeek Harness 预览]({{ '/screenshots/11-dsh-preview.png' | relative_url }})

---

## 6. Oh My Pi (`omp`)

- **默认目录**：`~/.omp/agent`（可用环境变量 `OMP_CODING_AGENT_DIR` 或 `--home` 覆盖）。
- **写入内容**：
  - `extensions/recipe-switch/`（写入由 `gpt-with-taste` OMP 适配器渲染的扩展文件及 `recipe.json`）。
- **每轮提醒与说明**：通过适配器注入用户、子代理与任务完成提醒（默认对 `openai` / `openai-codex` 的 `gpt-*` 模型生效）。安装或切换后需重启 OMP。

---

## 7. Grok Build (`grok`)

- **默认目录**：`~/.grok`（可用环境变量 `GROK_HOME` 或 `--home` 覆盖）。
- **写入内容**：
  - 全局规则文件 `rules/recipe-switch.md`，首行带有 `<!-- recipe-switch: <name> <version> (<revision>). Managed file; switch or uninstall with recipe-switch. -->` 标记，后接主提示词正文。
- **每轮提醒与说明**：Grok 的 hooks 无法向模型上下文添加文本，因此仅写入主提示词。`~/.grok/rules/` 下你原有的其他规则文件完全保留并一同加载。

---

## 8. OpenCode (`opencode`)

- **默认目录**：`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`（可用环境变量 `OPENCODE_CONFIG_DIR` 或 `--home` 覆盖）。
- **写入内容**：
  - `recipe-switch/main.md` 与 `recipe-switch/recipe.json`。
  - 在 `opencode.json` 的 `"instructions"` 数组中加入 `recipe-switch/main.md` 的路径。
- **保护与注意事项**：
  - `opencode.json` 必须是标准纯 JSON（如果带注释或 JSONC 语法，会拒绝编辑以免破坏你的文件；如果同目录还存在 `opencode.jsonc`，会提示本工具只编辑 `opencode.json`）。
  - 安装或切换后请重启 OpenCode。

---

## 9. Kimi Code CLI (`kimi-code`)

- **默认目录**：`~/.kimi-code`（可用环境变量 `KIMI_CODE_HOME` 或 `--home` 覆盖）。
- **写入内容**：
  - `SYSTEM.md`（当配方的 Main 启用时）：顶部写 `${base_prompt}`（完整保留 Kimi Code 内置默认主提示词），随后是 `<!-- managed by recipe-switch -->` 标记与配方的 Main 正文。
  - `plugins/managed/recipe-switch/{kimi.plugin.json,steer.mjs,recipe.json}`。
  - 在 `plugins/installed.json` 中确保 `"version": 1`，并在 `"plugins"` 数组中写入 `id: "recipe-switch"` 的插件记录。
- **每轮提醒与注意事项**：
  - `steer.mjs` 监听 `UserPromptSubmit` 事件，在每次用户提交提问时从 `recipe.json` 实时读取并输出用户提醒（`userSteer`）。系统触发的子代理回合不经过该事件，子代理 profile 保持不变。
  - 首次安装或修改 Main 后需重启 Kimi Code。注意项目级 `agent.md`、`--agent-file` 或显式绑定的自定义 agent profile 可能会覆盖默认 `SYSTEM.md`。
- **冲突保护**：当配方启用了 Main 且目录下已有非本工具托管的 `SYSTEM.md` 时，安装会拦截，提示你先把自己的 `SYSTEM.md` 移走（不会擅自合并或覆盖）；如果配方将 Main 设为 `main = "off"`，则完全不碰你原有的 `SYSTEM.md`。

---

## 10. Hermes Agent (`hermes`)

- **默认目录**：Windows 下默认为 `%LOCALAPPDATA%/hermes`，macOS/Linux 下为 `~/.hermes`（可用环境变量 `HERMES_HOME` 或 `--home` 覆盖）。
- **写入内容**：
  - `plugins/recipe-switch/{plugin.yaml,__init__.py,recipe.json}`。
  - 在 `config.yaml` 的 `plugins.enabled` 块级列表中加入 `recipe-switch`。
- **静态能力检查（绝不执行宿主代码）**：
  - 安装前，`recipe-switch` 会对宿主源码（`hermes_cli/plugins.py`、`run_agent.py` 及 `agent/` 下的相关文件）做静态检查，**绝不导入或执行宿主代码**。检查刻意保持简单：只看 `PluginContext` 类里是否**直接定义了 `register_middleware`**。
  - **确认支持时**：同时注册 `llm_request` 中间件与 `pre_llm_call` 钩子。`llm_request` 会将完整的主/子代理系统提示词追加到 `chat_completions`（`system`/`developer` 消息）、`anthropic_messages`（`system` 块）、`codex_responses`（`instructions`）和 `bedrock_converse`（`system` 块，并保持末尾 `cachePoint` 仍在最后以覆盖新增文本）。每个 `session_id` 在首次请求时冻结角色与系统提示词文本，因此切换配方只对新会话生效，不会破坏进行中会话的提示词字节与缓存。
  - **未确认支持时**（没有静态信号，或检查无法执行）：自动从 `plugin.yaml` 移除 `provides_middleware`，**只安装每轮提醒（`pre_llm_call` steering）**。主/子代理系统提示要等 Hermes 升级后才生效，具体的降级原因会直接显示在总览（`status`）、UI 和预览里。
- **运行时能力由插件自报**：插件运行起来之后，会把运行时真实发生的情况回报回来，界面只会显示三种状态之一：
  1. **已确认生效** —— 中间件已经实际运行并注入了提示词；
  2. **已注册，尚未见到请求** —— 安装成功，但还没有 `llm_request` 经过；
  3. **未知：请启动一次 Hermes** —— 还没有任何运行时信号，启动一次 Hermes 让插件回报。
- **已知旁路与限制**：
  - Hermes 内部的 `codex_app_server`、辅助调用（auxiliary calls）与最大轮次总结（max-iteration summary）不经过 `llm_request` 中间件。
  - `SOUL.md` 与 `AGENTS.md` 保持原样不改。
  - 若 `userSteer` 或 `subSteer` 超过 10,000 字符，会提示可能超出 Hermes 默认 hook 输出上限而被转为文件预览。
  - 若 `config.yaml` 的目标键使用了流式 YAML（`[...]`、`{...}`）、锚点，或在 `plugins.disabled` 中禁用了 `recipe-switch`，安装会安全拦截。

---

## 11. OpenClaw (`openclaw`)

- **默认目录**：`OPENCLAW_STATE_DIR` 或 `<OPENCLAW_HOME 或 ~/>/.openclaw`（配置文件默认为 `<home>/openclaw.json`，可用 `OPENCLAW_CONFIG_PATH` 覆盖）。
- **显式授权开关（仅 UI）**：**"授予 recipe-switch 插件对话访问权限"**（`grantConversationAccess`，默认不勾选）。
- **写入内容**：
  - `extensions/recipe-switch/{package.json,openclaw.plugin.json,index.mjs,recipe.json}`。
  - 在 `openclaw.json`（必须是严格 JSON，不支持 JSON5 语法）中：
    - 设置 `plugins.entries.recipe-switch.enabled = true`。
    - 若已存在 `plugins.allow` 数组，则将 `"recipe-switch"` 加入其中。
    - **仅当**配置里原本已有 `allowConversationAccess === true`，或者你在 UI 的工具设置里**主动勾选了"授予 recipe-switch 插件对话访问权限"**时，才会写入 `plugins.entries.recipe-switch.hooks.allowConversationAccess = true`（卸载时恢复原状）。
- **权限边界原则**：
  - OpenClaw 要求非内置插件具备 `allowConversationAccess = true` 才能运行 `before_prompt_build` 钩子。
  - 如果你未勾选该选项（或使用 CLI 安装，CLI 不设自动授权参数），`recipe-switch` 不会修改该权限，而是在预览说明中提醒你手动开启或勾选授权；在此之前钩子保持非激活状态。
  - 如果你的 `openclaw.json` 显式设置了 `plugins.enabled: false`、将插件列入 `plugins.deny`，或将 `allowConversationAccess` / `allowPromptInjection` 设为 `false`，`recipe-switch` 会直接拒绝安装——**即便传 `--force` 也绝不越权覆盖你的拒绝策略**。
- **路由与生效时机**：
  - 常规会话注入 `Main`（`appendSystemContext`）与 `User Steer`（`prependContext`）；当 `ctx.sessionKey` 匹配 `subagent:<id>` 或 `agent:<agent>:subagent:<id>` 时注入 `Sub` 与 `Sub Steer`。
  - `AGENTS.md` 与 `SOUL.md` 保持不变。首次安装插件后请重启 OpenClaw Gateway，后续切换配方在下次构建提示词时立即生效。

---

## 尚未覆盖的工具

以下工具在检测时会被如实列入"暂不支持（Not covered）"，不会对它们做任何写入：

| 工具 | 检测路径 | 原因说明 |
| --- | --- | --- |
| **Gemini CLI** | `~/.gemini` | 尚无原生源码核实全局指令槽位或扩展契约；目前外部文档仅记载了项目级的 `GEMINI.md`。 |
| **Cursor** | `~/.cursor` | 全局用户规则存储在应用内部设置数据库中，而文件规则（`.cursor/rules`）是按项目生效的，没有确认全局文件级挂载点。 |
| **Qoder** | `~/.qoder` | 虽然从 Ponytail 已知插件清单与 hook 路径，但目前还没有对应的源码核验与适配器实现。 |
