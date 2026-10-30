---
title: "配方与选项格式（recipe.toml）— recipe-switch 中文文档"
description: "手把手教你编写和接入 recipe-switch 配方：配置配方来源、理解六个提示词与每轮提醒槽位的继承规则，以及使用 when/unless、prepend/append 和 Markdown 章节 patch 定义复选框选项。"
layout: doc
page_id: recipes
h1: 配方与选项格式（recipe.toml）
kicker: 编写指南
---
## 什么是配方（Recipe）？

一份**配方**就是一套可移植的 AI 编程工具工作方式。在内部，每份配方在根据你的选项开关展开后，都会生成**六个标准文本槽位**：

| 槽位键名 | UI 名称（中 / 英） | 作用说明 |
| --- | --- | --- |
| `main` | 主代理 / Main | 主交互编程代理的系统提示词。 |
| `sub` | 子代理 / Subagent | 委派出去的子代理（subagent）系统提示词。 |
| `independent` | 独立 / Independent | 独立承担自包含任务时的代理系统提示词。 |
| `userSteer` | 用户提醒 / User reminder | 用户每轮发送消息时注入的简短纠偏提醒（steering）。 |
| `subSteer` | 子代理提醒 / Sub reminder | 子代理每轮执行时注入的简短提醒。 |
| `agentSteer` | 结果提醒 / Result reminder | 子代理或后台任务完成并向主代理交回结果时注入的提醒。 |

---

## 管理配方来源（Sources）

`recipe-switch` 会按顺序扫描 `~/.recipe-switch/config.json` 中配置的来源路径：

```sh
# 查看当前的 gpt-with-taste 位置与配方来源列表
node bin/recipe-switch.mjs sources

# 添加一个包含配方的目录或单个 recipe.toml 文件
node bin/recipe-switch.mjs sources add ~/my-recipes

# 移除一个来源
node bin/recipe-switch.mjs sources remove ~/my-recipes

# 指定用于渲染各工具适配器的 gpt-with-taste 仓库位置
node bin/recipe-switch.mjs sources --gwt ~/code/gpt-with-taste
```

支持的来源目录结构（`src/sources.mjs`）：
1. **单个 `recipe.toml` 文件**，或包含 `recipe.toml` 的目录（以及包含 `.toml` 配方文件的多子目录集合，自动忽略 `mapping.toml`）。
2. **作者仓库格式**：包含 `recipe/recipe.toml`（或旧版 `recipe/manifest.json`）以及预构建的 `dist/<harness>/` 目录，例如 [gpt-with-taste](https://github.com/NB-Corp/gpt-with-taste)。

如果两个来源里有相同的 `id@version`，第二个配方会自动带上内容哈希后缀（如 `id@version#abcdef`）加以区分。

---

## `recipe.toml` 结构与槽位继承规则

`recipe-switch` 采用与 Kiki Recipe 完全一致的 `recipe.toml` 规范（解析逻辑见 `src/recipe-toml.mjs`）。

```toml
schema_version = 1
id = "calm-reviewer"
name = "冷静评审 Calm Reviewer"
version = "0.2.1"
description = "Review-first behavior with optional security pass."

[prompts]
system = { file = "sub.md" }
steering = { text = "Stay inside the assigned slice." }

[prompts.main]
system = { file = "main.md" }
steering = { text = "Keep the review goal in view." }

[prompts.independent]
system = { file = "independent.md" }
steering = "off"
```

### `[prompts]` 如何映射到六个行为文本槽位？

每个槽位可以写单个 `{ file = "..." }` 或 `{ text = "..." }` 对象，也可以写对象数组（按声明顺序用空行 `\n\n` 拼接），或者设为 `"off"`：

- **公共 / 子代理分支（`[prompts]`）**：
  - `prompts.system` → 对应 **`sub`**（当 `main` 或 `independent` 未单独声明或设为 `"same"` 时，也作为它们的回退默认值）。
  - `prompts.steering` → 对应 **`subSteer`**。
- **主代理分支（`[prompts.main]`）**：
  - `prompts.main.system` → 对应 **`main`**（若未声明则继承 `prompts.system`）。
  - `prompts.main.steering` → 对应 **`userSteer`**。
  - `prompts.main.steering_sources.agent.custom.steering` → 对应 **`agentSteer`**（若未声明则默认回退到 `userSteer`，除非显式设置了 `prompts.main.steering_sources.agent.mode = "off"`）。
- **独立代理分支（`[prompts.independent]`）**：
  - `prompts.independent.system` → 对应 **`independent`**（若未声明则继承 `prompts.system`，若 `prompts.system` 也未声明则继承 `main`）。
- **显式禁用（`"off"`）**：
  - 将 `prompts.main = "off"` 或 `prompts.independent = "off"`（或具体槽位设为 `"off"`）会将对应文本置为 `null`。Kiki 以及内置快照插件（Pi、DSH、Kimi Code、Hermes、OpenClaw）会原样保留禁用语义；而必须依赖主提示词的单入口适配器（`codex`、`claude`、`omp`、`grok`、`opencode`）在遇到 `main = "off"` 时会直接报错提示你换一份启用了 Main 的配方，绝不会偷偷拿子代理提示词去顶替。

*(注：`recipe-switch` 暂不直接解析 `extends` 继承链，请安装展开后的配方包。)*

---

## 定义复选框选项（`[options.<id>]`）

配方选项让用户可以在 Web 面板里直接打勾，或在 CLI 用 `--with a,b --without c` 按需定制。所有选项按 TOML 中的声明顺序求值，且**只修改提示词文本**——绝不触碰模型参数、hooks 或权限。

每个选项必须声明 `name`（字符串）和 `default`（布尔值），可选声明 `description`：

```toml
[options.brief]
name = "Brief replies"
description = "Prepends a brevity rule to every system prompt and appends a reminder to Main steering."
default = true
```

选项可以通过以下三种方式修改提示词槽位：

### 1. 条件包含 / 排除条目（`when` 与 `unless`）

在 `[prompts]` 的任意槽位数组中，每个 `{ file = "..." }` 或 `{ text = "..." }` 条目都可以加上 `when = "<option_id>"`（选项开启时保留）或 `unless = "<option_id>"`（选项关闭时保留）：

```toml
[prompts]
system = [
  { file = "sub.md" },
  { text = "Report blockers early.", unless = "quiet" }
]
steering = { text = "Stay inside the slice.", unless = "quiet" }

[prompts.main]
system = [{ file = "main.md" }, { file = "research.md", when = "research" }]
steering = [
  { text = "Keep the goal in view." },
  { text = "Cite file:line for findings.", when = "review" }
]
```

如果某个槽位里的所有条目都被 `when`/`unless` 过滤掉了，该槽位依然保持已声明状态，其文本为空字符串 `""`（而不是变成 `"off"`）。

### 2. 整槽前后追加简写（`prepend` 与 `append`）

在 `[options.<id>]` 下，直接写 `prepend.<分支>.<槽位>` 或 `append.<分支>.<槽位>`，即可在该选项开启时往对应槽位的最前面或最后面追加 `{ file }` 或 `{ text }`。

合法的槽位路径：`common` | `main` | `independent` 加上 `.system`、`.steering`、`.anchor` 或 `.steering_sources.<source>`：

```toml
[options.brief]
name = "Brief replies"
default = true
prepend.common.system = { text = "Keep replies short." }
append.main.steering = { text = "Stay brief." }
```

### 3. 按 Markdown 标题精准修补（`[[options.<id>.patch]]`）

如果你想在选项开启时，对组装后的 Markdown 文本中**某一个具体章节**做插入、追加、替换或删除，可以使用 `[[options.<id>.patch]]`：

```toml
[options.review]
name = "Review section"
description = "Inserts a Review section before Tone in Main and appends a line inside Workflow."
default = false

[[options.review.patch]]
slot = "main.system"
section = "Tone"
action = "before"
content = { file = "review.md" }

[[options.review.patch]]
slot = "main.system"
section = "Workflow"
action = "append"
content = { text = "Finish with a self-review." }
```

- **`slot`**：目标槽位（如 `common.system`、`main.system`、`independent.system`、`main.steering` 等）。
- **`section`**：要匹配的 Markdown 标题文本（支持 `#` 到 `######` 任意级别；自动忽略 ```` ``` ```` 或 `~~~` 代码块内部的标题）。一个章节的范围从该标题行开始，直到下一个同级或更高级别的标题为止。目标槽位中必须恰好匹配到唯一一个同名标题。
- **`action`**：
  - `prepend` — 在该章节正文的开头（紧跟标题行下方）插入 `content`；若省略 `section` 则在整个槽位开头插入。
  - `append` — 在该章节正文的末尾插入 `content`；若省略 `section` 则在整个槽位末尾插入。
  - `before` — 在该章节标题之前插入 `content`（例如插入一个新章节，必传 `section`）。
  - `after` — 在该章节结束之后插入 `content`（必传 `section`）。
  - `replace` — 用 `content` 替换整个章节（含标题与正文，必传 `section`）。
  - `remove` — 删除整个章节（必传 `section`，且不接受 `content`）。

仓库中的 [`examples/options-sample/`](https://github.com/NB-Corp/recipe-switch/tree/main/examples/options-sample) 目录提供了包含上述全部三种写法的完整示例包，以及 `all-off`、`all-on`、`defaults`、`review-only` 四种开关组合下的展开结果对照。
