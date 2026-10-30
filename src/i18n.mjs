// User-facing message catalog, keyed by id with zh + en text.
//
// Drivers, the engine and the service return catalog items instead of free
// text: notes are {id, vars} (an optional `detail` key holds the technical
// key/hook name, shown behind a "Details" disclosure), foreign findings are
// {what: {id, vars}, detail, blocking}, blocked lines are
// {kind: 'hand-edit'|'conflict'|'foreign'|'generic', path?, unit?, vars}.
// Results keep a machine `code`; `message` is a catalog item.
//
// resolve(note, lang) → {id, text, detail?}  in one language.
// format(note, lang)  → plain text for the CLI.
export const LANGS = ['zh', 'en'];

const CATALOG = {
  // ---- generic engine notes -------------------------------------------------
  retentionLimit: {
    zh: '每次写入都保留被替换的版本，超过保留数量的旧备份会自动清理。',
    en: 'Every write keeps the replaced version; old backups beyond the retention limit are cleaned up automatically.',
  },
  restoreLimit: {
    zh: '若探测后硬链接能力丢失，恢复会检查目标不存在后 rename；检查与 rename 之间被外部重新创建的目标无法原子保护。',
    en: 'If hard-link support disappears after preview, recovery checks absence then renames; a target recreated between that check and rename cannot be protected atomically.',
  },
  restoreOriginalBody: {
    zh: '恢复完整原始文件并移除这个目标的全部 recipe-switch 操作；文件内其他手改也需要强制覆盖，并会先备份。',
    en: 'Restores complete original files and removes every recipe-switch operation for this target. Unrelated changes in these files also require force and are backed up first.',
  },
  // ---- result messages (result.code) ----------------------------------------
  'result.installed': {zh: '已装上 {recipe}', en: 'Installed {recipe}'},
  'result.switched': {zh: '已切换到 {recipe}', en: 'Switched to {recipe}'},
  'result.uninstalled': {zh: '已还原到装之前的原样', en: 'Uninstalled; original state restored.'},
  'result.rolledBackTo': {zh: '已撤回到 {recipe}', en: 'Rolled back to {recipe}'},
  'result.rolledBack': {zh: '已撤回，回到装之前的原样', en: 'Rolled back; original state restored.'},
  'result.restoredOriginal': {zh: '已恢复原始快照，recipe-switch 已完全撤出这个目标', en: 'Restored original snapshot; recipe-switch is fully uninstalled from this target.'},
  'result.unchanged': {zh: '已经是最新状态，没有需要写入的改动', en: 'Already up to date; nothing to write.'},
  'result.orphanBlobs': {
    zh: '原始文件已恢复；清理未使用的备份字节时需要人工看一下：{error}',
    en: 'Original files restored; unused blob cleanup needs attention: {error}',
  },
  // ---- per-driver install notes ---------------------------------------------
  'codex.note.newSession': {
    zh: '新开一个 Codex 会话后生效。子代理提示词已一并装好，用于角色组合；角色的分配方式 recipe-switch 不改。',
    en: 'Open a new Codex session for this to take effect. The subagent prompt is installed alongside for role composition; recipe-switch does not change how roles are assigned.',
    detail: 'model_instructions_file → prompts/recipe-switch/main.md；子代理文件 developer_instructions → sub.md',
  },
  'kiki.note.adopt': {
    zh: '新绑定的模型会使用这份配方；空闲会话在“重建上下文”后采用。撤回或还原会恢复原来的绑定值。',
    en: 'Bound models use this recipe; an idle session adopts it after Rebuild context. Rollback or uninstall restores the previous bindings.',
    detail: '[models."<alias>"].recipe → recipe-switch/packages/<id>/recipe.toml',
  },
  'claude.note.launch': {
    zh: 'Claude Code 的设置不会被改动。用下方这条命令启动新会话；切换配方会原地重写这些文件。',
    en: 'Claude Code settings are not edited. Start new sessions with the command below; switching rewrites these files in place.',
    detail: '--append-system-prompt-file + --plugin-dir',
  },
  'omp.note.restart': {
    zh: '重启 OMP 后生效。和 gpt-with-taste 一样，适配器作用于 openai / openai-codex 的 gpt-* 模型。',
    en: 'Restart OMP for this to take effect. As in gpt-with-taste, the adapter applies to openai / openai-codex gpt-* models.',
    detail: 'extensions/recipe-switch (OMP user extension)',
  },
  'grok.note.coexist': {
    zh: '你已有的其他规则文件不受影响，会和这条一起加载。',
    en: 'Your existing rules files stay in place and keep loading alongside this one.',
    detail: 'rules/recipe-switch.md',
  },
  'opencode.note.restart': {
    zh: '重启 OpenCode 后生效。这份提示词排在全局 AGENTS.md 和项目说明之后。',
    en: 'Restart OpenCode for this to take effect. The prompt is appended after the global AGENTS.md and project instructions.',
    detail: 'opencode.json "instructions" → recipe-switch/main.md',
  },
  'pi.note.reload': {
    zh: 'Pi 会在下一次请求时重新读取配方；装好扩展后运行 /reload 或新开一个会话。',
    en: 'Pi re-reads the recipe on the next request; run /reload or start a new session after installing the extension.',
  },
  'pi.note.scopeAll': {
    zh: '对所有模型生效（可在工具设置里限定 provider 或模型 id）。',
    en: 'Applies to every model (limit providers or model ids in Tool settings to narrow it).',
  },
  'pi.note.scope': {
    zh: '只对限定的范围生效：{scope}。',
    en: 'Applies only to the narrowed scope: {scope}.',
  },
  'dsh.note.nextProcess': {
    zh: '在下一个用此 profile 启动的 DSH 进程里生效；正在运行的进程保持原样。',
    en: 'Takes effect in the next DSH process started with this profile; a running process keeps its current behavior.',
  },
  'dsh.note.switchLight': {
    zh: '之后切换配方只重写配方快照，插件在每一步前重新读取。',
    en: 'Later switches rewrite only the recipe snapshot; the plugin re-reads it before each step.',
  },
  'kimi.note.restart': {
    zh: '安装或改动主提示词后重启 Kimi Code。内置主提示词会保留；项目级 agent.md、--agent-file 等绑定仍可覆盖。',
    en: 'Restart Kimi Code after installing or changing the main prompt. The built-in main prompt is retained; project agent.md, --agent-file and other bound profiles can still override it.',
    detail: 'SYSTEM.md 中的 ${base_prompt}；UserPromptSubmit 插件 plugins/managed/recipe-switch',
  },
  'kimi.note.steer': {
    zh: '每轮提醒在你每次发消息时实时读取；系统触发的子代理轮次不经过这个入口，子代理的 profile 不会被改动。',
    en: 'Per-turn reminders are re-read on every message you send. System-triggered subagent turns do not pass through this entry point; subagent profiles are left unchanged.',
    detail: 'UserPromptSubmit hook → recipe.json',
  },
  'hermes.note.middleware': {
    zh: '装好或更新插件代码后重启 Hermes。主/子代理提示词按会话冻结：每个会话的第一次请求确定内容，之后的切换只影响新会话，进行中的会话提示词不变。',
    en: 'Restart Hermes after installing or updating plugin code. Main/Sub prompts are frozen per session on its first request; recipe switches apply to new sessions and leave running sessions untouched.',
    detail: 'llm_request middleware, frozen per session_id',
  },
  'hermes.note.shapes': {
    zh: '支持常见的请求形态（chat 的 system/developer、Anthropic system、Responses instructions、Bedrock Converse system）。无法识别的请求会原样放行。',
    en: 'Common request shapes are covered (chat system/developer messages, Anthropic system blocks, Responses instructions, Bedrock Converse system). Unrecognized requests pass through unchanged.',
  },
  'hermes.note.bypass': {
    zh: 'Hermes 的 codex_app_server、辅助调用和总结调用不经过注入点，不会收到这份主/子代理提示词。',
    en: 'Hermes codex_app_server, auxiliary calls and max-iteration summary calls bypass the injection point and do not receive this Main/Sub prompt.',
    detail: 'bypasses llm_request',
  },
  'hermes.note.steeringOnly': {
    zh: '未确认此 Hermes 支持主/子代理提示词注入，本次只装每轮提醒；主/子代理系统提示词暂不生效。',
    en: 'This Hermes could not be confirmed to support Main/Sub prompt injection, so only per-turn reminders are installed; Main/Sub system prompts stay inactive.',
    detail: 'llm_request middleware not confirmed',
  },
  'hermes.note.steeringOnlyWhy': {
    zh: '原因：{reason}。确认 Python 可用并升级 Hermes 后重新安装。装好每轮提醒插件后重启 Hermes。',
    en: 'Reason: {reason}. Make sure Python is available and upgrade Hermes, then reinstall. Restart Hermes after installing the reminder plugin.',
  },
  'hermes.note.steer': {
    zh: '每轮提醒在每次请求前实时读取；委派的子代理使用子代理提醒。SOUL.md 和 AGENTS.md 不会被改动。',
    en: 'Per-turn reminders are re-read before each request; delegated children use the subagent reminder. SOUL.md and AGENTS.md are left unchanged.',
    detail: 'pre_llm_call hook',
  },
  'hermes.note.steerTooLong': {
    zh: '{role} 提醒超过 Hermes 默认的 10,000 字 hook 输出上限；Hermes 可能只注入开头部分。',
    en: 'The {role} reminder exceeds Hermes\'s default 10,000-character hook output budget; Hermes may inject only a preview.',
  },
  'openclaw.note.granted': {
    zh: '你已明确授予 recipe-switch 对话访问权限，本次写入会打开它；卸载时恢复原状。',
    en: 'You explicitly granted conversation access to recipe-switch; this write enables it. Uninstall restores its original state.',
    detail: 'plugins.entries.recipe-switch.hooks.allowConversationAccess=true',
  },
  'openclaw.note.prerequisite': {
    zh: 'OpenClaw 要求非内置插件获得对话访问权限才能注入提示词。目前保持未设置：你可以在工具设置里勾选“授予对话访问权限”，或之后自行打开；在此之前注入不会生效。',
    en: 'OpenClaw requires non-bundled plugins to be granted conversation access before they can inject prompts. It stays unset for now: select the grant in Tool settings or enable it yourself later; until then injection stays inactive.',
    detail: 'plugins.entries.recipe-switch.hooks.allowConversationAccess',
  },
  'openclaw.note.restart': {
    zh: '装好或更新插件代码后重启 OpenClaw Gateway；之后切换配方会在下一次构造提示词时生效。',
    en: 'Restart the OpenClaw Gateway after installing or changing plugin code. Later recipe switches are re-read on the next prompt build.',
    detail: 'before_prompt_build',
  },
  'openclaw.note.scope': {
    zh: '常规会话使用主提示词和用户提醒；子代理会话使用子代理提示词和子代理提醒；无法识别来源的会话按常规会话处理。',
    en: 'Regular sessions use the main prompt and user reminder; subagent sessions use the subagent prompt and reminder; sessions without a recognizable source are treated as regular.',
    detail: 'ctx.sessionKey = subagent:<id> / agent:<agent>:subagent:<id>',
  },
  'openclaw.note.config': {
    zh: '只改动插件启用、对话访问权限和已有的允许列表；AGENTS.md、SOUL.md 等其他配置不会被改动。',
    en: 'Only plugin enablement, conversation-hook access and an existing allowlist are edited; AGENTS.md, SOUL.md and other configuration stay unchanged.',
    detail: '{file}',
  },
  'openclaw.option.grant': {
    zh: '授予 recipe-switch 对话访问权限',
    en: 'Grant recipe-switch conversation access',
    detail: 'plugins.entries.recipe-switch.hooks.allowConversationAccess',
  },
  'openclaw.option.grantHint': {
    zh: '允许插件读取对话内容，才能把提示词注入进去。这是 OpenClaw 对非内置插件的要求，卸载时会还原。',
    en: 'Lets the plugin read the conversation so it can inject prompts. OpenClaw requires this for non-bundled plugins; it is restored on uninstall.',
  },
  'openclaw.option.grantDenied': {
    zh: '当前配置里这个权限被显式设为 false，需要先由你手动改掉，recipe-switch 不会替你授权。',
    en: 'This permission is explicitly set to false in your config; change it yourself first — recipe-switch will not grant it for you.',
    detail: 'plugins.entries.recipe-switch.hooks.allowConversationAccess = false',
  },
  // ---- foreign findings (detect → what) -------------------------------------
  'foreign.codex.gwtInstaller': {
    zh: '检测到 gpt-with-taste 官方安装器',
    en: 'gpt-with-taste installer detected',
    detail: 'config.toml model_instructions_file → {target}',
  },
  'foreign.codex.gwtInstallerDetail': {
    zh: '它指向 {target}。请先运行 gpt-with-taste scripts/install.mjs --restore 还原，再由 recipe-switch 接管。',
    en: 'It points at {target}. Restore it with gpt-with-taste scripts/install.mjs --restore before recipe-switch takes over.',
  },
  'foreign.codex.customInstructions': {
    zh: '已有的自定义指令文件',
    en: 'Existing custom instructions file',
    detail: 'config.toml model_instructions_file → {target}',
  },
  'foreign.codex.gwtReceipt': {
    zh: 'gpt-with-taste 安装回执',
    en: 'gpt-with-taste install receipt',
  },
  'foreign.codex.gwtReceiptDetail': {
    zh: '{dir} 里有这个 Codex home 的生效回执，两套管理会冲突。',
    en: '{dir} holds an active receipt for this Codex home; two managers would conflict.',
  },
  'foreign.kiki.recipe': {
    zh: 'Kiki Recipes 安装的配方',
    en: 'Recipe installed via Kiki Recipes',
    detail: 'config.toml [{label}]',
  },
  'foreign.kiki.customRecipe': {
    zh: '手动绑定的配方',
    en: 'Manually bound recipe',
    detail: 'config.toml [{label}]',
  },
  'foreign.pi.gwtPackage': {
    zh: 'gpt-with-taste 的 Pi 包',
    en: 'gpt-with-taste Pi package',
    detail: 'settings.json → {source}',
  },
  'foreign.pi.gwtPackageDetail': {
    zh: 'settings.json 加载了 {source}；两套行为扩展会重复注入。',
    en: 'settings.json loads {source}; two behavior extensions would both inject.',
  },
  'foreign.pi.gwtExtension': {
    zh: 'gpt-with-taste 的 Pi 扩展',
    en: 'gpt-with-taste Pi extension',
    detail: 'extensions/{name}',
  },
  'foreign.dsh.gwtBundle': {
    zh: 'dsh-gpt-with-taste bundle',
    en: 'dsh-gpt-with-taste bundle',
  },
  'foreign.dsh.gwtBundleDetail': {
    zh: '此 profile 已挂载它，两边都会注入行为文本。',
    en: 'It is mounted in this profile; both would inject behavior text.',
  },
  'foreign.dsh.kikiBundle': {
    zh: 'dsh-kiki-recipe bundle',
    en: 'dsh-kiki-recipe bundle',
  },
  'foreign.dsh.kikiBundleDetail': {
    zh: '那里绑定的 Kiki 配方会和这份配方叠加。',
    en: 'Kiki Recipes bound there would stack with this recipe.',
  },
  'foreign.identity.soul': {
    zh: '用户身份文件 SOUL.md',
    en: 'User identity SOUL.md',
  },
  'foreign.identity.soulDetail': {
    zh: '不会被改动；插件在此基础上单独注入配方内容。',
    en: 'Left unchanged; the plugin adds recipe context separately.',
  },
  'foreign.kimi.system': {
    zh: '非 recipe-switch 管理的 SYSTEM.md',
    en: 'Non-managed SYSTEM.md',
    detail: 'SYSTEM.md',
  },
  'foreign.kimi.systemDetail': {
    zh: '请先把它移走再安装；recipe-switch 不会合并你自己的提示词。',
    en: 'Move SYSTEM.md aside before installing; recipe-switch does not merge a user prompt.',
  },
  'foreign.kimi.registry': {
    zh: '已存在的 recipe-switch Kimi 插件',
    en: 'Existing recipe-switch Kimi plugin',
  },
  'foreign.kimi.registryDetail': {
    zh: '请先移除或挪走这个非本工具管理的插件注册项。',
    en: 'Remove or move the non-managed plugin registry entry first.',
  },
  'foreign.hermes.steeringOnly': {
    zh: '主/子代理提示词不可用',
    en: 'Main/Sub unavailable',
    detail: 'llm_request middleware',
  },
  'foreign.hermes.steeringOnlyDetail': {
    zh: '未确认此 Hermes 支持主/子代理注入，只装每轮提醒；主/子代理系统提示暂不可用。{reason}',
    en: 'Main/Sub injection is not confirmed on this Hermes; only per-turn reminders are installed and Main/Sub prompts stay inactive. {reason}',
  },
  'foreign.hermes.disabled': {
    zh: 'recipe-switch 在 Hermes 中被显式禁用',
    en: 'Hermes plugin explicitly disabled',
    detail: 'config.yaml plugins.disabled',
  },
  'foreign.hermes.disabledDetail': {
    zh: '请自己先把 plugins.disabled 里的 recipe-switch 移除再安装。',
    en: 'Remove recipe-switch from plugins.disabled yourself before installing.',
  },
  'foreign.opencode.config': {
    zh: 'opencode.json 不是纯 JSON',
    en: 'opencode.json is not plain JSON',
  },
  'foreign.opencode.configDetail': {
    zh: '可能带注释；recipe-switch 不会改动它。',
    en: 'Comments are not supported; recipe-switch will not edit it.',
  },
  'foreign.opencode.jsonc': {
    zh: '同时存在 opencode.jsonc',
    en: 'opencode.jsonc also present',
  },
  'foreign.opencode.jsoncDetail': {
    zh: 'recipe-switch 只编辑 opencode.json。',
    en: 'recipe-switch edits opencode.json only.',
  },
  // ---- mechanism / steer (how a harness is wired) ----------------------------
  'mechanism.codex': {
    zh: '在 config.toml 里登记一个由 recipe-switch 管理的提示词文件，内容随配方切换重写。',
    en: 'Registers a recipe-switch-managed prompt file in config.toml; its content is rewritten on every switch.',
    detail: 'config.toml model_instructions_file → prompts/recipe-switch/main.md',
  },
  'steer.codex': {
    zh: '不由本工具注入；可搭配 gpt-with-taste 自带的 hooks 插件实现每轮提醒。',
    en: 'Not injected by this tool; gpt-with-taste\'s own hooks plugin remains the per-turn reminder route.',
  },
  'mechanism.kiki': {
    zh: '把配方包装成 Kiki 配方包，并绑定到你选的模型上。',
    en: 'Wraps the recipe as a Kiki recipe package and binds it to the models you choose.',
    detail: '[models."<alias>"].recipe → recipe-switch/packages/<id>',
  },
  'steer.kiki': {
    zh: '由 Kiki 原生 Recipe steering 注入（主代理/子代理/独立分支、agent 与 task 来源）。',
    en: 'Injected through native Kiki Recipe steering (main/sub/independent branches, agent and task sources).',
  },
  'mechanism.claude': {
    zh: '会话级：由 recipe-switch 管理的提示词文件和插件目录在启动时传入，不改任何设置。',
    en: 'Session-local: a managed prompt file and plugin directory are passed at launch; no settings are edited.',
    detail: '--append-system-prompt-file + --plugin-dir',
  },
  'steer.claude': {
    zh: '由随附插件的 hooks 注入用户提醒、子代理提醒和结果提醒。',
    en: 'User, subagent and result reminders are injected through the bundled plugin hooks.',
  },
  'mechanism.omp': {
    zh: '用户扩展目录里的 recipe-switch 扩展（来自 gpt-with-taste 的 OMP 适配器）。',
    en: 'A recipe-switch extension in the user extension directory (from the gpt-with-taste OMP adapter).',
    detail: 'extensions/recipe-switch',
  },
  'steer.omp': {
    zh: '由适配器注入用户提醒、子代理提醒和已完成任务提醒（默认作用于 GPT 模型）。',
    en: 'User, subagent and completed-task reminders through the adapter (GPT models by default).',
  },
  'mechanism.grok': {
    zh: '一条始终加载的全局规则文件，内容随配方切换重写。',
    en: 'A global rule file that is always loaded; its content is rewritten on every switch.',
    detail: 'rules/recipe-switch.md',
  },
  'steer.grok': {
    zh: '不支持：Grok 的 hooks 无法向模型上下文追加内容。',
    en: 'Not supported: Grok hooks cannot add model context.',
  },
  'mechanism.opencode': {
    zh: '在 opencode.json 的 instructions 列表里登记一个由 recipe-switch 管理的提示词文件。',
    en: 'Lists a recipe-switch-managed prompt file in opencode.json\'s instructions.',
    detail: 'opencode.json "instructions" → recipe-switch/main.md',
  },
  'steer.opencode': {
    zh: '暂不支持（system-transform 插件 hook 是后续工作）。',
    en: 'Not yet (the system-transform plugin hook is a later step).',
  },
  'mechanism.pi': {
    zh: '内置的 recipe-switch 扩展（会被 Pi 自动发现的用户扩展），配方快照随切换重写。',
    en: 'A built-in recipe-switch extension (an auto-discovered user extension); its recipe snapshot is rewritten on switch.',
    detail: 'extensions/recipe-switch',
  },
  'steer.pi': {
    zh: '由扩展注入用户提醒、子代理提醒和结果提醒。',
    en: 'User, subagent and result reminders through the extension.',
  },
  'mechanism.dsh': {
    zh: '内置的 recipe-switch Cordis bundle，每个 profile 各装一份。',
    en: 'A built-in recipe-switch Cordis bundle, installed once per profile.',
    detail: 'node_modules/dsh-recipe-switch + cordis.patch.yml',
  },
  'steer.dsh': {
    zh: '在 agent/pre-step 注入用户提醒、协调者提醒和子代理汇报提醒。',
    en: 'User, coordinator and subagent-report reminders at agent/pre-step.',
  },
  'mechanism.kimiCode': {
    zh: 'SYSTEM.md 在保留内置主提示词的基础上叠加配方，外加一个由 recipe-switch 管理的 UserPromptSubmit 插件。',
    en: 'SYSTEM.md layers the recipe on top of the built-in main prompt, plus a managed UserPromptSubmit plugin.',
    detail: 'SYSTEM.md ${base_prompt} + plugins/managed/recipe-switch',
  },
  'steer.kimiCode': {
    zh: '用户提醒在每轮发消息时注入；子代理 profile 和 steering 保持不变。',
    en: 'User reminders are injected on each message; subagent profiles and steering are unchanged.',
  },
  'mechanism.hermes': {
    zh: '通过按会话冻结的 llm_request middleware 注入完整主/子代理提示词，外加 pre_llm_call 每轮提醒；在 config.yaml 的 enabled 列表登记一项。',
    en: 'Full Main/Sub prompts through session-frozen llm_request middleware plus pre_llm_call per-turn reminders; one entry in config.yaml\'s enabled list.',
    detail: 'plugins.enabled += recipe-switch; provides_middleware: llm_request',
  },
  'mechanism.hermesSteeringOnly': {
    zh: '主/子代理提示词不可用；只通过 pre_llm_call 注入每轮提醒。',
    en: 'Main/Sub prompts unavailable; per-turn reminders only via pre_llm_call.',
    detail: 'llm_request middleware not confirmed',
  },
  'steer.hermes': {
    zh: '用户提醒作用于主会话，子代理提醒作用于委派的子代理。',
    en: 'User reminders for main turns; subagent reminders for delegated children.',
  },
  'mechanism.openclaw': {
    zh: '原生 before_prompt_build 插件，配合严格 JSON 的启用键。',
    en: 'A native before_prompt_build plugin with strict-JSON enablement keys.',
    detail: 'extensions/recipe-switch + plugins.entries.recipe-switch.enabled',
  },
  'steer.openclaw': {
    zh: '用户提醒；子代理会话另有子代理提示词和子代理提醒。',
    en: 'User reminders; subagent sessions get the subagent prompt and reminder.',
  },
  // ---- blocked entries -------------------------------------------------------
  'blocked.handEdit': {
    zh: '被手动改过：{path}',
    en: 'Edited by hand: {path}',
  },
  'blocked.conflict': {
    zh: '目标位置已有非本工具创建的文件：{path}',
    en: 'An unmanaged file already exists at the target: {path}',
  },
  unknownRecipeOption: {
    zh: '未知的配方选项 {id}，已忽略。',
    en: 'Unknown recipe option {id}; ignored.',
  },
  'foreign.generic': {
    zh: '{what}',
    en: '{what}',
  },
  'foreign.genericDetail': {
    zh: '{detail}',
    en: '{detail}',
  },
  'cli.replacedAt': {
    zh: '被替换的版本保存在',
    en: 'Replaced version saved at',
  },
};

/** Pick the CLI language: explicit --lang, then LANG/LC_ALL, default English. */
export function cliLang(env = process.env, explicit) {
  if (explicit) return explicit.startsWith('zh') ? 'zh' : 'en';
  const value = env.LC_ALL || env.LANG || '';
  return value.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** The replaced-version line in one language (mirrors the UI's replacedAt label). */
export function replacedAtLine(saved, lang = 'en') {
  return `${CATALOG['cli.replacedAt'][lang] ?? CATALOG['cli.replacedAt'].en} ${saved}`;
}

/** Text for a blocked entry in one language. */
export function blockedMessage(item, lang = 'en') {
  if (typeof item === 'string') return item;
  if (item.kind === 'hand-edit') return resolve({id: 'blocked.handEdit', vars: {path: item.path}}, lang).text;
  if (item.kind === 'conflict') return resolve({id: 'blocked.conflict', vars: {path: item.path}}, lang).text;
  if (item.kind === 'foreign') {
    const head = item.text?.id ? format(item.text, lang) : String(item.text ?? '');
    const tail = item.detail?.id ? format(item.detail, lang) : String(item.detail ?? '');
    return tail ? `${head}: ${tail}` : head;
  }
  return item.text ?? '';
}

export function note(id, vars = {}) { return {id, vars}; }

export function resolve(item, lang = 'en') {
  const entry = CATALOG[item?.id];
  const template = entry?.[lang] ?? entry?.en ?? String(item?.id ?? '');
  const text = template.replace(/\{(\w+)\}/g, (_, key) => String(item.vars?.[key] ?? ''));
  const detailTemplate = entry?.detail;
  const detail = detailTemplate ? detailTemplate.replace(/\{(\w+)\}/g, (_, key) => String(item.vars?.[key] ?? '')) : undefined;
  return {id: item?.id ?? '', text, ...(detail ? {detail} : {})};
}

/** Plain-text line for the CLI. */
export function format(item, lang = 'en') {
  const {text, detail} = resolve(item, lang);
  return detail ? `${text} (${detail})` : text;
}
