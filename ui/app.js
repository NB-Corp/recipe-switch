// recipe-switch panel. Talks to the local server with the per-process token.
const TOKEN = document.querySelector('meta[name="recipe-switch-token"]')?.content ?? '';
const state = {overview: null, recipes: null, config: null, open: new Set(), screen: 'tools'};

// ---------------------------------------------------------------- i18n
const STRINGS = {
  zh: {
    tagline: '一键切换 AI 编程工具的整套工作方式', navTools: '工具', navRecipes: '配方', navSources: '来源',
    installed: '已装', notInstalled: '未安装', notFound: '未检测到', drift: '有手改', blocked: '需处理',
    noRecipe: '使用工具自带的提示词', since: '装于', detail: '详情', home: '位置', writes: '写入方式', steer: '每轮提醒',
    others: '其他配置', install: '装上配方', switchTo: '换配方', options: '调整选项', rollback: '撤回上一步', uninstall: '还原',
    history: '记录', toolsDetected: n => `检测到 ${n} 个工具`, uncovered: '暂不支持', uncoveredNote: '这些工具的写入点还没有合适的形式，不会被改动。',
    pickRecipe: '选一份配方', choose: '选择', current: '当前', recipeOptions: '配方选项', toolOptions: '工具设置',
    preview: '改动预览', apply: '确认写入', applying: '写入中…', cancel: '取消', back: '返回', done: '完成', next: '下一步', start: '开始使用',
    from: '现在', to: '换成', original: '工具原样', nothingToWrite: '没有需要写入的改动。', files: n => `${n} 个文件`,
    blockedTitle: '先处理这些', warnTitle: '注意', notesTitle: '说明', launchTitle: '以后用这条命令启动',
    resultInstalled: '已装上', resultSwitched: '已切换', resultRolledBack: '已撤回', resultRestored: '已还原', backupAt: '备份', replacedAt: '被替换的版本保存在',
    originalsTitle: '原始备份', restoreOriginal: '恢复到装之前', resultOriginal: '已恢复到装之前', viewOriginal: '查看原文',
    originalDate: date => `（${date} 的备份）`, alreadyOriginal: '已经是装之前的状态', originalCycleEnded: '安装周期已结束，快照已退役',
    reconstructed: '重建版本：可能包含安装后的其它修改', confirmReconstructed: '确认恢复重建版本（先备份）',
    originallyAbsent: '原来不存在 · 不存储字节', originalPrivate: '原始文件内容（敏感值已隐藏）', originalBinary: '二进制文件；确认恢复后会还原完整字节。',
    originalRestoreHint: '将撤下全部配方，恢复这些文件的完整原始字节；文件内其他手改也会被替换。检测到手改会先阻断，强制恢复会先备份当前版本。',
    defaultOn: '默认开', defaultOff: '默认关', affects: '影响', viewText: '查看文本', noOptions: '这份配方没有可调选项。',
    texts: {main: '主代理', sub: '子代理', independent: '独立', userSteer: '用户提醒', subSteer: '子代理提醒', agentSteer: '结果提醒'},
    empty: '无', sourcesTitle: '配方来源', sourcesHint: '每行一个目录或 recipe.toml。按顺序扫描。',
    techDetails: '技术细节', copy: '复制', copied: '已复制', remindersOnly: '仅每轮提醒', capConfirmed: '已确认生效', capRegistered: '已注册，尚未见到请求', capUnknown: '未知：请启动一次 Hermes', capUnsupported: '主/子代理不可用',
    seeYourEdit: '查看你的改动', yourEdit: '你的改动', keepMine: '保留我的改动（取消）', resolveDriftFirst: '先处理上面的改动',
    slotLegend: '主代理 / 子代理 / 独立 = 提示词槽位；用户提醒 / 子代理提醒 / 结果提醒 = 每轮注入的小提醒。',
    nextStepCodex: '新开一个 Codex 会话后生效。', backupSaved: '备份位置', noChange: '已经是装之前的状态',
    reconstructedWarn: '这份快照是从历史操作重建的，恢复前请确认。',
    snapshotAt: '快照时间', liveRecipes: n => `另有 ${n} 处配方由其它方式设置`,
    gwtLabel: 'gpt-with-taste 位置', gwtHint: '各工具的适配器从这里取（插件、清单格式等）。', addSource: '添加一行', save: '保存',
    saved: '已保存', sourceErrors: '读取失败的来源', stateHome: '状态与备份保存在', noRecipes: '没找到配方。到「来源」里加一个目录。',
    loadFailed: '加载失败', required: '先选好必填项', models: '要绑定的模型', rootRole: '根代理角色',
    providers: '只对这些 provider 生效（逗号分隔，留空为全部）', modelPattern: '只对匹配的模型 id 生效（正则，留空为全部）',
    conversationGrant: '授予 recipe-switch 插件对话访问权限',
    conversationGrantHint: 'OpenClaw 对非内置插件要求此项，写在 plugins.entries.recipe-switch.hooks.allowConversationAccess。默认不勾选；卸载时还原。已有 false 需你先手动更改。',
    blockedHint: '你手动改过这些文件。可以先去工具里把改动挪走；或者直接覆盖，写入前会先备份你的版本，完成后显示备份位置。',
    handEdit: '被手动改过', forceBtn: '仍然覆盖（先备份）', forcedTitle: '将覆盖手改', forcedBody: '你的手改版本会先备份，然后被覆盖。',
    optional: '可选，默认全部生效', help: '使用说明', refresh: '刷新', changedOptions: '选项已改，未写入', liveOther: '非本工具写入',
    // backend note catalog, keyed by note id
    notes: {
      retentionLimit: '每次写入都保留被替换的版本，超过保留数量的旧备份会自动清理。',
      restoreLimit: '若探测后硬链接能力丢失，恢复会检查目标不存在后 rename；检查与 rename 之间被外部重新创建的目标无法原子保护。',
      restoreOriginalBody: '恢复完整原始文件并移除这个目标的全部 recipe-switch 操作；文件内其他手改也需要强制覆盖，并会先备份。',
      'codex.note.newSession': '新开一个 Codex 会话后生效。子代理提示词已一并装好，用于角色组合；角色的分配方式 recipe-switch 不改。',
      'kiki.note.adopt': '新绑定的模型会使用这份配方；空闲会话在“重建上下文”后采用。撤回或还原会恢复原来的绑定值。',
      'claude.note.launch': 'Claude Code 的设置不会被改动。用下方这条命令启动新会话；切换配方会原地重写这些文件。',
      'omp.note.restart': '重启 OMP 后生效。和 gpt-with-taste 一样，适配器作用于 openai / openai-codex 的 gpt-* 模型。',
      'grok.note.coexist': '你已有的其他规则文件不受影响，会和这条一起加载。',
      'opencode.note.restart': '重启 OpenCode 后生效。这份提示词排在全局 AGENTS.md 和项目说明之后。',
      'pi.note.reload': 'Pi 会在下一次请求时重新读取配方；装好扩展后运行 /reload 或新开一个会话。',
      'pi.note.scopeAll': '对所有模型生效（可在工具设置里限定 provider 或模型 id）。',
      'pi.note.scope': '只对限定的范围生效：{scope}。',
      'dsh.note.nextProcess': '在下一个用此 profile 启动的 DSH 进程里生效；正在运行的进程保持原样。',
      'dsh.note.switchLight': '之后切换配方只重写配方快照，插件在每一步前重新读取。',
      'kimi.note.restart': '安装或改动主提示词后重启 Kimi Code。内置主提示词会保留；项目级 agent.md、--agent-file 等绑定仍可覆盖。',
      'kimi.note.steer': '每轮提醒在你每次发消息时实时读取；系统触发的子代理轮次不经过这个入口，子代理的 profile 不会被改动。',
      'hermes.note.middleware': '装好或更新插件代码后重启 Hermes。主/子代理提示词按会话冻结：每个会话的第一次请求确定内容，之后的切换只影响新会话，进行中的会话提示词不变。',
      'hermes.note.shapes': '支持常见的请求形态（chat 的 system/developer、Anthropic system、Responses instructions、Bedrock Converse system）。无法识别的请求会原样放行。',
      'hermes.note.bypass': 'Hermes 的 codex_app_server、辅助调用和总结调用不经过注入点，不会收到这份主/子代理提示词。',
      'hermes.note.steeringOnly': '未确认此 Hermes 支持主/子代理提示词注入，本次只装每轮提醒；主/子代理系统提示词暂不生效。',
      'hermes.note.steeringOnlyWhy': '原因：{reason}。确认 Python 可用并升级 Hermes 后重新安装。装好每轮提醒插件后重启 Hermes。',
      'hermes.note.steer': '每轮提醒在每次请求前实时读取；委派的子代理使用子代理提醒。SOUL.md 和 AGENTS.md 不会被改动。',
      'hermes.note.steerTooLong': '{role} 提醒超过 Hermes 默认的 10,000 字 hook 输出上限；Hermes 可能只注入开头部分。',
      'openclaw.note.granted': '你已明确授予 recipe-switch 对话访问权限，本次写入会打开它；卸载时恢复原状。',
      'openclaw.note.prerequisite': 'OpenClaw 要求非内置插件获得对话访问权限才能注入提示词。目前保持未设置：你可以在工具设置里勾选“授予对话访问权限”，或之后自行打开；在此之前注入不会生效。',
      'openclaw.note.restart': '装好或更新插件代码后重启 OpenClaw Gateway；之后切换配方会在下一次构造提示词时生效。',
      'openclaw.note.scope': '常规会话使用主提示词和用户提醒；子代理会话使用子代理提示词和子代理提醒；无法识别来源的会话按常规会话处理。',
      'openclaw.note.config': '只改动插件启用、对话访问权限和已有的允许列表；AGENTS.md、SOUL.md 等其他配置不会被改动。',
      'openclaw.option.grant': '授予 recipe-switch 对话访问权限',
      'openclaw.option.grantHint': '允许插件读取对话内容，才能把提示词注入进去。这是 OpenClaw 对非内置插件的要求，卸载时会还原。',
      'openclaw.option.grantDenied': '当前配置里这个权限被显式设为 false，需要先由你手动改掉，recipe-switch 不会替你授权。',
      'foreign.codex.gwtInstaller': '检测到 gpt-with-taste 官方安装器',
      'foreign.codex.gwtInstallerDetail': '它指向 {target}。请先运行 gpt-with-taste scripts/install.mjs --restore 还原，再由 recipe-switch 接管。',
      'foreign.codex.customInstructions': '已有的自定义指令文件',
      'foreign.codex.gwtReceipt': 'gpt-with-taste 安装回执',
      'foreign.codex.gwtReceiptDetail': '{dir} 里有这个 Codex home 的生效回执，两套管理会冲突。',
      'foreign.kiki.recipe': 'Kiki Recipes 安装的配方',
      'foreign.kiki.customRecipe': '手动绑定的配方',
      'foreign.pi.gwtPackage': 'gpt-with-taste 的 Pi 包',
      'foreign.pi.gwtPackageDetail': 'settings.json 加载了 {source}；两套行为扩展会重复注入。',
      'foreign.pi.gwtExtension': 'gpt-with-taste 的 Pi 扩展',
      'foreign.dsh.gwtBundle': 'dsh-gpt-with-taste bundle',
      'foreign.dsh.gwtBundleDetail': '此 profile 已挂载它，两边都会注入行为文本。',
      'foreign.dsh.kikiBundle': 'dsh-kiki-recipe bundle',
      'foreign.dsh.kikiBundleDetail': '那里绑定的 Kiki 配方会和这份配方叠加。',
      'foreign.identity.soul': '用户身份文件 SOUL.md',
      'foreign.identity.soulDetail': '不会被改动；插件在此基础上单独注入配方内容。',
      'foreign.kimi.system': '非 recipe-switch 管理的 SYSTEM.md',
      'foreign.kimi.systemDetail': '请先把它移走再安装；recipe-switch 不会合并你自己的提示词。',
      'foreign.kimi.registry': '已存在的 recipe-switch Kimi 插件',
      'foreign.kimi.registryDetail': '请先移除或挪走这个非本工具管理的插件注册项。',
      'foreign.hermes.steeringOnly': '主/子代理提示词不可用',
      'foreign.hermes.steeringOnlyDetail': '未确认此 Hermes 支持主/子代理注入，只装每轮提醒；主/子代理系统提示暂不可用。{reason}',
      'foreign.hermes.disabled': 'recipe-switch 在 Hermes 中被显式禁用',
      'foreign.hermes.disabledDetail': '请自己先把 plugins.disabled 里的 recipe-switch 移除再安装。',
      'foreign.opencode.config': 'opencode.json 不是纯 JSON',
      'foreign.opencode.configDetail': '可能带注释；recipe-switch 不会改动它。',
      'foreign.opencode.jsonc': '同时存在 opencode.jsonc',
      'foreign.opencode.jsoncDetail': 'recipe-switch 只编辑 opencode.json。',
      'mechanism.codex': '在 config.toml 里登记一个由 recipe-switch 管理的提示词文件，内容随配方切换重写。',
      'steer.codex': '不由本工具注入；可搭配 gpt-with-taste 自带的 hooks 插件实现每轮提醒。',
      'mechanism.kiki': '把配方包装成 Kiki 配方包，并绑定到你选的模型上。',
      'steer.kiki': '由 Kiki 原生 Recipe steering 注入（主代理/子代理/独立分支、agent 与 task 来源）。',
      'mechanism.claude': '会话级：由 recipe-switch 管理的提示词文件和插件目录在启动时传入，不改任何设置。',
      'steer.claude': '由随附插件的 hooks 注入用户提醒、子代理提醒和结果提醒。',
      'mechanism.omp': '用户扩展目录里的 recipe-switch 扩展（来自 gpt-with-taste 的 OMP 适配器）。',
      'steer.omp': '由适配器注入用户提醒、子代理提醒和已完成任务提醒（默认作用于 GPT 模型）。',
      'mechanism.grok': '一条始终加载的全局规则文件，内容随配方切换重写。',
      'steer.grok': '不支持：Grok 的 hooks 无法向模型上下文追加内容。',
      'mechanism.opencode': '在 opencode.json 的 instructions 列表里登记一个由 recipe-switch 管理的提示词文件。',
      'steer.opencode': '暂不支持（system-transform 插件 hook 是后续工作）。',
      'mechanism.pi': '内置的 recipe-switch 扩展（会被 Pi 自动发现的用户扩展），配方快照随切换重写。',
      'steer.pi': '由扩展注入用户提醒、子代理提醒和结果提醒。',
      'mechanism.dsh': '内置的 recipe-switch Cordis bundle，每个 profile 各装一份。',
      'steer.dsh': '在 agent/pre-step 注入用户提醒、协调者提醒和子代理汇报提醒。',
      'mechanism.kimiCode': 'SYSTEM.md 在保留内置主提示词的基础上叠加配方，外加一个由 recipe-switch 管理的 UserPromptSubmit 插件。',
      'steer.kimiCode': '用户提醒在每轮发消息时注入；子代理 profile 和 steering 保持不变。',
      'mechanism.hermes': '通过按会话冻结的 llm_request middleware 注入完整主/子代理提示词，外加 pre_llm_call 每轮提醒；在 config.yaml 的 enabled 列表登记一项。',
      'mechanism.hermesSteeringOnly': '主/子代理提示词不可用；只通过 pre_llm_call 注入每轮提醒。',
      'steer.hermes': '用户提醒作用于主会话，子代理提醒作用于委派的子代理。',
      'mechanism.openclaw': '原生 before_prompt_build 插件，配合严格 JSON 的启用键。',
      'steer.openclaw': '用户提醒；子代理会话另有子代理提示词和子代理提醒。',
      unknownRecipeOption: '未知的配方选项 {id}，已忽略。',
      'foreign.generic': '{what}',
      'foreign.genericDetail': '{detail}',
      'result.installed': '已装上 {recipe}',
      'result.switched': '已切换到 {recipe}',
      'result.uninstalled': '已还原到装之前的原样',
      'result.rolledBackTo': '已撤回到 {recipe}',
      'result.rolledBack': '已撤回，回到装之前的原样',
      'result.restoredOriginal': '已恢复原始快照，recipe-switch 已完全撤出这个目标',
      'result.unchanged': '已经是最新状态，没有需要写入的改动',
      'result.orphanBlobs': '原始文件已恢复；清理未使用的备份字节时需要人工看一下：{error}',
    },
    noteDetails: {
      'codex.note.newSession': 'model_instructions_file → prompts/recipe-switch/main.md；子代理文件 developer_instructions → sub.md',
      'kiki.note.adopt': '[models."<alias>"].recipe → recipe-switch/packages/<id>/recipe.toml',
      'claude.note.launch': '--append-system-prompt-file + --plugin-dir',
      'omp.note.restart': 'extensions/recipe-switch (OMP user extension)',
      'grok.note.coexist': 'rules/recipe-switch.md',
      'opencode.note.restart': 'opencode.json "instructions" → recipe-switch/main.md',
      'kimi.note.restart': 'SYSTEM.md 中的 ${base_prompt}；UserPromptSubmit 插件 plugins/managed/recipe-switch',
      'kimi.note.steer': 'UserPromptSubmit hook → recipe.json',
      'hermes.note.middleware': 'llm_request middleware, frozen per session_id',
      'hermes.note.bypass': 'bypasses llm_request',
      'hermes.note.steeringOnly': 'llm_request middleware not confirmed',
      'hermes.note.steer': 'pre_llm_call hook',
      'openclaw.note.granted': 'plugins.entries.recipe-switch.hooks.allowConversationAccess=true',
      'openclaw.note.prerequisite': 'plugins.entries.recipe-switch.hooks.allowConversationAccess',
      'openclaw.note.restart': 'before_prompt_build',
      'openclaw.note.scope': 'ctx.sessionKey = subagent:<id> / agent:<agent>:subagent:<id>',
      'openclaw.note.config': '{file}',
      'openclaw.option.grant': 'plugins.entries.recipe-switch.hooks.allowConversationAccess',
      'openclaw.option.grantDenied': 'plugins.entries.recipe-switch.hooks.allowConversationAccess = false',
      'mechanism.codex': 'config.toml model_instructions_file → prompts/recipe-switch/main.md',
      'mechanism.kiki': '[models."<alias>"].recipe → recipe-switch/packages/<id>',
      'mechanism.claude': '--append-system-prompt-file + --plugin-dir',
      'mechanism.omp': 'extensions/recipe-switch',
      'mechanism.grok': 'rules/recipe-switch.md',
      'mechanism.opencode': 'opencode.json "instructions" → recipe-switch/main.md',
      'mechanism.pi': 'extensions/recipe-switch',
      'mechanism.dsh': 'node_modules/dsh-recipe-switch + cordis.patch.yml',
      'mechanism.kimiCode': 'SYSTEM.md ${base_prompt} + plugins/managed/recipe-switch',
      'mechanism.hermes': 'plugins.enabled += recipe-switch; provides_middleware: llm_request',
      'mechanism.hermesSteeringOnly': 'llm_request middleware not confirmed',
      'mechanism.openclaw': 'extensions/recipe-switch + plugins.entries.recipe-switch.enabled',
    },
  },
  en: {
    tagline: 'Switch how your AI coding tools think and work', navTools: 'Tools', navRecipes: 'Recipes', navSources: 'Sources',
    installed: 'On', notInstalled: 'Not installed', notFound: 'Not found', drift: 'Edited', blocked: 'Needs attention',
    noRecipe: 'Using the tool\'s own prompt', since: 'Installed', detail: 'Details', home: 'Home', writes: 'Writes', steer: 'Reminders',
    others: 'Other config', install: 'Install a recipe', switchTo: 'Switch recipe', options: 'Options', rollback: 'Undo last change', uninstall: 'Restore',
    history: 'History', toolsDetected: n => `${n} tools detected`, uncovered: 'Not supported yet', uncoveredNote: 'No suitable write point yet; these tools are left untouched.',
    pickRecipe: 'Pick a recipe', choose: 'Choose', current: 'current', recipeOptions: 'Recipe options', toolOptions: 'Tool settings',
    preview: 'Changes', apply: 'Write changes', applying: 'Writing…', cancel: 'Cancel', back: 'Back', done: 'Done', next: 'Next', start: 'Get started',
    from: 'Now', to: 'Becomes', original: 'Pre-install backup', nothingToWrite: 'Nothing to write.', files: n => `${n} file${n === 1 ? '' : 's'}`,
    blockedTitle: 'Resolve first', warnTitle: 'Heads-up', notesTitle: 'Notes', launchTitle: 'Start sessions with',
    resultInstalled: 'Installed', resultSwitched: 'Switched', resultRolledBack: 'Undone', resultRestored: 'Restored', backupAt: 'Backup', replacedAt: 'Replaced version saved at',
    originalsTitle: 'Original backup', restoreOriginal: 'Restore to before install', resultOriginal: 'Original files restored', viewOriginal: 'View original',
    originalDate: date => `(backup from ${date})`, alreadyOriginal: 'Already at the pre-install state', originalCycleEnded: 'Installation cycle ended; snapshot retired',
    reconstructed: 'Reconstructed: may include other changes made after installation', confirmReconstructed: 'Confirm reconstructed restore (backed up)',
    originallyAbsent: 'Did not exist · no bytes stored', originalPrivate: 'Original file content (sensitive values hidden)', originalBinary: 'Binary file; restoring will recover its complete bytes.',
    originalRestoreHint: 'Removes every recipe and restores complete original file bytes, including unrelated edits in these files. Hand edits block restoration; a forced restore backs up the current version first.',
    defaultOn: 'on by default', defaultOff: 'off by default', affects: 'Affects', viewText: 'View text', noOptions: 'This recipe has no options.',
    texts: {main: 'Main', sub: 'Subagent', independent: 'Independent', userSteer: 'User reminder', subSteer: 'Sub reminder', agentSteer: 'Result reminder'},
    empty: 'none', sourcesTitle: 'Recipe sources', sourcesHint: 'One directory or recipe.toml per line, scanned in order.',
    techDetails: 'Details', copy: 'Copy', copied: 'Copied', remindersOnly: 'Reminders only', capConfirmed: 'Confirmed active', capRegistered: 'Registered, no requests yet', capUnknown: 'Unknown: launch Hermes once', capUnsupported: 'Main/Sub unavailable',
    seeYourEdit: 'See your edit', yourEdit: 'Your edit', keepMine: 'Keep my edits (cancel)', resolveDriftFirst: 'Resolve the edits above first',
    slotLegend: 'Main / Subagent / Independent are prompt slots; user / subagent / result reminders are short per-turn injections.',
    nextStepCodex: 'Open a new Codex session for this to take effect.', backupSaved: 'Backup', noChange: 'Already back to the pre-install state',
    reconstructedWarn: 'This snapshot was reconstructed from past operations; confirm before restoring.',
    snapshotAt: 'Snapshot', liveRecipes: n => `${n} more recipe${n === 1 ? '' : 's'} set outside recipe-switch`,
    gwtLabel: 'gpt-with-taste checkout', gwtHint: 'Harness adapters (plugins, manifests) come from here.', addSource: 'Add line', save: 'Save',
    saved: 'Saved', sourceErrors: 'Sources that failed to load', stateHome: 'State and backups live in', noRecipes: 'No recipes found. Add a directory under Sources.',
    loadFailed: 'Failed to load', required: 'Fill in the required settings first', models: 'Models to bind', rootRole: 'Root agent role',
    providers: 'Only these providers (comma separated, empty = all)', modelPattern: 'Only model ids matching (regex, empty = all)',
    conversationGrant: 'Grant recipe-switch conversation access',
    conversationGrantHint: 'OpenClaw requires this for non-bundled plugins: plugins.entries.recipe-switch.hooks.allowConversationAccess. Off by default; restored on uninstall. Change an existing false manually first.',
    blockedHint: 'You edited these files by hand. Move your edits out first, or overwrite: your version is backed up before anything is written.',
    handEdit: 'Edited by hand', forceBtn: 'Overwrite anyway (backed up)', forcedTitle: 'Overwriting hand edits', forcedBody: 'Your edited version is backed up first, then replaced.',
    optional: 'optional; applies everywhere by default', help: 'Guide', refresh: 'Refresh', changedOptions: 'Options changed, not written', liveOther: 'not written by this tool',
    // backend note catalog, keyed by note id
    notes: {
      retentionLimit: 'Every write keeps the replaced version; old backups beyond the retention limit are cleaned up automatically.',
      restoreLimit: 'If hard-link support disappears after preview, recovery checks absence then renames; a target recreated between that check and rename cannot be protected atomically.',
      restoreOriginalBody: 'Restores complete original files and removes every recipe-switch operation for this target. Unrelated changes in these files also require force and are backed up first.',
      'codex.note.newSession': 'Open a new Codex session for this to take effect. The subagent prompt is installed alongside for role composition; recipe-switch does not change how roles are assigned.',
      'kiki.note.adopt': 'Bound models use this recipe; an idle session adopts it after Rebuild context. Rollback or uninstall restores the previous bindings.',
      'claude.note.launch': 'Claude Code settings are not edited. Start new sessions with the command below; switching rewrites these files in place.',
      'omp.note.restart': 'Restart OMP for this to take effect. As in gpt-with-taste, the adapter applies to openai / openai-codex gpt-* models.',
      'grok.note.coexist': 'Your existing rules files stay in place and keep loading alongside this one.',
      'opencode.note.restart': 'Restart OpenCode for this to take effect. The prompt is appended after the global AGENTS.md and project instructions.',
      'pi.note.reload': 'Pi re-reads the recipe on the next request; run /reload or start a new session after installing the extension.',
      'pi.note.scopeAll': 'Applies to every model (limit providers or model ids in Tool settings to narrow it).',
      'pi.note.scope': 'Applies only to the narrowed scope: {scope}.',
      'dsh.note.nextProcess': 'Takes effect in the next DSH process started with this profile; a running process keeps its current behavior.',
      'dsh.note.switchLight': 'Later switches rewrite only the recipe snapshot; the plugin re-reads it before each step.',
      'kimi.note.restart': 'Restart Kimi Code after installing or changing the main prompt. The built-in main prompt is retained; project agent.md, --agent-file and other bound profiles can still override it.',
      'kimi.note.steer': 'Per-turn reminders are re-read on every message you send. System-triggered subagent turns do not pass through this entry point; subagent profiles are left unchanged.',
      'hermes.note.middleware': 'Restart Hermes after installing or updating plugin code. Main/Sub prompts are frozen per session on its first request; recipe switches apply to new sessions and leave running sessions untouched.',
      'hermes.note.shapes': 'Common request shapes are covered (chat system/developer messages, Anthropic system blocks, Responses instructions, Bedrock Converse system). Unrecognized requests pass through unchanged.',
      'hermes.note.bypass': 'Hermes codex_app_server, auxiliary calls and max-iteration summary calls bypass the injection point and do not receive this Main/Sub prompt.',
      'hermes.note.steeringOnly': 'This Hermes could not be confirmed to support Main/Sub prompt injection, so only per-turn reminders are installed; Main/Sub system prompts stay inactive.',
      'hermes.note.steeringOnlyWhy': 'Reason: {reason}. Make sure Python is available and upgrade Hermes, then reinstall. Restart Hermes after installing the reminder plugin.',
      'hermes.note.steer': 'Per-turn reminders are re-read before each request; delegated children use the subagent reminder. SOUL.md and AGENTS.md are left unchanged.',
      'hermes.note.steerTooLong': 'The {role} reminder exceeds Hermes\'s default 10,000-character hook output budget; Hermes may inject only a preview.',
      'openclaw.note.granted': 'You explicitly granted conversation access to recipe-switch; this write enables it. Uninstall restores its original state.',
      'openclaw.note.prerequisite': 'OpenClaw requires non-bundled plugins to be granted conversation access before they can inject prompts. It stays unset for now: select the grant in Tool settings or enable it yourself later; until then injection stays inactive.',
      'openclaw.note.restart': 'Restart the OpenClaw Gateway after installing or changing plugin code. Later recipe switches are re-read on the next prompt build.',
      'openclaw.note.scope': 'Regular sessions use the main prompt and user reminder; subagent sessions use the subagent prompt and reminder; sessions without a recognizable source are treated as regular.',
      'openclaw.note.config': 'Only plugin enablement, conversation-hook access and an existing allowlist are edited; AGENTS.md, SOUL.md and other configuration stay unchanged.',
      'openclaw.option.grant': 'Grant recipe-switch conversation access',
      'openclaw.option.grantHint': 'Lets the plugin read the conversation so it can inject prompts. OpenClaw requires this for non-bundled plugins; it is restored on uninstall.',
      'openclaw.option.grantDenied': 'This permission is explicitly set to false in your config; change it yourself first — recipe-switch will not grant it for you.',
      'foreign.codex.gwtInstaller': 'gpt-with-taste installer detected',
      'foreign.codex.gwtInstallerDetail': 'It points at {target}. Restore it with gpt-with-taste scripts/install.mjs --restore before recipe-switch takes over.',
      'foreign.codex.customInstructions': 'Existing custom instructions file',
      'foreign.codex.gwtReceipt': 'gpt-with-taste install receipt',
      'foreign.codex.gwtReceiptDetail': '{dir} holds an active receipt for this Codex home; two managers would conflict.',
      'foreign.kiki.recipe': 'Recipe installed via Kiki Recipes',
      'foreign.kiki.customRecipe': 'Manually bound recipe',
      'foreign.pi.gwtPackage': 'gpt-with-taste Pi package',
      'foreign.pi.gwtPackageDetail': 'settings.json loads {source}; two behavior extensions would both inject.',
      'foreign.pi.gwtExtension': 'gpt-with-taste Pi extension',
      'foreign.dsh.gwtBundle': 'dsh-gpt-with-taste bundle',
      'foreign.dsh.gwtBundleDetail': 'It is mounted in this profile; both would inject behavior text.',
      'foreign.dsh.kikiBundle': 'dsh-kiki-recipe bundle',
      'foreign.dsh.kikiBundleDetail': 'Kiki Recipes bound there would stack with this recipe.',
      'foreign.identity.soul': 'User identity SOUL.md',
      'foreign.identity.soulDetail': 'Left unchanged; the plugin adds recipe context separately.',
      'foreign.kimi.system': 'Non-managed SYSTEM.md',
      'foreign.kimi.systemDetail': 'Move SYSTEM.md aside before installing; recipe-switch does not merge a user prompt.',
      'foreign.kimi.registry': 'Existing recipe-switch Kimi plugin',
      'foreign.kimi.registryDetail': 'Remove or move the non-managed plugin registry entry first.',
      'foreign.hermes.steeringOnly': 'Main/Sub unavailable',
      'foreign.hermes.steeringOnlyDetail': 'Main/Sub injection is not confirmed on this Hermes; only per-turn reminders are installed and Main/Sub prompts stay inactive. {reason}',
      'foreign.hermes.disabled': 'Hermes plugin explicitly disabled',
      'foreign.hermes.disabledDetail': 'Remove recipe-switch from plugins.disabled yourself before installing.',
      'foreign.opencode.config': 'opencode.json is not plain JSON',
      'foreign.opencode.configDetail': 'Comments are not supported; recipe-switch will not edit it.',
      'foreign.opencode.jsonc': 'opencode.jsonc also present',
      'foreign.opencode.jsoncDetail': 'recipe-switch edits opencode.json only.',
      'mechanism.codex': 'Registers a recipe-switch-managed prompt file in config.toml; its content is rewritten on every switch.',
      'steer.codex': 'Not injected by this tool; gpt-with-taste\'s own hooks plugin remains the per-turn reminder route.',
      'mechanism.kiki': 'Wraps the recipe as a Kiki recipe package and binds it to the models you choose.',
      'steer.kiki': 'Injected through native Kiki Recipe steering (main/sub/independent branches, agent and task sources).',
      'mechanism.claude': 'Session-local: a managed prompt file and plugin directory are passed at launch; no settings are edited.',
      'steer.claude': 'User, subagent and result reminders are injected through the bundled plugin hooks.',
      'mechanism.omp': 'A recipe-switch extension in the user extension directory (from the gpt-with-taste OMP adapter).',
      'steer.omp': 'User, subagent and completed-task reminders through the adapter (GPT models by default).',
      'mechanism.grok': 'A global rule file that is always loaded; its content is rewritten on every switch.',
      'steer.grok': 'Not supported: Grok hooks cannot add model context.',
      'mechanism.opencode': 'Lists a recipe-switch-managed prompt file in opencode.json\'s instructions.',
      'steer.opencode': 'Not yet (the system-transform plugin hook is a later step).',
      'mechanism.pi': 'A built-in recipe-switch extension (an auto-discovered user extension); its recipe snapshot is rewritten on switch.',
      'steer.pi': 'User, subagent and result reminders through the extension.',
      'mechanism.dsh': 'A built-in recipe-switch Cordis bundle, installed once per profile.',
      'steer.dsh': 'User, coordinator and subagent-report reminders at agent/pre-step.',
      'mechanism.kimiCode': 'SYSTEM.md layers the recipe on top of the built-in main prompt, plus a managed UserPromptSubmit plugin.',
      'steer.kimiCode': 'User reminders are injected on each message; subagent profiles and steering are unchanged.',
      'mechanism.hermes': 'Full Main/Sub prompts through session-frozen llm_request middleware plus pre_llm_call per-turn reminders; one entry in config.yaml\'s enabled list.',
      'mechanism.hermesSteeringOnly': 'Main/Sub prompts unavailable; per-turn reminders only via pre_llm_call.',
      'steer.hermes': 'User reminders for main turns; subagent reminders for delegated children.',
      'mechanism.openclaw': 'A native before_prompt_build plugin with strict-JSON enablement keys.',
      'steer.openclaw': 'User reminders; subagent sessions get the subagent prompt and reminder.',
      unknownRecipeOption: 'Unknown recipe option {id}; ignored.',
      'foreign.generic': '{what}',
      'foreign.genericDetail': '{detail}',
      'result.installed': 'Installed {recipe}',
      'result.switched': 'Switched to {recipe}',
      'result.uninstalled': 'Uninstalled; original state restored.',
      'result.rolledBackTo': 'Rolled back to {recipe}',
      'result.rolledBack': 'Rolled back; original state restored.',
      'result.restoredOriginal': 'Restored original snapshot; recipe-switch is fully uninstalled from this target.',
      'result.unchanged': 'Already up to date; nothing to write.',
      'result.orphanBlobs': 'Original files restored; unused blob cleanup needs attention: {error}',
    },
    noteDetails: {
      'codex.note.newSession': 'model_instructions_file → prompts/recipe-switch/main.md; developer_instructions → sub.md',
      'kiki.note.adopt': '[models."<alias>"].recipe → recipe-switch/packages/<id>/recipe.toml',
      'claude.note.launch': '--append-system-prompt-file + --plugin-dir',
      'omp.note.restart': 'extensions/recipe-switch (OMP user extension)',
      'grok.note.coexist': 'rules/recipe-switch.md',
      'opencode.note.restart': 'opencode.json "instructions" → recipe-switch/main.md',
      'kimi.note.restart': '${base_prompt} in SYSTEM.md; UserPromptSubmit plugin plugins/managed/recipe-switch',
      'kimi.note.steer': 'UserPromptSubmit hook → recipe.json',
      'hermes.note.middleware': 'llm_request middleware, frozen per session_id',
      'hermes.note.bypass': 'bypasses llm_request',
      'hermes.note.steeringOnly': 'llm_request middleware not confirmed',
      'hermes.note.steer': 'pre_llm_call hook',
      'openclaw.note.granted': 'plugins.entries.recipe-switch.hooks.allowConversationAccess=true',
      'openclaw.note.prerequisite': 'plugins.entries.recipe-switch.hooks.allowConversationAccess',
      'openclaw.note.restart': 'before_prompt_build',
      'openclaw.note.scope': 'ctx.sessionKey = subagent:<id> / agent:<agent>:subagent:<id>',
      'openclaw.note.config': '{file}',
      'openclaw.option.grant': 'plugins.entries.recipe-switch.hooks.allowConversationAccess',
      'openclaw.option.grantDenied': 'plugins.entries.recipe-switch.hooks.allowConversationAccess = false',
      'mechanism.codex': 'config.toml model_instructions_file → prompts/recipe-switch/main.md',
      'mechanism.kiki': '[models."<alias>"].recipe → recipe-switch/packages/<id>',
      'mechanism.claude': '--append-system-prompt-file + --plugin-dir',
      'mechanism.omp': 'extensions/recipe-switch',
      'mechanism.grok': 'rules/recipe-switch.md',
      'mechanism.opencode': 'opencode.json "instructions" → recipe-switch/main.md',
      'mechanism.pi': 'extensions/recipe-switch',
      'mechanism.dsh': 'node_modules/dsh-recipe-switch + cordis.patch.yml',
      'mechanism.kimiCode': 'SYSTEM.md ${base_prompt} + plugins/managed/recipe-switch',
      'mechanism.hermes': 'plugins.enabled += recipe-switch; provides_middleware: llm_request',
      'mechanism.hermesSteeringOnly': 'llm_request middleware not confirmed',
      'mechanism.openclaw': 'extensions/recipe-switch + plugins.entries.recipe-switch.enabled',
    },
  },
};
let lang = localStorage.getItem('rs.lang') ?? (navigator.language?.startsWith('zh') ? 'zh' : 'en');
const SHARED_UI = {
  originalsTitle: 'originals.title', restoreOriginal: 'originals.restore', viewOriginal: 'originals.view',
  originallyAbsent: 'originals.absent', originalPrivate: 'originals.private', originalBinary: 'originals.binary',
  originalRestoreHint: 'originals.restoreHint', reconstructedWarn: 'originals.reconstructedWarn',
  noChange: 'originals.alreadyOriginal', alreadyOriginal: 'originals.alreadyOriginal',
  originalCycleEnded: 'originals.cycleEnded', reconstructed: 'originals.reconstructed',
  confirmReconstructed: 'originals.confirmReconstructed',
};
const t = (key, ...args) => {
  if (SHARED_UI[key]) return msg({id: SHARED_UI[key]});
  const value = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return typeof value === 'function' ? value(...args) : value;
};
// Localize only exact metadata strings shipped with our sample recipes.
// Custom recipe names and descriptions remain authored content.
function sampleText(value) {
  const match = Object.entries(globalThis.RECIPE_SWITCH_MESSAGES ?? {}).find(([id, entry]) => id.startsWith('sample.') && entry.en === value);
  return match ? msg({id: match[0]}) : value;
}
function applyStatic() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  document.getElementById('langBtn').textContent = lang === 'zh' ? 'EN' : '中';
  document.getElementById('helpBtn').title = t('help');
  document.getElementById('refreshBtn').title = t('refresh');
}

// ---------------------------------------------------------------- helpers
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false || value === '') continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}
const svg = (markup, cls) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 20 20'); if (cls) s.setAttribute('class', cls); s.innerHTML = markup; return s; };
const ICON = {chev: '<path d="M7.5 5l5 5-5 5"/>', arrow: '<path d="M4 10h11M11 6l4 4-4 4"/>', check: '<path d="M5 10.5l3.2 3.2L15 7"/>'};

async function api(path, {method = 'GET', body} = {}) {
  const res = await fetch(path, {method, headers: {'x-recipe-switch-token': TOKEN, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
    body: body !== undefined ? JSON.stringify(body) : undefined});
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) throw new Error(data.note ? msg(data.note) : data.error ?? `HTTP ${res.status}`);
  return data;
}
function fmtTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(+date)) return iso;
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}
/** Home-relative, middle-ellipsized display path. */
function displayPath(p, max = 46) {
  let s = String(p ?? '').replaceAll('\\', '/');
  const root = state.overview?.displayHome;
  if (root && (s === root || s.startsWith(root + '/'))) s = '~' + s.slice(root.length);
  s = s.replace(/^[A-Za-z]:\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  if (s.length > max) { const head = Math.ceil((max - 1) / 2), tail = Math.floor((max - 1) / 2); s = s.slice(0, head) + '…' + s.slice(s.length - tail); }
  return s;
}
/** A mono path row: display form, full path in title, optional copy button. */
function pathRow(full, {mono = true, copy = true, cls = ''} = {}) {
  const text = displayPath(full);
  const span = el('span', {class: mono ? 'mono' : '', title: full, style: 'overflow-wrap:anywhere;min-width:0'}, text);
  if (!copy) return span;
  const btn = el('button', {class: 'btn btn-ghost btn-xs', 'aria-label': t('copy'), title: t('copy'), onclick: async () => {
    try { await navigator.clipboard.writeText(full); btn.textContent = t('copied'); setTimeout(() => { btn.textContent = t('copy'); }, 1200); } catch { toast(full); }
  }}, t('copy'));
  return el('span', {class: `path-row ${cls}`}, span, btn);
}
/** The server serves the same catalog consumed by the CLI. */
function msg(item) {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item;
  const entry = globalThis.RECIPE_SWITCH_MESSAGES?.[item.id];
  const template = entry?.[lang] ?? entry?.en ?? item.id ?? '';
  return template.replace(/\{(\w+)\}/g, (_, key) => String(item.vars?.[key] ?? ''));
}
function msgDetail(item) {
  if (!item || typeof item === 'string') return null;
  const entry = globalThis.RECIPE_SWITCH_MESSAGES?.[item.id];
  const template = entry?.[`detail_${lang}`] ?? entry?.detail;
  return template ? template.replace(/\{(\w+)\}/g, (_, key) => String(item.vars?.[key] ?? '')) : null;
}
/** Text of a live-row label (catalog item or plain string). */
function liveLabel(label) { return msg(label); }
function toast(message, bad = false) {
  const node = el('div', {class: `toast${bad ? ' bad' : ''}`}, message);
  document.getElementById('toastMount').append(node);
  setTimeout(() => node.remove(), 3200);
}
const MONO = {codex: 'Cx', claude: 'Cl', kiki: 'Ki', pi: 'Pi', dsh: 'DS', omp: 'Om', grok: 'Gk', opencode: 'Oc', 'kimi-code': 'Km', hermes: 'He', openclaw: 'OC'};
/** Capability chip on a harness row, from overview capability.state. */
function capabilityChip(target) {
  const stateValue = target.capability?.state;
  if (!stateValue) return null;
  const tone = {confirmed: 'ok', registered: 'warn', unknown: 'warn', unsupported: 'bad'}[stateValue] ?? 'warn';
  return el('span', {class: `chip ${tone}`, title: target.capability?.reason ?? ''}, msg({id: `hermes.capability.${stateValue}`}));
}
// ---------------------------------------------------------------- bottom sheet
function openSheet({kicker, title, sub, steps, body, foot}) {
  const mount = document.getElementById('sheetMount');
  mount.textContent = '';
  const scrim = el('div', {class: 'scrim'});
  const sheet = el('div', {class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title},
    el('div', {class: 'sheet-grip'}),
    el('div', {class: 'sheet-head'}, kicker ? el('div', {class: 'sheet-kicker'}, kicker) : null,
      el('h2', {class: 'sheet-title'}, title), sub ? el('p', {class: 'sheet-sub'}, sub) : null),
    steps ? el('div', {class: 'steps'}, Array.from({length: steps[1]}, (_, i) => el('i', {class: i < steps[0] ? 'is-done' : i === steps[0] ? 'is-now' : ''}))) : null,
    body, foot);
  const close = () => { mount.textContent = ''; document.removeEventListener('keydown', onKey); };
  const onKey = event => { if (event.key === 'Escape') close(); };
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  mount.append(scrim, sheet);
  sheet.tabIndex = -1;
  sheet.focus({preventScroll: true});
  return {close, sheet};
}
const sheetBody = (...children) => el('div', {class: 'sheet-body'}, ...children);
const sheetFoot = (...children) => el('div', {class: 'sheet-foot'}, ...children);
function note(kind, title, items) {
  if (!items?.length) return null;
  return el('div', {class: `note ${kind}`}, el('b', {}, title), el('ul', {}, items.map(item => el('li', {}, item))));
}

// ---------------------------------------------------------------- tools screen
function targetState(target) {
  if (target.error) return {lamp: 'bad', label: t('loadFailed')};
  if (!target.present) return {lamp: '', label: t('notFound')};
  if (target.managed?.drift?.length) return {lamp: 'warn', label: t('drift')};
  if ((target.foreign ?? []).some(item => item.blocking) && !target.managed?.installed) return {lamp: 'warn', label: t('blocked')};
  return target.managed?.installed ? {lamp: 'on', label: t('installed')} : {lamp: '', label: t('notInstalled')};
}
function optionSummary(recipeView, values) {
  const options = recipeView?.options ?? [];
  if (!options.length) return null;
  const on = options.filter(option => values?.[option.id] ?? option.default);
  return on.length === options.length ? null : options.map(option => `${(values?.[option.id] ?? option.default) ? '+' : '−'}${sampleText(option.name)}`).join(' ');
}
function toolRow(target) {
  const key = target.key, status = targetState(target), managed = target.managed ?? {};
  const recipeView = (state.recipes?.recipes ?? []).find(recipe => recipe.key === managed.recipe?.key);
  const others = (target.live ?? []).filter(item => item.managed === false);
  const row = el('article', {class: `row${managed.installed ? ' is-on' : ''}${target.present ? '' : ' is-absent'}${state.open.has(key) ? ' is-open' : ''}`});
  const subtitle = managed.installed
    ? el('div', {class: 'row-sub'}, `${managed.recipe.name} · v${managed.recipe.version}`)
    : el('div', {class: 'row-sub is-muted'}, target.present ? t('noRecipe') : displayPath(target.home));
  const lamp = el('span', {class: `lamp ${status.lamp}`}, status.label);
  const flags = el('div', {class: 'row-flags'},
    managed.installed && optionSummary(recipeView, managed.recipe.optionValues) ? el('span', {class: 'chip'}, optionSummary(recipeView, managed.recipe.optionValues)) : null,
    capabilityChip(target),
    others.length ? el('button', {class: 'chip chip-btn', title: others.map(o => `${liveLabel(o.label)} (${o.where})`).join('\n'),
      onclick: event => { event.stopPropagation(); state.open.add(key); row.classList.add('is-open'); row.querySelector('.row-main').setAttribute('aria-expanded', 'true'); }}, t('liveRecipes', others.length)) : null);
  row.append(el('button', {class: 'row-main', 'aria-expanded': String(state.open.has(key)), onclick: () => {
    state.open.has(key) ? state.open.delete(key) : state.open.add(key);
    row.classList.toggle('is-open'); row.querySelector('.row-main').setAttribute('aria-expanded', String(state.open.has(key)));
  }},
    el('span', {class: 'mono-chip'}, MONO[target.harness] ?? target.harness.slice(0, 2)),
    el('div', {class: 'row-text'}, el('div', {class: 'row-name'}, target.name, target.label ? el('small', {}, target.label) : null), subtitle, flags.childElementCount ? flags : null),
    el('div', {class: 'row-end'}, lamp, svg(ICON.chev, 'row-chev'))));
  const actions = el('div', {class: 'row-actions'});
  if (target.present && !target.error) {
    actions.append(el('button', {class: 'btn btn-primary', onclick: () => pickRecipe(target)}, managed.installed ? t('switchTo') : t('install')));
    if (managed.installed && recipeView?.options?.length) actions.append(el('button', {class: 'btn', onclick: () => configure(target, recipeView, {recipeOptions: managed.recipe.optionValues})}, t('options')));
    if (managed.installed && managed.history?.length > 1) actions.append(el('button', {class: 'btn', onclick: () => undoFlow(target, false)}, t('rollback')));
    if (managed.installed) actions.append(el('button', {class: 'btn btn-danger', onclick: () => undoFlow(target, true)}, t('uninstall')));
  }
  const techRows = [
    [t('writes'), msg(target.mechanism), msgDetail(target.mechanism)],
    target.steer ? [t('steer'), msg(target.steer), msgDetail(target.steer)] : null,
  ].filter(Boolean);
  const detail = el('div', {class: 'row-detail'},
    el('dl', {class: 'kv'},
      el('dt', {}, t('home')), el('dd', {}, pathRow(target.home)),
      others.length ? [el('dt', {}, t('others')), el('dd', {}, others.map(o => `${liveLabel(o.label)} (${t('liveOther')})`).join('；'), el('div', {class: 'mono tech-key'}, others.map(o => o.where).join('；')))] : null,

      managed.installed ? [el('dt', {}, t('since')), el('dd', {}, fmtTime(managed.since))] : null),
    techRows.length ? el('details', {class: 'more'}, el('summary', {}, t('techDetails'), el('span', {class: 'group-note'}, `${techRows.length}`)),
      el('div', {class: 'more-body'}, el('dl', {class: 'kv'}, techRows.flatMap(([name, text, detailText]) => [el('dt', {}, name), el('dd', {}, text, detailText ? el('div', {class: 'mono tech-key'}, detailText) : null)])))) : null,
    note('warn', t('drift'), (managed.drift ?? []).map(d => `${displayPath(d.path)} — ${msg({id: `status.${d.state}`})}`)),
    note(target.managed?.installed ? 'info' : 'warn', t('warnTitle'), (target.foreign ?? []).map(f => `${msg(f.what)}: ${msg(f.detail)}`)),
    target.error ? note('bad', t('loadFailed'), [target.errorNote ? msg(target.errorNote) : target.error]) : null,
    managed.history?.length ? el('details', {}, el('summary', {class: 'group-note'}, `${t('history')} · ${managed.history.length}`),
      el('div', {class: 'dim-list', style: 'margin-top:6px'}, managed.history.map(h => el('div', {class: 'dim'}, el('b', {}, msg({id: `action.${h.kind}`})), `${h.recipe ?? ''} · ${fmtTime(h.at)}`)))) : null,
    target.originals ? originalsBlock(target) : null,
    actions);
  row.append(detail);
  return row;
}
function originalsBlock(target) {
  const original = target.originals;
  const reconstructed = Boolean(original.reconstructed);
  return el('details', {'data-originals': target.harness},
    el('summary', {class: 'group-note'}, `${t('originalsTitle')} · ${fmtTime(original.capturedAt)}`),
    original.ended ? el('p', {class: 'group-note', style: 'margin:8px 0 0'},
      msg({id: original.alreadyOriginal ? 'originals.alreadyOriginal' : 'originals.cycleEnded'})) : null,
    el('div', {class: 'dim-list', style: 'margin-top:10px'}, original.files.map(file => el('div', {class: 'dim original-file'},
      pathRow(file.path),
      el('div', {class: 'original-file-status'}, el('small', {}, file.existed ? `${file.size} B` : t('originallyAbsent')),
        file.existed ? el('button', {class: 'btn btn-ghost btn-sm', onclick: () => viewOriginal(target, file)}, t('viewOriginal')) : null)))),
    reconstructed ? note('warn', msg({id: 'originals.reconstructed'}),
      original.reasons?.map(row => el('span', {}, displayPath(row.path), ': ', msg(row.reason),
        msgDetail(row.reason) ? el('div', {class: 'mono tech-key'}, msgDetail(row.reason)) : null))) : null,
    el('div', {class: 'original-restore'}, el('button', {class: 'btn btn-danger', disabled: original.restorable === false,
      title: original.restorable === false ? msg({id: original.alreadyOriginal ? 'originals.alreadyOriginal' : 'originals.cycleEnded'}) : '',
      onclick: () => undoFlow(target, true, true)}, msg({id: 'originals.restore'})),
      el('span', {class: 'group-note'}, original.ended ? msg({id: original.alreadyOriginal ? 'originals.alreadyOriginal' : 'originals.cycleEnded'})
        : msg({id: 'originals.date', vars: {date: new Date(original.capturedAt).toLocaleDateString('en-CA')}}))));
}
async function viewOriginal(target, file) {
  try {
    const query = new URLSearchParams({harness: target.harness, home: target.home, id: String(file.id)});
    const original = await api(`/api/original-file?${query}`);
    const done = el('button', {class: 'btn btn-primary'}, t('done'));
    const {close} = openSheet({kicker: t('originalsTitle'), title: t('viewOriginal'), sub: original.path,
      body: sheetBody(el('p', {class: 'group-note'}, t('originalPrivate')),
        el('pre', {class: 'prose'}, original.existed ? original.binary ? t('originalBinary') : original.text : t('originallyAbsent'))), foot: sheetFoot(done)});
    done.addEventListener('click', close);
  } catch (error) { toast(error.message, true); }
}
function renderTools() {
  const host = document.getElementById('screen-tools');
  host.textContent = '';
  const view = state.overview;
  if (!view) { host.append(el('div', {class: 'rows'}, [0, 1, 2, 3].map(() => el('div', {class: 'skel'})))); return; }
  if (!localStorage.getItem('rs.intro')) host.append(el('div', {class: 'intro'},
    el('p', {}, el('b', {}, lang === 'zh' ? '配方' : 'A recipe'), lang === 'zh'
      ? '是一套 AI 编程工具的工作方式：主提示词、子代理提示词，加上每轮的小提醒。在这里挑一份装进你的工具，随时切换或还原；写入前都会先给你看改动。'
      : ' is a working style for an AI coding tool: the main prompt, the subagent prompt and short per-turn reminders. Pick one, install it into your tools, switch or restore any time; every write is previewed first.'),
    el('div', {class: 'intro-actions'},
      el('button', {class: 'btn btn-primary', onclick: () => tour(0)}, t('help')),
      el('button', {class: 'btn', onclick: () => { localStorage.setItem('rs.intro', '1'); renderTools(); }}, lang === 'zh' ? '知道了' : 'Got it'))));
  const present = view.targets.filter(target => target.present), absent = view.targets.filter(target => !target.present);
  host.append(el('div', {class: 'group-head'}, el('h2', {class: 'group-title'}, t('navTools')), el('span', {class: 'group-note'}, t('toolsDetected', present.length))));
  host.append(el('div', {class: 'rows'}, present.map(toolRow)));
  if (absent.length) {
    host.append(el('div', {class: 'group-head'}, el('h2', {class: 'group-title'}, t('notFound'))));
    host.append(el('div', {class: 'rows'}, absent.map(toolRow)));
  }
  if (view.uncovered?.length) {
    host.append(el('div', {class: 'group-head'}, el('h2', {class: 'group-title'}, t('uncovered'))));
    host.append(el('p', {class: 'group-note', style: 'margin:0 4px 8px'}, t('uncoveredNote')));
    host.append(el('div', {class: 'dim-list'}, view.uncovered.map(item => el('div', {class: 'dim'}, el('b', {}, item.name), msg(item.reason)))));
  }
}

// ---------------------------------------------------------------- install / switch flow
function pickRecipe(target) {
  const recipes = state.recipes?.recipes ?? [], current = target.managed?.recipe;
  if (!recipes.length) { toast(t('noRecipes'), true); return; }
  if (recipes.length === 1 && !current) { configure(target, recipes[0], {}); return; }
  const {close} = openSheet({kicker: target.name, title: t('pickRecipe'), steps: [0, 3],
    body: sheetBody(el('div', {class: 'pick'}, recipes.map(recipe => el('button', {
      class: `pick-item${current?.key === recipe.key ? ' is-current' : ''}`,
      onclick: () => { close(); configure(target, recipe, current?.key === recipe.key ? {recipeOptions: current.optionValues} : {}); },
    }, el('b', {}, recipe.name), el('em', {}, `v${recipe.version}${current?.key === recipe.key ? ` · ${t('current')}` : ''}`),
      el('span', {}, sampleText(recipe.description) || recipe.origin))))),
    foot: sheetFoot(el('button', {class: 'btn', onclick: () => close()}, t('cancel')))});
}

const toolFieldLabel = key => ({models: t('models'), rootRole: t('rootRole'), providers: t('providers'), modelIdPattern: t('modelPattern'), grantConversationAccess: msg({id: 'openclaw.option.grant'})})[key];
function toolFields(target, saved = {}) {
  const fields = [];
  for (const opt of target.options ?? []) {
    const label = toolFieldLabel(opt.key) ?? msg(opt.label) ?? opt.label;
    if (opt.type === 'boolean') {
      const box = el('input', {type: 'checkbox', 'aria-label': label, 'data-option': opt.key});
      box.checked = opt.consent ? false : Boolean(saved[opt.key]);
      const hint = opt.consent ? (opt.denied ? msg({id: 'openclaw.option.grantDenied'}) : msg({id: 'openclaw.option.grantHint'})) : null;
      fields.push({node: el('label', {class: 'opt'}, el('span', {class: 'opt-name'}, label),
        hint ? el('span', {class: 'opt-desc'}, hint) : null,
        opt.consent ? el('span', {class: 'opt-where'}, el('span', {class: 'mono tech-key'}, 'plugins.entries.recipe-switch.hooks.allowConversationAccess')) : null,
        el('span', {class: 'switch'}, box, el('span'))),
        read: () => ({[opt.key]: box.checked}), valid: () => true});
    } else if (opt.type === 'multi') {
      const pre = new Set([].concat(saved[opt.key] ?? []));
      const list = el('div', {class: 'opts'}, (target.choices?.models ?? []).map(choice => {
        const box = el('input', {type: 'checkbox', value: choice}); box.checked = pre.has(choice);
        return el('label', {class: 'opt'}, el('span', {class: 'opt-name mono'}, choice), el('span', {class: 'switch'}, box, el('span')));
      }));
      fields.push({node: el('div', {class: 'field'}, el('span', {class: 'field-label'}, `${label}${opt.required ? ' *' : ''}`), list),
        read: () => ({[opt.key]: [...list.querySelectorAll('input:checked')].map(i => i.value)}),
        valid: () => !opt.required || list.querySelectorAll('input:checked').length > 0});
    } else if (opt.type === 'select') {
      const select = el('select', {class: 'input'}, (opt.choices ?? []).map(c => el('option', {value: c, selected: (saved[opt.key] ?? opt.choices?.[0]) === c}, c)));
      fields.push({node: el('label', {class: 'field'}, el('span', {class: 'field-label'}, label), select), read: () => ({[opt.key]: select.value}), valid: () => true});
    } else {
      const input = el('input', {class: 'input', type: 'text', value: saved[opt.key] ?? '', spellcheck: 'false'});
      fields.push({node: el('label', {class: 'field'}, el('span', {class: 'field-label'}, label), input),
        read: () => input.value.trim() ? {[opt.key]: input.value.trim()} : {}, valid: () => !opt.required || Boolean(input.value.trim())});
    }
  }
  return fields;
}
/** Slot ids ("main.system", "sub.steering", "main.steering_sources.task…") → deduped human labels. */
function affectsChips(slots) {
  const labels = new Set();
  for (const slot of slots ?? []) {
    const [branch, rest = ''] = slot.includes('.') && /^(main|sub|independent)\./.test(slot) ? [slot.split('.')[0], slot.split('.').slice(1).join('.')] : ['sub', slot];
    const steer = /steering/.test(rest);
    const key = !steer ? (branch === 'independent' ? 'independent' : branch) : /agent|task/.test(rest) ? 'agentSteer' : branch === 'main' ? 'userSteer' : 'subSteer';
    labels.add(STRINGS[lang].texts[key]);
  }
  return [...labels].map(label => el('span', {class: 'chip'}, label));
}
function recipeSwitches(recipe, values = {}) {
  const options = recipe.options ?? [];
  if (!options.length) return null;
  const list = el('div', {class: 'opts'}, options.map(option => {
    const box = el('input', {type: 'checkbox', 'data-id': option.id, 'aria-label': sampleText(option.name)});
    box.checked = values[option.id] ?? option.default;
    const item = el('label', {class: 'opt'}, el('span', {class: 'opt-name'}, sampleText(option.name)),
      option.description ? el('span', {class: 'opt-desc'}, sampleText(option.description)) : null,
      el('span', {class: 'opt-where'}, el('span', {class: 'group-note'}, option.default ? t('defaultOn') : t('defaultOff')),
        affectsChips(option.affects)),
      el('span', {class: 'switch'}, box, el('span')));
    box.addEventListener('change', () => item.classList.toggle('is-changed', box.checked !== (values[option.id] ?? option.default)));
    return item;
  }));
  return {node: el('div', {class: 'field'}, el('span', {class: 'field-label'}, t('recipeOptions')), list),
    read: () => Object.fromEntries([...list.querySelectorAll('input')].map(i => [i.dataset.id, i.checked]))};
}
function diffNode(text) {
  const box = el('div', {class: 'diff'});
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    box.append(el('div', {class: cls}, line || ' '));
  }
  return box;
}
function fileNode(file, open) {
  const details = el('details', {class: 'file'}, el('summary', {},
    el('span', {class: `file-act ${file.action}`}, msg({id: `action.${file.action}`})),
    el('span', {class: 'file-path', title: file.path}, el('bdi', {}, displayPath(file.path))),
    el('span', {class: 'file-count'}, el('span', {class: 'a'}, `+${file.added}`), el('span', {class: 'd'}, `−${file.removed}`))),
    diffNode(file.diff));
  details.open = open;
  return details;
}
function transit(fromLabel, toLabel) {
  return el('div', {class: 'transit'},
    el('div', {class: 'transit-end'}, el('small', {}, t('from')), el('b', {}, fromLabel)),
    svg(ICON.arrow, 'transit-arrow'),
    el('div', {class: 'transit-end'}, el('small', {}, t('to')), el('b', {}, toLabel)));
}
/** Show the managed-vs-live diff for one hand-edited file (R08: server redacts). */
async function viewYourEdit(target, filePath) {
  try {
    const data = await api(`/api/drift-diff?${new URLSearchParams({harness: target.harness, home: target.home, path: filePath})}`);
    const done = el('button', {class: 'btn btn-primary'}, t('done'));
    const {close} = openSheet({kicker: t('drift'), title: t('yourEdit'), sub: filePath,
      body: sheetBody(el('p', {class: 'group-note'}, data.state === 'missing' ? t('handEdit') : t('yourEdit')),
        data.state === 'missing' ? el('p', {class: 'empty'}, t('nothingToWrite')) : diffNode(data.diff)),
      foot: sheetFoot(done)});
    done.addEventListener('click', close);
  } catch (error) { toast(error.message, true); }
}
/** Blocked note with an explicit, backed-up override. onForce re-previews with force=true. */
function blockedNote(planned, onForce, target) {
  if (planned.force) return note('warn', t('forcedTitle'), [t('forcedBody')]);
  const items = [];
  for (const item of planned.blocked ?? []) {
    if (item.kind === 'hand-edit') {
      items.push(el('li', {}, `${t('handEdit')} · ${displayPath(item.path)}`,
        target ? el('button', {class: 'btn btn-ghost btn-xs', onclick: () => viewYourEdit(target, item.path)}, t('seeYourEdit')) : null));
    } else if (item.kind === 'conflict') {
      items.push(el('li', {}, `${t('blockedTitle')} · ${displayPath(item.path)}`));
    } else if (item.kind === 'foreign') {
      items.push(el('li', {}, `${msg(item.text)}: ${msg(item.detail)}`));
    } else {
      items.push(el('li', {}, msg(item.text ?? item), msgDetail(item.text) ?
        el('details', {}, el('summary', {}, t('techDetails')), el('div', {class: 'mono tech-key'}, msgDetail(item.text))) : null));
    }
  }
  if (!items.length) return null;
  const box = el('div', {class: 'note bad'}, el('b', {}, t('blockedTitle')), el('ul', {}, items));
  if (onForce) box.append(el('p', {class: 'note-hint'}, t('blockedHint')),
    el('div', {class: 'blocked-actions'},
      el('button', {class: 'btn btn-sm', onclick: () => { const sheet = document.querySelector('.sheet'); sheet?.closest('#sheetMount')?.firstChild?.dispatchEvent(new Event('click')); }}, t('keepMine')),
      el('button', {class: 'btn btn-danger btn-sm', onclick: onForce}, t('forceBtn'))));
  return box;
}
/** A notes/warnings list: localized text, with technical detail behind a disclosure. */
function noteItems(list) {
  const out = [];
  for (const item of list ?? []) {
    const text = item.kind === 'foreign' ? `${msg(item.text)}: ${msg(item.detail)}` : msg(item);
    const detail = item.kind === 'foreign' ? msgDetail(item.detail) : msgDetail(item);
    out.push(detail ? el('li', {}, text, el('details', {}, el('summary', {}, t('techDetails')),
      el('div', {class: 'mono tech-key'}, detail))) : el('li', {}, text));
  }
  return out;
}
function planNodes(planned, fromLabel, toLabel, onForce, target) {
  const nodes = [transit(fromLabel, toLabel),
    blockedNote(planned, onForce, target),
    planned.warnings?.length ? el('div', {class: 'note warn'}, el('b', {}, t('warnTitle')), el('ul', {}, noteItems(planned.warnings))) : null,
    planned.notes?.length ? el('div', {class: 'note info'}, el('b', {}, t('notesTitle')), el('ul', {}, noteItems(planned.notes))) : null];
  const files = planned.files ?? [];
  nodes.push(el('div', {class: 'files-head'}, el('h3', {class: 'group-title'}, t('preview')), el('span', {class: 'group-note'}, t('files', files.length))));
  if (!files.length) nodes.push(el('p', {class: 'empty'}, planned.noChange ? t('noChange') : t('nothingToWrite')));
  files.forEach((file, i) => nodes.push(fileNode(file, files.length <= 2 || (i === 0 && file.action !== 'create'))));
  if (planned.launch) nodes.push(el('div', {class: 'launch'}, el('span', {class: 'field-label'}, t('launchTitle')), el('code', {}, planned.launch)));
  if (planned.reconstructed) nodes.push(el('p', {class: 'group-note'}, t('reconstructedWarn')));
  return nodes;
}

/** Step 2 + 3: options, live preview, apply. */
function configure(target, recipe, {recipeOptions} = {}) {
  const saved = target.managed?.installed ? target.managed?.options ?? {} : {};
  const fields = toolFields(target, saved), switches = recipeSwitches(recipe, recipeOptions ?? {});
  const planHost = el('div', {style: 'display:grid;gap:12px'}, el('div', {class: 'skel', style: 'min-height:140px'}));
  const apply = el('button', {class: 'btn btn-signal', disabled: true}, t('apply'));
  const cancel = el('button', {class: 'btn'}, t('cancel'));
  const errorLine = el('div', {class: 'foot-error', hidden: true});
  const needed = (target.options ?? []).some(opt => opt.required || opt.consent);
  const toolBox = fields.length ? (needed
    ? el('div', {class: 'field'}, el('span', {class: 'field-label'}, t('toolOptions')), fields.map(f => f.node))
    : el('details', {class: 'more'}, el('summary', {}, t('toolOptions'), el('span', {class: 'group-note'}, t('optional'))), el('div', {class: 'more-body'}, fields.map(f => f.node)))) : null;
  const settings = [switches?.node, toolBox];
  const current = target.managed?.recipe;
  const {close, sheet} = openSheet({kicker: target.name + (target.label ? ` · ${target.label}` : ''),
    title: `${recipe.name} · v${recipe.version}`, sub: displayPath(target.home), steps: [1, 3],
    body: sheetBody(settings, planHost), foot: el('div', {class: 'sheet-footer'}, errorLine, sheetFoot(cancel, apply))});
  cancel.addEventListener('click', close);
  let planned = null, seq = 0, force = false;
  const run = async () => {
    errorLine.hidden = true;
    if (fields.some(field => !field.valid())) { planHost.textContent = ''; planHost.append(el('p', {class: 'empty'}, t('required'))); apply.disabled = true; return; }
    const mine = ++seq;
    apply.disabled = true;
    planHost.style.opacity = '.5';
    try {
      const result = await api('/api/preview', {method: 'POST', body: {harness: target.harness, home: target.home, recipe: recipe.key,
        options: Object.assign({}, ...fields.map(f => f.read())), recipeOptions: switches?.read(), force}});
      if (mine !== seq) return;
      planned = result;
      planHost.textContent = '';
      planHost.append(...planNodes(planned, current ? `${current.name} v${current.version}` : t('original'), `${recipe.name} v${recipe.version}`,
        () => { force = true; run(); }, target).filter(Boolean));
      apply.disabled = Boolean(planned.blocked?.length) || !planned.files?.length;
      if (planned.blocked?.length) { errorLine.hidden = false; errorLine.textContent = t('resolveDriftFirst'); errorLine.style.color = 'var(--ink-3)'; }
      else { errorLine.style.color = ''; }
    } catch (error) {
      if (mine !== seq) return;
      planHost.textContent = ''; errorLine.hidden = false; errorLine.textContent = error.message; errorLine.style.color = '';
    } finally { if (mine === seq) planHost.style.opacity = ''; }
  };
  sheet.querySelector('.sheet-body').addEventListener('change', event => { if (!planHost.contains(event.target)) run(); });
  apply.addEventListener('click', async () => {
    if (!planned) return;
    apply.disabled = true; apply.textContent = t('applying');
    try {
      const result = await api('/api/apply', {method: 'POST', body: {planId: planned.id}});
      close();
      await refresh();
      showResult(planned.kind === 'switch' ? t('resultSwitched') : t('resultInstalled'), result);
    } catch (error) { apply.textContent = t('apply'); errorLine.hidden = false; errorLine.textContent = error.message; apply.disabled = false; }
  });
  run();
}
// ---------------------------------------------------------------- rollback / restore
async function undoFlow(target, all, original = false) {
  const action = original ? t('restoreOriginal') : all ? t('uninstall') : t('rollback');
  const apply = el('button', {class: `btn ${all ? 'btn-danger' : 'btn-primary'}`, disabled: true}, action);
  const cancel = el('button', {class: 'btn'}, t('cancel'));
  const errorLine = el('div', {class: 'foot-error', hidden: true});
  const host = el('div', {style: 'display:grid;gap:12px'}, el('div', {class: 'skel', style: 'min-height:140px'}));
  const {close} = openSheet({kicker: target.name, title: action, sub: displayPath(target.home),
    body: sheetBody(original ? note('warn', t('originalsTitle'), [t('originalRestoreHint')]) : null, host), foot: el('div', {class: 'sheet-footer'}, errorLine, sheetFoot(cancel, apply))});
  cancel.addEventListener('click', close);
  let planned;
  const load = async force => {
    try {
      planned = await api(original ? '/api/preview-original' : '/api/preview-undo', {method: 'POST', body: {harness: target.harness, home: target.home, all, force: force || undefined}});
      const now = target.managed?.recipe;
      host.textContent = '';
      host.append(...planNodes(planned, now ? `${now.name} v${now.version}` : '—', planned.restores ? `${planned.restores.name} v${planned.restores.version}` : t('original'),
        original && planned.reconstructed ? null : () => load(true), target).filter(Boolean));
      if (original && planned.reconstructed && !force) host.append(note('warn', msg({id: 'originals.reconstructed'}), [
        el('button', {class: 'btn btn-danger', onclick: () => load(true)}, msg({id: 'originals.confirmReconstructed'}))]));
      apply.disabled = Boolean(planned.blocked?.length) || Boolean(planned.noChange);
      errorLine.hidden = !planned.noChange && !planned.blocked?.length;
      errorLine.textContent = planned.noChange ? msg({id: 'originals.alreadyOriginal'}) : t('resolveDriftFirst');
      errorLine.style.color = 'var(--ink-3)';
    } catch (error) { host.textContent = ''; errorLine.hidden = false; errorLine.textContent = error.message; }
  };
  await load(false);
  apply.addEventListener('click', async () => {
    apply.disabled = true; apply.textContent = t('applying');
    try {
      const result = await api('/api/apply', {method: 'POST', body: {planId: planned.id}});
      close(); await refresh();
      showResult(original ? t('resultOriginal') : all ? t('resultRestored') : t('resultRolledBack'), result);
    } catch (error) { errorLine.hidden = false; errorLine.textContent = error.message; apply.disabled = false; apply.textContent = action; }
  });
}

function showResult(title, result) {
  const done = el('button', {class: 'btn btn-primary'}, t('done'));
  const body = [el('div', {class: 'result-mark'}, svg(ICON.check)), el('p', {class: 'result-line'}, title)];
  // Lead with the next step for fresh installs.
  if ((result.code === 'installed' || result.code === 'switched') && !result.launch) body.push(el('p', {class: 'result-next'}, t('nextStepCodex')));
  if (result.message) body.push(el('p', {class: 'result-sub'}, msg(result.message)));
  if (result.backup) body.push(el('div', {class: 'result-row'},
    el('span', {class: 'field-label'}, t('backupSaved')), pathRow(result.backup)));
  for (const version of result.replacedVersions ?? []) body.push(el('div', {class: 'result-row'},
    el('span', {class: 'field-label'}, t('replacedAt')), pathRow(version.saved)));
  if (result.launch) body.push(el('div', {class: 'launch'}, el('span', {class: 'field-label'}, t('launchTitle')), el('code', {}, result.launch)));
  if (result.notes?.length) body.push(el('div', {class: 'note info'}, el('b', {}, t('notesTitle')), el('ul', {}, noteItems(result.notes))));
  const {close} = openSheet({title: '', steps: null, body: sheetBody(...body), foot: sheetFoot(done)});
  done.addEventListener('click', close);
}
// ---------------------------------------------------------------- recipes screen
function renderRecipes() {
  const host = document.getElementById('screen-recipes');
  host.textContent = '';
  const list = state.recipes?.recipes ?? [];
  host.append(el('div', {class: 'group-head'}, el('h2', {class: 'group-title'}, t('navRecipes')), el('span', {class: 'group-note'}, String(list.length))));
  if (!list.length) host.append(el('p', {class: 'empty'}, t('noRecipes')));
  for (const recipe of list) {
    const users = (state.overview?.targets ?? []).filter(target => target.managed?.recipe?.key === recipe.key);
    host.append(el('article', {class: 'recipe'},
      el('div', {class: 'recipe-head'}, el('h3', {class: 'recipe-name'}, recipe.name), el('span', {class: 'recipe-ver'}, `v${recipe.version}`)),
      recipe.description ? el('p', {class: 'recipe-desc'}, sampleText(recipe.description)) : null,
      el('div', {class: 'recipe-meta'}, el('span', {class: 'chip'}, recipe.kind === 'author-repo' ? 'author repo' : 'recipe.toml'),
        users.map(target => el('span', {class: 'chip ok'}, target.name + (target.label ? ` · ${target.label}` : '')))),
      recipe.options?.length ? el('div', {class: 'opts'}, recipe.options.map(option => el('div', {class: 'opt'},
        el('span', {class: 'opt-name'}, sampleText(option.name)), option.description ? el('span', {class: 'opt-desc'}, sampleText(option.description)) : null,
        el('span', {class: 'opt-where'}, el('span', {class: `chip ${option.default ? 'ok' : ''}`}, option.default ? t('defaultOn') : t('defaultOff')),
          affectsChips(option.affects))))) : el('p', {class: 'group-note', style: 'margin:0'}, t('noOptions')),
      el('div', {class: 'texts'}, Object.keys(STRINGS.en.texts).map(key => el('button', {
        class: `text-cell${recipe.sizes?.[key] ? '' : ' is-empty'}`, onclick: () => viewTexts(recipe, key)},
        el('b', {}, STRINGS[lang].texts[key]), el('span', {}, recipe.sizes?.[key] ? `${(recipe.sizes[key] / 1000).toFixed(1)}k` : t('empty'))))),
      el('div', {style: 'display:flex;justify-content:flex-start'}, pathRow(recipe.origin, {cls: 'recipe-origin'}))));
  }
  for (const error of state.recipes?.errors ?? []) host.append(note('bad', t('sourceErrors'), [`${displayPath(error.locator)} — ${error.error}`]));
}

async function viewTexts(recipe, first) {
  const switches = recipeSwitches(recipe, {});
  const seg = el('div', {class: 'seg'}), pre = el('pre', {class: 'prose'}, '…');
  let texts = {}, active = first;
  const show = key => { active = key; for (const b of seg.children) b.classList.toggle('is-active', b.dataset.k === key); pre.textContent = texts[key] || `(${t('empty')})`; };
  for (const key of Object.keys(STRINGS.en.texts)) seg.append(el('button', {'data-k': key, onclick: () => show(key)}, STRINGS[lang].texts[key]));
  const load = async () => {
    const options = switches ? JSON.stringify(switches.read()) : '';
    const data = await api(`/api/recipe?key=${encodeURIComponent(recipe.key)}${options ? `&options=${encodeURIComponent(options)}` : ''}`);
    texts = data.texts ?? {}; show(active);
  };
  const close = openSheet({kicker: t('viewText'), title: recipe.name, sub: `v${recipe.version}`,
    body: sheetBody(switches?.node, seg, pre), foot: sheetFoot(el('button', {class: 'btn', onclick: () => close()}, t('done')))}).close;
  switches?.node.addEventListener('change', () => load().catch(error => toast(error.message, true)));
  load().catch(error => { pre.textContent = error.message; });
}

// ---------------------------------------------------------------- sources screen
function renderSources() {
  const host = document.getElementById('screen-sources');
  host.textContent = '';
  const config = state.config ?? {sources: [], gwt: ''};
  const lines = el('div', {style: 'display:grid;gap:6px'});
  const addLine = value => {
    const input = el('input', {class: 'input', value: value ?? '', spellcheck: 'false', placeholder: 'C:/path/to/recipes'});
    const row = el('div', {class: 'source-row'}, input, el('button', {class: 'btn btn-ghost', 'aria-label': 'remove', onclick: () => row.remove()}, '×'));
    lines.append(row);
  };
  config.sources.forEach(addLine);
  const gwt = el('input', {class: 'input', value: config.gwt ?? '', spellcheck: 'false'});
  const save = el('button', {class: 'btn btn-primary'}, t('save'));
  save.addEventListener('click', async () => {
    const sources = [...lines.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
    try {
      state.config = await api('/api/config', {method: 'POST', body: {sources, gwt: gwt.value.trim() || undefined}});
      await refresh(); toast(t('saved'));
    } catch (error) { toast(error.message, true); }
  });
  host.append(...[
    el('div', {class: 'group-head'}, el('h2', {class: 'group-title'}, t('sourcesTitle'))),
    el('div', {class: 'panel'},
      el('div', {class: 'field'}, el('span', {class: 'field-label'}, t('sourcesTitle')), el('span', {class: 'field-hint'}, t('sourcesHint')), lines,
        el('div', {}, el('button', {class: 'btn', onclick: () => addLine('')}, t('addSource')))),
      el('label', {class: 'field'}, el('span', {class: 'field-label'}, t('gwtLabel')), el('span', {class: 'field-hint'}, t('gwtHint')), gwt),
      el('div', {}, save)),
    state.recipes?.errors?.length ? note('bad', t('sourceErrors'), state.recipes.errors.map(error => `${displayPath(error.locator)} — ${error.error}`)) : null,
    el('p', {class: 'group-note', style: 'margin:14px 4px'}, `${t('stateHome')} `, pathRow(state.overview?.stateHome ?? '')),
  ].filter(Boolean));
}
// ---------------------------------------------------------------- in-app guide
const TOUR = {
  zh: [
    {title: '它做什么', body: '一份配方是一套 AI 编程工具的工作方式：主提示词、子代理提示词，以及每轮的小提醒。recipe-switch 把配方装进你电脑上的 Codex、Claude Code、Kiki、Pi 等工具，随时切换或还原。',
      list: ['只改提示词相关的文件和少量配置', '不碰模型、provider 和登录；OpenClaw 对话访问权限只有你主动勾选才会写入']},
    {title: '装一份配方', body: '在「工具」里点开一个工具，选「装上配方」。',
      list: ['挑一份配方', '按需打开或关闭配方选项，下方实时显示每个文件的改动', '确认后才写入，写入前自动备份'],
      legend: '主代理 / 子代理 / 独立 = 提示词槽位；用户提醒 / 子代理提醒 / 结果提醒 = 每轮注入的小提醒。'},
    {title: '需要你设置的地方', body: '个别工具需要你选择作用范围或授权，界面里会直接问：',
      list: ['Kiki：选要绑定配方的模型（至少一个）', 'DSH：每个 profile 单独装，可选根代理角色', 'Pi：可限定 provider 或模型 id，留空就是全部', 'Claude Code：不改设置，装好后给你一条启动命令', 'OpenClaw：非内置插件需要对话访问权限。默认不写；在工具设置里主动勾选「授予 recipe-switch 插件对话访问权限」才会写入 plugins.entries.recipe-switch.hooks.allowConversationAccess，卸载时还原。已有 false 需你手动更改，强制覆盖也不会替你授权。']},
    {title: '手改与还原', body: '装上的文件带有标记。你手动改过它们时，工具上会显示「有手改」，切换或还原都会停下来让你先处理，不会悄悄覆盖。',
      list: ['撤回上一步：回到上一个配方', '还原：恢复到安装前的原样，逐字节一致', '备份和记录在「来源」页底部显示的目录里']},
    {title: '配方从哪来', body: '「来源」页列出要扫描的目录。gpt-with-taste 是默认来源；任何带 recipe.toml 的目录都能加进来，包括 Kiki 的配方包。'},
  ],
  en: [
    {title: 'What it does', body: 'A recipe is a working style for an AI coding tool: the main prompt, the subagent prompt and short per-turn reminders. recipe-switch installs recipes into the tools on this computer (Codex, Claude Code, Kiki, Pi…), and switches or restores them any time.',
      list: ['Writes prompt files and a few config entries', 'Leaves models, providers and sign-in alone; writes OpenClaw conversation access only when you actively select the grant']},
    {title: 'Install a recipe', body: 'Open a tool under Tools and choose Install a recipe.',
      list: ['Pick a recipe', 'Turn recipe options on or off; the diff below updates live', 'Nothing is written until you confirm; a backup is taken first'],
      legend: 'Main / Subagent / Independent are prompt slots; user / subagent / result reminders are short per-turn injections.'},
    {title: 'Settings you may be asked for', body: 'A few tools need a scope or permission; the panel asks right there:',
      list: ['Kiki: choose which models get the recipe (at least one)', 'DSH: install per profile, optionally pick the root role', 'Pi: optionally limit to providers or model ids', 'Claude Code: settings stay untouched; you get a launch command', 'OpenClaw: non-bundled plugins need conversation access. It stays unset by default. Actively select “Grant recipe-switch conversation access” in Tool settings to write plugins.entries.recipe-switch.hooks.allowConversationAccess; uninstall restores it. Change an existing false manually; force never grants it.']},
    {title: 'Hand edits and restore', body: 'Installed files are marked. If you edit one by hand the tool shows Edited, and switching or restoring stops until you decide; nothing is silently overwritten.',
      list: ['Undo last change: back to the previous recipe', 'Restore: byte-for-byte back to before the install', 'Backups and history live in the folder shown under Sources']},
    {title: 'Where recipes come from', body: 'Sources lists the folders to scan. gpt-with-taste is the default; any folder with a recipe.toml works, including Kiki recipe packages.'},
  ],
};
const TOUR_ART = [
  '<rect x="20" y="40" width="70" height="42" rx="21" fill="none" stroke="#f3efe6" stroke-width="3"/><circle cx="69" cy="61" r="14" fill="#e2531c"/><rect x="120" y="40" width="70" height="42" rx="21" fill="none" stroke="#57534b" stroke-width="3"/><circle cx="141" cy="61" r="14" fill="#57534b"/>',
  '<rect x="30" y="26" width="150" height="20" rx="10" fill="#f3efe6" opacity=".15"/><rect x="30" y="54" width="150" height="20" rx="10" fill="#e2531c"/><rect x="30" y="82" width="150" height="20" rx="10" fill="#f3efe6" opacity=".15"/>',
  '<rect x="40" y="30" width="130" height="66" rx="10" fill="none" stroke="#f3efe6" stroke-width="2.5"/><path d="M58 52h50M58 66h80M58 80h36" stroke="#f3efe6" stroke-width="3" stroke-linecap="round" opacity=".6"/><circle cx="150" cy="80" r="8" fill="#e2531c"/>',
  '<path d="M60 63a40 40 0 1 1 12 28" fill="none" stroke="#f3efe6" stroke-width="3" stroke-linecap="round"/><path d="M56 48v16h16" fill="none" stroke="#e2531c" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M40 42h40l10 12h80v44H40z" fill="none" stroke="#f3efe6" stroke-width="2.5" stroke-linejoin="round"/><rect x="100" y="70" width="44" height="10" rx="5" fill="#e2531c"/>',
];
function tour(index) {
  const pages = TOUR[lang], page = pages[index];
  const back = el('button', {class: 'btn'}, index ? t('back') : t('cancel'));
  const next = el('button', {class: 'btn btn-primary'}, index === pages.length - 1 ? t('start') : t('next'));
  const art = el('div', {class: 'tour-art'}); art.innerHTML = `<svg viewBox="0 0 210 126" aria-hidden="true">${TOUR_ART[index]}</svg>`;
  const {close} = openSheet({kicker: `${t('help')} · ${index + 1}/${pages.length}`, title: page.title,
    body: sheetBody(el('div', {class: 'tour'}, art, el('p', {}, page.body), page.list ? el('ol', {}, page.list.map(item => el('li', {}, item))) : null,
      page.legend ? el('p', {class: 'group-note', style: 'margin:0'}, page.legend) : null,
      el('div', {class: 'dots'}, pages.map((_, i) => el('i', {class: i === index ? 'is-now' : ''}))))),
    foot: sheetFoot(back, next)});
  back.addEventListener('click', () => { close(); if (index) tour(index - 1); });
  next.addEventListener('click', () => { close(); if (index < pages.length - 1) tour(index + 1); else { localStorage.setItem('rs.intro', '1'); renderTools(); } });
}

// ---------------------------------------------------------------- boot
function show(screen) {
  state.screen = screen;
  for (const node of document.querySelectorAll('.screen')) node.classList.toggle('is-active', node.id === `screen-${screen}`);
  for (const node of document.querySelectorAll('.dock-item')) { const on = node.dataset.screen === screen; node.classList.toggle('is-active', on); node.setAttribute('aria-selected', String(on)); }
}
function renderAll() { applyStatic(); renderTools(); renderRecipes(); renderSources(); }
async function refresh() {
  const button = document.getElementById('refreshBtn');
  button.classList.add('is-spinning');
  try {
    const [overview, recipes, config] = await Promise.all([api('/api/overview'), api('/api/recipes'), api('/api/config')]);
    Object.assign(state, {overview, recipes, config});
    renderAll();
  } catch (error) { toast(`${t('loadFailed')}: ${error.message}`, true); }
  finally { button.classList.remove('is-spinning'); }
}

for (const node of document.querySelectorAll('.dock-item')) node.addEventListener('click', () => show(node.dataset.screen));
document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('helpBtn').addEventListener('click', () => tour(0));
document.getElementById('langBtn').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('rs.lang', lang); renderAll(); });
applyStatic();
renderTools();
refresh();
