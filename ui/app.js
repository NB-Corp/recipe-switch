// recipe-switch panel. Talks to the local server with the per-process token.
const TOKEN = document.querySelector('meta[name="recipe-switch-token"]')?.content ?? '';
const state = {overview: null, recipes: null, config: null, open: new Set(), screen: 'tools'};

// ---------------------------------------------------------------- i18n
const STRINGS = {
  zh: {
    tagline: '给 AI 编程工具换一套系统提示词', navTools: '工具', navRecipes: '配方', navSources: '来源',
    installed: '已装', notInstalled: '未装', notFound: '未检测到', drift: '有手改', blocked: '需处理',
    noRecipe: '使用工具自带的提示词', since: '自', detail: '详情', home: '位置', writes: '写入方式', steer: '每轮提醒',
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
    gwtLabel: 'gpt-with-taste 位置', gwtHint: '各工具的适配器从这里取（插件、清单格式等）。', addSource: '添加一行', save: '保存',
    saved: '已保存', sourceErrors: '读取失败的来源', stateHome: '状态与备份保存在', noRecipes: '没找到配方。到「来源」里加一个目录。',
    loadFailed: '加载失败', required: '先选好必填项', models: '要绑定的模型', rootRole: '根代理角色',
    providers: '只对这些 provider 生效（逗号分隔，留空为全部）', modelPattern: '只对匹配的模型 id 生效（正则，留空为全部）',
    conversationGrant: '授予 recipe-switch 插件对话访问权限',
    conversationGrantHint: 'OpenClaw 对非内置插件要求此项，写在 plugins.entries.recipe-switch.hooks.allowConversationAccess。默认不勾选；卸载时还原。已有 false 需你先手动更改。',
    blockedHint: '你手动改过这些文件。可以先去工具里把改动挪走；或者直接覆盖，写入前会先备份你的版本，完成后显示备份位置。',
    handEdit: '被手动改过', forceBtn: '仍然覆盖（先备份）', forcedTitle: '将覆盖手改', forcedBody: '你的手改版本会先备份，然后被覆盖。',
    optional: '可选，默认全部生效', help: '使用说明', refresh: '刷新', changedOptions: '选项已改，未写入', liveOther: '非本工具写入',
  },
  en: {
    tagline: 'Swap the system prompt of your AI coding tools', navTools: 'Tools', navRecipes: 'Recipes', navSources: 'Sources',
    installed: 'On', notInstalled: 'Off', notFound: 'Not found', drift: 'Edited', blocked: 'Needs attention',
    noRecipe: 'Using the tool\'s own prompt', since: 'since', detail: 'Details', home: 'Home', writes: 'Writes', steer: 'Reminders',
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
    gwtLabel: 'gpt-with-taste checkout', gwtHint: 'Harness adapters (plugins, manifests) come from here.', addSource: 'Add line', save: 'Save',
    saved: 'Saved', sourceErrors: 'Sources that failed to load', stateHome: 'State and backups live in', noRecipes: 'No recipes found. Add a directory under Sources.',
    loadFailed: 'Failed to load', required: 'Fill in the required settings first', models: 'Models to bind', rootRole: 'Root agent role',
    providers: 'Only these providers (comma separated, empty = all)', modelPattern: 'Only model ids matching (regex, empty = all)',
    conversationGrant: 'Grant recipe-switch conversation access',
    conversationGrantHint: 'OpenClaw requires this for non-bundled plugins: plugins.entries.recipe-switch.hooks.allowConversationAccess. Off by default; restored on uninstall. Change an existing false manually first.',
    blockedHint: 'You edited these files by hand. Move your edits out first, or overwrite: your version is backed up before anything is written.',
    handEdit: 'Edited by hand', forceBtn: 'Overwrite anyway (backed up)', forcedTitle: 'Overwriting hand edits', forcedBody: 'Your edited version is backed up first, then replaced.',
    optional: 'optional; applies everywhere by default', help: 'Guide', refresh: 'Refresh', changedOptions: 'Options changed, not written', liveOther: 'not written by this tool',
  },
};
let lang = localStorage.getItem('rs.lang') ?? (navigator.language?.startsWith('zh') ? 'zh' : 'en');
const t = (key, ...args) => { const value = STRINGS[lang][key] ?? STRINGS.en[key] ?? key; return typeof value === 'function' ? value(...args) : value; };
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
    if (value === null || value === undefined || value === false) continue;
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
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
function fmtTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(+date)) return iso;
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}
const shortPath = p => String(p ?? '').replace(/^[A-Za-z]:\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
function toast(message, bad = false) {
  const node = el('div', {class: `toast${bad ? ' bad' : ''}`}, message);
  document.getElementById('toastMount').append(node);
  setTimeout(() => node.remove(), 3200);
}
const MONO = {codex: 'Cx', claude: 'Cl', kiki: 'Ki', pi: 'Pi', dsh: 'DS', omp: 'Om', grok: 'Gk', opencode: 'Oc', 'kimi-code': 'Km', hermes: 'He', openclaw: 'OC'};
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
  return on.length === options.length ? null : options.map(option => `${(values?.[option.id] ?? option.default) ? '+' : '−'}${option.name}`).join(' ');
}
function toolRow(target) {
  const key = target.key, status = targetState(target), managed = target.managed ?? {};
  const recipeView = (state.recipes?.recipes ?? []).find(recipe => recipe.key === managed.recipe?.key);
  const others = (target.live ?? []).filter(item => item.managed === false);
  const row = el('article', {class: `row${managed.installed ? ' is-on' : ''}${target.present ? '' : ' is-absent'}${state.open.has(key) ? ' is-open' : ''}`});
  const subtitle = managed.installed
    ? el('div', {class: 'row-sub'}, `${managed.recipe.name} · v${managed.recipe.version}`)
    : el('div', {class: 'row-sub is-muted'}, target.present ? t('noRecipe') : shortPath(target.home));
  const lamp = el('span', {class: `lamp ${status.lamp}`}, status.label);
  const flags = el('div', {class: 'row-flags'},
    managed.installed && optionSummary(recipeView, managed.recipe.optionValues) ? el('span', {class: 'chip'}, optionSummary(recipeView, managed.recipe.optionValues)) : null,
    others.length ? el('span', {class: 'chip', title: others.map(o => `${o.label} (${o.where})`).join('\n')}, `${t('others')} ${others.length}`) : null);
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
  const detail = el('div', {class: 'row-detail'},
    el('dl', {class: 'kv'},
      el('dt', {}, t('home')), el('dd', {class: 'mono'}, target.home),
      el('dt', {}, t('writes')), el('dd', {}, target.mechanism),
      target.steer ? [el('dt', {}, t('steer')), el('dd', {}, target.steer)] : null,
      others.length ? [el('dt', {}, t('others')), el('dd', {}, others.map(o => `${o.label} · ${o.where} (${t('liveOther')})`).join('；'))] : null,
      managed.installed ? [el('dt', {}, t('since')), el('dd', {}, fmtTime(managed.since))] : null),
    note('warn', t('drift'), (managed.drift ?? []).map(d => `${shortPath(d.path)} — ${d.state}`)),
    note(target.managed?.installed ? 'info' : 'warn', t('warnTitle'), (target.foreign ?? []).map(f => `${f.what}: ${f.detail}`)),
    target.error ? note('bad', t('loadFailed'), [target.error]) : null,
    managed.history?.length ? el('details', {}, el('summary', {class: 'group-note'}, `${t('history')} · ${managed.history.length}`),
      el('div', {class: 'dim-list', style: 'margin-top:6px'}, managed.history.map(h => el('div', {class: 'dim'}, el('b', {}, h.kind), `${h.recipe ?? ''} · ${fmtTime(h.at)}`)))) : null,
    target.originals ? originalsBlock(target) : null,
    actions);
  row.append(detail);
  return row;
}
function originalsBlock(target) {
  const original = target.originals;
  return el('details', {'data-originals': target.harness},
    el('summary', {class: 'group-note'}, `${t('originalsTitle')} · ${fmtTime(original.capturedAt)}`),
    el('div', {class: 'dim-list', style: 'margin-top:10px'}, original.files.map(file => el('div', {class: 'dim', style: 'flex-wrap:wrap'},
      el('span', {class: 'mono', style: 'flex:1;min-width:180px;overflow-wrap:anywhere'}, file.path),
      el('span', {}, file.existed ? `${file.size} B` : t('originallyAbsent')),
      file.existed ? el('button', {class: 'btn btn-ghost btn-sm', onclick: () => viewOriginal(target, file)}, t('viewOriginal')) : null))),
    original.reconstructed ? note('warn', t('reconstructed'), original.reasons?.map(row => `${row.path}: ${row.reason}`)) : null,
    el('div', {style: 'margin-top:12px'}, el('button', {class: 'btn btn-danger', disabled: original.restorable === false,
      onclick: () => undoFlow(target, true, true)}, t('restoreOriginal')),
      el('span', {class: 'group-note'}, ' ', original.ended ? t(original.alreadyOriginal ? 'alreadyOriginal' : 'originalCycleEnded')
        : t('originalDate', original.capturedAt.slice(0, 10)))));
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
    host.append(el('div', {class: 'dim-list'}, view.uncovered.map(item => el('div', {class: 'dim'}, el('b', {}, item.name), item.reason))));
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
      el('span', {}, recipe.description || recipe.origin))))),
    foot: sheetFoot(el('button', {class: 'btn', onclick: () => close()}, t('cancel')))});
}

const toolFieldLabel = key => ({models: t('models'), rootRole: t('rootRole'), providers: t('providers'), modelIdPattern: t('modelPattern'), grantConversationAccess: t('conversationGrant')})[key];
function toolFields(target, saved = {}) {
  const fields = [];
  for (const opt of target.options ?? []) {
    const label = toolFieldLabel(opt.key) ?? opt.label;
    if (opt.type === 'boolean') {
      const box = el('input', {type: 'checkbox', 'aria-label': label, 'data-option': opt.key});
      box.checked = opt.consent ? false : Boolean(saved[opt.key]);
      fields.push({node: el('label', {class: 'opt'}, el('span', {class: 'opt-name'}, label),
        opt.consent ? el('span', {class: 'opt-desc'}, t('conversationGrantHint')) : null,
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
    const box = el('input', {type: 'checkbox', 'data-id': option.id, 'aria-label': option.name});
    box.checked = values[option.id] ?? option.default;
    const item = el('label', {class: 'opt'}, el('span', {class: 'opt-name'}, option.name),
      option.description ? el('span', {class: 'opt-desc'}, option.description) : null,
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
    el('span', {class: `file-act ${file.action}`}, file.action),
    el('span', {class: 'file-path', title: file.path}, el('bdi', {}, shortPath(file.path))),
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
/** Blocked note with an explicit, backed-up override. onForce re-previews with force=true. */
function blockedNote(planned, onForce) {
  if (planned.force) return note('warn', t('forcedTitle'), [t('forcedBody')]);
  const box = note('bad', t('blockedTitle'), (planned.blocked ?? []).map(line => {
    const m = /^hand edit detected: (.+) \((.+)\)$/.exec(line);
    return m ? `${t('handEdit')} · ${shortPath(m[1])}` : line;
  }));
  if (box && onForce) box.append(el('p', {class: 'note-hint'}, t('blockedHint')),
    el('div', {}, el('button', {class: 'btn btn-danger btn-sm', onclick: onForce}, t('forceBtn'))));
  return box;
}
function planNodes(planned, fromLabel, toLabel, onForce) {
  const nodes = [transit(fromLabel, toLabel),
    blockedNote(planned, onForce), note('warn', t('warnTitle'), planned.warnings), note('info', t('notesTitle'), planned.notes)];
  const files = planned.files ?? [];
  nodes.push(el('div', {class: 'files-head'}, el('h3', {class: 'group-title'}, t('preview')), el('span', {class: 'group-note'}, t('files', files.length))));
  if (!files.length) nodes.push(el('p', {class: 'empty'}, t('nothingToWrite')));
  files.forEach((file, i) => nodes.push(fileNode(file, files.length <= 2 || (i === 0 && file.action !== 'create'))));
  if (planned.launch) nodes.push(el('div', {class: 'launch'}, el('span', {class: 'field-label'}, t('launchTitle')), el('code', {}, planned.launch)));
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
    title: `${recipe.name} · v${recipe.version}`, sub: target.home, steps: [1, 3],
    body: sheetBody(settings, planHost), foot: el('div', {}, errorLine, sheetFoot(cancel, apply))});
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
        () => { force = true; run(); }).filter(Boolean));
      apply.disabled = Boolean(planned.blocked?.length) || !planned.files?.length;
    } catch (error) {
      if (mine !== seq) return;
      planHost.textContent = ''; errorLine.hidden = false; errorLine.textContent = error.message;
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
  const {close} = openSheet({kicker: target.name, title: action, sub: target.home,
    body: sheetBody(original ? note('warn', t('originalsTitle'), [t('originalRestoreHint')]) : null, host), foot: el('div', {}, errorLine, sheetFoot(cancel, apply))});
  cancel.addEventListener('click', close);
  let planned;
  const load = async force => {
    try {
      planned = await api(original ? '/api/preview-original' : '/api/preview-undo', {method: 'POST', body: {harness: target.harness, home: target.home, all, force}});
      const now = target.managed?.recipe;
      host.textContent = '';
      host.append(...planNodes(planned, now ? `${now.name} v${now.version}` : '—', planned.restores ? `${planned.restores.name} v${planned.restores.version}` : t('original'),
        () => load(true)).filter(Boolean));
      if (original && planned.reconstructed && !force) host.append(note('warn', t('reconstructed'), [
        el('button', {class: 'btn btn-danger', onclick: () => load(true)}, t('confirmReconstructed'))]));
      apply.disabled = Boolean(planned.blocked?.length) || Boolean(planned.noChange);
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
  const {close} = openSheet({title: '', steps: null,
    body: sheetBody(el('div', {class: 'result-mark'}, svg(ICON.check)), el('p', {class: 'result-line'}, title),
      result.message ? el('p', {class: 'result-sub'}, result.message) : null,
      result.backup ? el('p', {class: 'result-sub'}, `${t('backupAt')} · ${shortPath(result.backup)}`) : null,
      (result.replacedVersions ?? []).map(version => el('p', {class: 'result-sub'}, `${t('replacedAt')} ${version.saved}`)),
      result.launch ? el('div', {class: 'launch'}, el('span', {class: 'field-label'}, t('launchTitle')), el('code', {}, result.launch)) : null,
      note('info', t('notesTitle'), result.notes)),
    foot: sheetFoot(done)});
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
      recipe.description ? el('p', {class: 'recipe-desc'}, recipe.description) : null,
      el('div', {class: 'recipe-meta'}, el('span', {class: 'chip'}, recipe.kind === 'author-repo' ? 'author repo' : 'recipe.toml'),
        users.map(target => el('span', {class: 'chip ok'}, target.name + (target.label ? ` · ${target.label}` : '')))),
      recipe.options?.length ? el('div', {class: 'opts'}, recipe.options.map(option => el('div', {class: 'opt'},
        el('span', {class: 'opt-name'}, option.name), option.description ? el('span', {class: 'opt-desc'}, option.description) : null,
        el('span', {class: 'opt-where'}, el('span', {class: `chip ${option.default ? 'ok' : ''}`}, option.default ? t('defaultOn') : t('defaultOff')),
          affectsChips(option.affects))))) : el('p', {class: 'group-note', style: 'margin:0'}, t('noOptions')),
      el('div', {class: 'texts'}, Object.keys(STRINGS.en.texts).map(key => el('button', {
        class: `text-cell${recipe.sizes?.[key] ? '' : ' is-empty'}`, onclick: () => viewTexts(recipe, key)},
        el('b', {}, STRINGS[lang].texts[key]), el('span', {}, recipe.sizes?.[key] ? `${(recipe.sizes[key] / 1000).toFixed(1)}k` : t('empty'))))),
      el('span', {class: 'mono', style: 'color:var(--ink-3);overflow-wrap:anywhere'}, shortPath(recipe.origin))));
  }
  for (const error of state.recipes?.errors ?? []) host.append(note('bad', t('sourceErrors'), [`${shortPath(error.locator)} — ${error.error}`]));
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
  host.append(el('div', {class: 'group-head'}, el('h2', {class: 'group-title'}, t('sourcesTitle'))),
    el('div', {class: 'panel'},
      el('div', {class: 'field'}, el('span', {class: 'field-label'}, t('sourcesTitle')), el('span', {class: 'field-hint'}, t('sourcesHint')), lines,
        el('div', {}, el('button', {class: 'btn', onclick: () => addLine('')}, t('addSource')))),
      el('label', {class: 'field'}, el('span', {class: 'field-label'}, t('gwtLabel')), el('span', {class: 'field-hint'}, t('gwtHint')), gwt),
      el('div', {}, save)),
    note('bad', t('sourceErrors'), (state.recipes?.errors ?? []).map(error => `${shortPath(error.locator)} — ${error.error}`)),
    el('p', {class: 'group-note', style: 'margin:14px 4px'}, `${t('stateHome')} `, el('span', {class: 'mono'}, state.overview?.stateHome ?? '')));
}
// ---------------------------------------------------------------- in-app guide
const TOUR = {
  zh: [
    {title: '它做什么', body: '一份配方是一套 AI 编程工具的工作方式：主提示词、子代理提示词，以及每轮的小提醒。recipe-switch 把配方装进你电脑上的 Codex、Claude Code、Kiki、Pi 等工具，随时切换或还原。',
      list: ['只改提示词相关的文件和少量配置', '不碰模型、provider 和登录；OpenClaw 对话访问权限只有你主动勾选才会写入']},
    {title: '装一份配方', body: '在「工具」里点开一个工具，选「装上配方」。',
      list: ['挑一份配方', '按需打开或关闭配方选项，下方实时显示每个文件的改动', '确认后才写入，写入前自动备份']},
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
      list: ['Pick a recipe', 'Turn recipe options on or off; the diff below updates live', 'Nothing is written until you confirm; a backup is taken first']},
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
