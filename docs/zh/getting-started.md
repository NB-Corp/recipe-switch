---
title: "安装与快速开始 — recipe-switch 中文文档"
description: "两分钟上手 recipe-switch：在隔离沙盒中试玩 Web 面板，检测本机 AI 编程工具，预览 Diff、安装切换配方，以及一键回滚还原。"
layout: doc
page_id: getting-started
h1: 安装与快速开始
kicker: 指南
---
## 环境要求

- **Node.js ≥ 22**（纯原生 ES Module 实现，**零 npm 依赖**，无需 `npm install` 第三方包）。
- 同级目录下克隆一份 [gpt-with-taste](https://github.com/NB-Corp/gpt-with-taste)（默认查找 `../gpt-with-taste`，也可通过环境变量 `RECIPE_SWITCH_GWT` 或 `recipe-switch sources --gwt <dir>` 指定）。`gpt-with-taste` 既是默认的第一个配方来源，也提供各平台适配器的构建脚本。

将两个仓库克隆在同一父目录下：

```sh
git clone https://github.com/NB-Corp/gpt-with-taste.git
git clone https://github.com/NB-Corp/recipe-switch.git
cd recipe-switch
```

*（可选）* 将 `recipe-switch` 命令链接到全局 PATH：

```sh
npm link
```

---

## 1. 先在沙盒假目录里试玩（零风险）

在动你电脑上真实的编程工具配置之前，可以先用内置沙盒脚本体验全部功能：

```sh
node scripts/demo.mjs --reset
```

这条命令会：
1. 在 `.tmp/demo/` 下创建一整套模拟工具目录（包含 Codex、Claude Code、Kiki、Pi、两个 DeepSeek Harness profile `web` 与 `work`、OMP、Grok、OpenCode、Kimi Code、Hermes 和 OpenClaw）。
2. 除了 `gpt-with-taste` 外，额外生成一份带复选框开关的示例配方 `calm-reviewer@0.2.1`（演示章节插入 patch 与每轮提醒追加）。
3. 将所有工具的环境变量指向 `.tmp/demo/`，并在 `http://127.0.0.1:4517/` 启动本地 Web 面板。

`scripts/demo.mjs` 可选参数：
- `--reset` — 清空并重新创建 `.tmp/demo/` 沙盒。
- `--dir <DIR>` — 指定自定义沙盒目录。
- `--port <N>` — 指定监听端口（默认 `4517`）。
- `--no-open` — 仅启动本地服务，不自动打开浏览器。

![本地面板中的工具总览]({{ '/screenshots/ui-01-home.png' | relative_url }})

---

## 2. 查看本机工具状态与可用配方

运行 `status` 查看本机检测到了哪些工具、当前安装了哪份配方、是否有手动修改（`hand edit`），以及是否存在其他安装器冲突：

```sh
node bin/recipe-switch.mjs status
```

如果需要供脚本消费的 JSON 输出，加上 `--json`：

```sh
node bin/recipe-switch.mjs status --json
```

查看当前配置源中所有可用的配方及其复选框选项：

```sh
node bin/recipe-switch.mjs recipes
```

---

## 3. 预览 Diff 并安装配方（CLI）

所有会改动文件的命令（`install`、`switch`、`rollback`、`uninstall`、`restore-original`）在不带 `--yes` 时都**只打印 diff 预览（dry run）**：

```sh
# 1. 预览模式：打印每个文件的 CREATE / MODIFY / DELETE 及 unified diff，不写盘
node bin/recipe-switch.mjs install pi gpt-with-taste@0.1.0

# 2. 确认写入：备份原文件后正式写入
node bin/recipe-switch.mjs install pi gpt-with-taste@0.1.0 --yes
```

![UI 中的 Diff 预览]({{ '/screenshots/ui-07-install-preview.png' | relative_url }})

### 传入配方选项与工具专属设置

用 `--with` 和 `--without` 开关配方选项，并按工具要求传入专属参数：

```sh
# Kiki 必须通过 --models 指定要绑定配方的模型别名（对应 ~/.kiki/config.toml 中的 [models."<alias>"]）
node bin/recipe-switch.mjs install kiki gpt-with-taste@0.1.0 --models axon/gpt-6.1-sol --yes

# DeepSeek Harness 按 profile 独立管理；有多个 profile 时需用 --home 指定目标目录
node bin/recipe-switch.mjs install dsh gpt-with-taste@0.1.0 --home ~/.dsh/profiles/web --root-role main --yes

# Pi 可选限定 provider 或模型 id 正则，同时开启 security 选项、关闭 cite 选项
node bin/recipe-switch.mjs switch pi calm-reviewer@0.2.1 --providers openai --model-pattern "^gpt-" --with security --without cite --yes
```

---

## 4. 使用本地竖屏 Web 小面板

启动只监听 `127.0.0.1` 的本地面板：

```sh
node bin/recipe-switch.mjs ui
```

- **「工具」页**：点开任意工具查看目录位置、写入方式、每轮提醒机制与操作历史。点击**"装上配方"**或**"换配方"**打开底部抽屉。
- **实时 Diff 预览**：拨动配方选项开关或修改工具设置，下方的文件改动预览会实时刷新。
- **「配方」页**：查看每份配方的版本、当前正在使用它的工具，点击六个文本槽位按钮（**主代理**、**子代理**、**独立**、**用户提醒**、**子代理提醒**、**结果提醒**）即可直接阅读并实时预览不同选项组合下的完整 Markdown 文本。
- **「来源」页**：增删本地配方目录或 `recipe.toml` 路径，修改 `gpt-with-taste` 仓库位置。
- **中英切换与内置向导**：点击右上角 `EN` / `中` 切换界面语言，点击 `?` 查看 5 步交互说明。

![配方来源]({{ '/screenshots/ui-18-sources.png' | relative_url }})

---

## 5. 撤回、还原或恢复到装之前

```sh
# 撤回上一步：回到上一个配方（如果只装过一次则回到初始状态）
node bin/recipe-switch.mjs rollback pi --yes

# 还原（卸载）：撤销该工具上的全部历史操作，恢复所有原始文件与配置跨度
node bin/recipe-switch.mjs uninstall pi --yes

# 查看操作历史与每次备份的目录位置
node bin/recipe-switch.mjs history pi

# 查看或恢复到首次安装前的原始状态备份（UI 里的"原始备份 / 恢复到装之前"）
node bin/recipe-switch.mjs originals pi
node bin/recipe-switch.mjs restore-original pi --yes
```

下一步：阅读[各工具说明]({{ '/zh/harnesses.html' | relative_url }})，了解每款工具具体读写了哪些文件与配置项。
{: .doc-next}
