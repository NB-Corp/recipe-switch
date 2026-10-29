// recipe-loader UI. Talks to the local server with the per-process token.
const TOKEN = document.querySelector('meta[name="recipe-loader-token"]')?.content ?? '';

const state = {
  overview: null,
  recipes: null,
  config: null,
  textViewer: null, // {key, texts, tab}
};

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

async function api(path, {method = 'GET', body} = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'x-recipe-loader-token': TOKEN,
      ...(body !== undefined ? {'content-type': 'application/json'} : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(+date)) return iso;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function fmtBytes(n) {
  if (n == null) return '0 B';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}
function esc(s) { return String(s ?? ''); }

// ---------------------------------------------------------------- tabs
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  for (const tab of tabs) tab.addEventListener('click', () => {
    for (const other of tabs) {
      const active = other === tab;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', String(active));
      document.getElementById(`tab-${other.dataset.tab}`).classList.toggle('is-active', active);
    }
    if (tab.dataset.tab === 'settings') renderSettings();
  });
}

// ---------------------------------------------------------------- overview
function presenceBadge(target) {
  if (target.present) return el('span', {class: 'presence presence-present'}, 'detected');
  return el('span', {class: 'presence presence-absent'}, 'not found');
}

function liveBlock(live) {
  const items = live.map(item => el('li', {},
    el('span', {}, esc(item.label)),
    el('span', {class: 'chip-where'}, item.where ?? ''),
    item.managed === false ? el('span', {class: 'chip-flag chip-flag-soft'}, 'not loader') : null,
    item.managed === true ? el('span', {class: 'chip-flag chip-flag-soft'}, 'loader') : null));
  return el('div', {class: 'chip-block is-live'},
    el('div', {class: 'chip-block-title'}, el('span', {class: 'dot'}), `Live (${live.length})`),
    el('ul', {class: 'chip-list'}, items));
}

function driftBlock(drift) {
  const items = drift.map(d => el('li', {},
    el('span', {class: 'mono'}, esc(d.path)),
    el('span', {class: 'chip-detail'}, `${esc(d.unit)} — ${esc(d.state ?? 'edited')}`)));
  return el('div', {class: 'chip-block is-drift'},
    el('div', {class: 'chip-block-title'}, el('span', {class: 'dot'}), `Hand edits (${drift.length})`),
    el('ul', {class: 'chip-list'}, items));
}

function foreignBlock(foreign) {
  const items = foreign.map(f => el('li', {},
    el('span', {}, esc(f.what)),
    f.blocking ? el('span', {class: 'chip-flag'}, 'blocking') : el('span', {class: 'chip-flag chip-flag-soft'}, 'warn'),
    el('span', {class: 'chip-detail'}, esc(f.detail))));
  return el('div', {class: 'chip-block is-foreign'},
    el('div', {class: 'chip-block-title'}, el('span', {class: 'dot'}), `Other installers (${foreign.length})`),
    el('ul', {class: 'chip-list'}, items));
}

function historySection(target) {
  const history = target.managed?.history ?? [];
  if (!history.length) return null;
  const list = el('ul', {class: 'history-list', hidden: true});
  for (const op of history) {
    list.append(el('li', {},
      el('span', {class: `history-kind history-kind-${op.kind}`}, esc(op.kind)),
      el('span', {class: 'history-recipe'}, op.recipe ? ` ${esc(op.recipe)}` : ''),
      el('span', {class: 'history-when'}, fmtTime(op.at)),
      el('span', {class: 'history-backup'}, esc(op.backup))));
  }
  const toggle = el('button', {class: 'history-toggle', 'aria-expanded': 'false'}, `History (${history.length}) ▸`);
  toggle.addEventListener('click', () => {
    const open = list.hidden;
    list.hidden = !open;
    toggle.textContent = `History (${history.length}) ${open ? '▾' : '▸'}`;
    toggle.setAttribute('aria-expanded', String(open));
  });
  return el('div', {class: 'history'}, toggle, list);
}

function targetCard(target) {
  const managed = target.managed ?? {installed: false, drift: [], history: []};
  const card = el('article', {class: 'target-card'});

  card.append(el('div', {class: 'target-head'},
    el('h2', {class: 'target-name'}, esc(target.name),
      target.label ? el('span', {class: 'target-label'}, esc(target.label)) : null),
    presenceBadge(target)));

  card.append(el('div', {class: 'recipe-line'},
    managed.installed && managed.recipe
      ? [el('span', {class: 'recipe-name'}, esc(managed.recipe.name)),
        el('span', {class: 'recipe-version'}, `v${esc(managed.recipe.version)}`),
        managed.since ? el('span', {class: 'since'}, `since ${fmtTime(managed.since)}`) : null]
      : el('span', {class: 'recipe-none'}, target.present ? 'No recipe installed by the loader' : 'Home not detected')));

  card.append(el('div', {class: 'path-row', title: target.home}, esc(target.home)));
  if (target.mechanism) card.append(el('div', {class: 'mech'}, esc(target.mechanism)));
  if (target.error) card.append(el('div', {class: 'target-error'}, esc(target.error)));

  if (target.live?.length) card.append(liveBlock(target.live));
  if (managed.drift?.length) card.append(driftBlock(managed.drift));
  if (target.foreign?.length) card.append(foreignBlock(target.foreign));

  const actions = el('div', {class: 'target-actions'});
  const hasBlocking = (target.foreign ?? []).some(f => f.blocking) && !managed.installed;
  const installBtn = el('button', {
    class: 'btn btn-sm btn-primary',
    disabled: !target.present || hasBlocking,
    title: !target.present ? 'Home not detected' : hasBlocking ? 'Blocked by another installer' : '',
    onclick: () => openInstallDialog(target),
  }, managed.installed ? 'Switch recipe' : 'Install recipe');
  actions.append(installBtn);
  if (managed.installed) {
    actions.append(
      el('button', {class: 'btn btn-sm', onclick: () => openUndoDialog(target, false)}, 'Rollback'),
      el('button', {class: 'btn btn-sm', onclick: () => openUndoDialog(target, true)}, 'Uninstall'));
  }
  card.append(actions);

  const history = historySection(target);
  if (history) card.append(history);
  return card;
}

function renderOverview() {
  const {overview} = state;
  document.getElementById('stateHome').textContent = overview.stateHome ?? '';
  document.getElementById('stateHome').title = overview.stateHome ?? '';

  const host = document.getElementById('targets');
  host.textContent = '';
  for (const target of overview.targets) host.append(targetCard(target));

  const uncoveredHost = document.getElementById('uncovered');
  uncoveredHost.textContent = '';
  for (const item of overview.uncovered ?? []) {
    uncoveredHost.append(el('div', {class: 'uncovered-row'},
      el('span', {class: 'uncovered-name'}, esc(item.name)),
      el('span', {class: 'uncovered-home'}, esc(item.home), item.detected ? ' ✓' : ''),
      el('span', {class: 'uncovered-reason'}, esc(item.reason))));
  }
  document.getElementById('uncoveredCount').textContent = String((overview.uncovered ?? []).length);
}

// ---------------------------------------------------------------- recipes tab
function renderRecipes() {
  const host = document.getElementById('recipes');
  host.textContent = '';
  const {recipes, errors} = state.recipes;
  for (const recipe of recipes) {
    const sizes = Object.entries(recipe.sizes ?? {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${fmtBytes(n)}`)
      .join(' · ');
    host.append(el('article', {class: 'recipe-card'},
      el('h3', {class: 'recipe-card-name'}, esc(recipe.name)),
      recipe.description ? el('p', {class: 'recipe-card-desc'}, esc(recipe.description)) : null,
      el('div', {class: 'recipe-meta'},
        el('span', {class: 'meta-chip'}, `v${esc(recipe.version)}`),
        el('span', {class: 'meta-chip'}, esc(recipe.kind)),
        el('span', {class: 'meta-chip mono'}, esc(recipe.key))),
      sizes ? el('div', {class: 'recipe-sizes'}, sizes) : null,
      el('div', {class: 'target-actions'},
        el('button', {class: 'btn btn-sm', onclick: () => openTextViewer(recipe.key)}, 'View text'))));
  }
  const errHost = document.getElementById('recipeErrors');
  errHost.textContent = '';
  if (errors?.length) {
    errHost.append(el('h3', {class: 'section-title', style: 'margin:0 0 8px'}, 'Source errors'));
    for (const err of errors) {
      errHost.append(el('div', {class: 'error-row'},
        el('span', {class: 'mono'}, esc(err.locator)), esc(err.error)));
    }
  }
}

// ---------------------------------------------------------------- settings tab
function renderSettings() {
  const host = document.getElementById('sourcesList');
  host.textContent = '';
  const addRow = (value) => {
    const input = el('input', {class: 'text-input', type: 'text', value, spellcheck: 'false'});
    host.append(el('div', {class: 'source-row'}, input,
      el('button', {class: 'btn btn-sm', onclick: () => { input.closest('.source-row').remove(); }}, 'Remove')));
  };
  for (const source of state.config?.sources ?? []) addRow(source);
  document.getElementById('addSourceBtn').onclick = () => addRow('');
  const statusEl = document.getElementById('sourcesStatus');
  document.getElementById('saveSourcesBtn').onclick = async () => {
    const sources = [...host.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
    statusEl.classList.remove('is-error');
    statusEl.textContent = 'Saving…';
    try {
      state.config = await api('/api/config', {method: 'POST', body: {sources}});
      state.recipes = await api('/api/recipes');
      statusEl.textContent = `Saved. ${state.recipes.recipes.length} recipes found.`;
      renderRecipes();
    } catch (error) {
      statusEl.classList.add('is-error');
      statusEl.textContent = error.message;
    }
  };
}

// ---------------------------------------------------------------- dialog shell
function openDialog(node, {wide = false} = {}) {
  const mount = document.getElementById('dialogMount');
  const backdrop = el('div', {class: 'dialog-backdrop'});
  const dialog = el('div', {class: `dialog${wide ? ' dialog-wide' : ''}`, role: 'dialog', 'aria-modal': 'true'});
  dialog.append(...[].concat(node));
  backdrop.append(dialog);
  const close = () => backdrop.remove();
  backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) close(); });
  const onKey = event => { if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  mount.append(backdrop);
  return {close, dialog};
}

function dialogHead(title, sub) {
  return el('div', {class: 'dialog-head'},
    el('h3', {class: 'dialog-title'}, title),
    sub ? el('p', {class: 'dialog-sub'}, sub) : null);
}

// ---------------------------------------------------------------- diff + banners
function renderDiff(text) {
  const pre = el('pre', {class: 'diff'});
  const lines = String(text ?? '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    let cls = '', sign = ' ';
    if (line.startsWith('@@')) { cls = 'diff-line-hunk'; sign = ''; }
    else if (line.startsWith('+')) { cls = 'diff-line-add'; sign = '+'; }
    else if (line.startsWith('-')) { cls = 'diff-line-del'; sign = '-'; }
    const content = cls === 'diff-line-hunk' ? line : line.slice(1);
    pre.append(el('div', {class: `diff-line ${cls}`},
      el('span', {class: 'diff-sign'}, sign), content || ' '));
  }
  return pre;
}

function fileBlock(file) {
  return el('div', {class: 'file-block'},
    el('div', {class: 'file-head'},
      el('span', {class: `file-action file-action-${file.action}`}, esc(file.action)),
      el('span', {class: 'file-path'}, esc(file.path)),
      el('span', {class: 'file-stats'},
        el('span', {class: 'stat-add'}, `+${file.added}`), ' ',
        el('span', {class: 'stat-del'}, `−${file.removed}`))),
    renderDiff(file.diff));
}

function banner(kind, title, items) {
  return el('div', {class: `banner banner-${kind}`},
    el('span', {class: 'banner-title'}, title),
    el('ul', {}, items.map(item => el('li', {}, esc(item)))));
}

// ---------------------------------------------------------------- options form
function optionFields(target, saved = {}) {
  const fields = [];
  for (const opt of target.options ?? []) {
    if (opt.type === 'multi') {
      const choices = target.choices?.models ?? [];
      const pre = new Set([].concat(saved[opt.key] ?? []));
      const list = el('div', {class: 'check-list'});
      if (!choices.length) list.append(el('span', {class: 'plan-empty'}, 'No models defined in this home.'));
      for (const choice of choices) {
        const box = el('input', {type: 'checkbox', value: choice});
        box.checked = pre.has(choice);
        list.append(el('label', {}, box, esc(choice)));
      }
      fields.push({node: el('div', {class: 'field'}, el('span', {}, `${opt.label}${opt.required ? ' *' : ''}`), list),
        read: () => ({[opt.key]: [...list.querySelectorAll('input:checked')].map(i => i.value)}),
        valid: () => !opt.required || list.querySelectorAll('input:checked').length > 0});
    } else if (opt.type === 'select') {
      const select = el('select', {class: 'text-input'},
        (opt.choices ?? []).map(c => el('option', {value: c, selected: (saved[opt.key] ?? opt.choices?.[0]) === c}, esc(c))));
      fields.push({node: el('div', {class: 'field'}, el('span', {}, opt.label), select),
        read: () => ({[opt.key]: select.value}), valid: () => true});
    } else {
      const input = el('input', {class: 'text-input', type: 'text', value: saved[opt.key] ?? '', spellcheck: 'false'});
      fields.push({node: el('div', {class: 'field'}, el('span', {}, `${opt.label}${opt.required ? ' *' : ''}`), input),
        read: () => input.value.trim() ? ({[opt.key]: input.value.trim()}) : ({}),
        valid: () => !opt.required || Boolean(input.value.trim())});
    }
  }
  return fields;
}

// ---------------------------------------------------------------- install dialog
async function openInstallDialog(target) {
  const recipes = state.recipes?.recipes ?? [];
  const picker = el('div', {class: 'picker-list'});
  const current = target.managed?.recipe;
  const sorted = [...recipes].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const recipe of sorted) {
    picker.append(el('button', {class: 'picker-item', onclick: () => { close(); previewInstall(target, recipe, {}); }},
      el('span', {class: 'picker-name'}, esc(recipe.name),
        el('span', {class: 'picker-version'}, `v${esc(recipe.version)}`,
          current?.key === recipe.key ? ' (current)' : '')),
      recipe.description ? el('span', {class: 'picker-desc'}, esc(recipe.description)) : null));
  }
  const title = target.managed?.installed ? `Switch recipe on ${target.name}` : `Install a recipe on ${target.name}`;
  const {close} = openDialog([
    dialogHead(title, target.label ? `${target.label} — ${target.home}` : target.home),
    el('div', {class: 'dialog-body'},
      !recipes.length ? el('p', {class: 'plan-empty'}, 'No recipes found. Check sources in the Sources tab.') : picker),
    el('div', {class: 'dialog-foot'}, el('span', {class: 'spacer'}), el('button', {class: 'btn', onclick: () => close()}, 'Cancel')),
  ]);
}

async function previewInstall(target, recipe, savedOptions, keepDialog) {
  const fields = optionFields(target, savedOptions);
  const optionsForm = fields.length
    ? el('div', {class: 'options-form'}, el('h4', {class: 'options-title'}, 'Options'), fields.map(f => f.node))
    : null;

  const body = el('div', {class: 'dialog-body'});
  if (optionsForm) body.append(optionsForm);
  body.append(el('div', {class: 'skeleton', style: 'min-height:120px'}));

  const foot = el('div', {class: 'dialog-foot'});
  const cancelBtn = el('button', {class: 'btn'}, 'Cancel');
  const previewBtn = el('button', {class: 'btn'}, 'Update preview');
  const applyBtn = el('button', {class: 'btn btn-primary'}, 'Apply');
  foot.append(cancelBtn, el('span', {class: 'spacer'}));
  if (optionsForm) foot.append(previewBtn);
  foot.append(applyBtn);

  const kindWord = target.managed?.installed ? 'Switch' : 'Install';
  const {close} = openDialog([
    dialogHead(`${kindWord}: ${recipe.name}`,
      target.label ? `${target.name} · ${target.label} — ${target.home}` : `${target.name} — ${target.home}`),
    body, foot,
  ], {wide: true});

  cancelBtn.addEventListener('click', () => close());

  let currentPlan = null;
  const showError = (message) => {
    body.querySelector('.skeleton')?.remove();
    applyBtn.disabled = true;
    applyBtn.textContent = 'Apply';
    foot.querySelector('.foot-error')?.remove();
    foot.append(el('div', {class: 'foot-error'}, message));
  };
  const renderPlan = (plan) => {
    currentPlan = plan;
    body.querySelector('.skeleton')?.remove();
    body.querySelectorAll('.summary-strip, .banner, .file-block, .plan-empty, .launch-box').forEach(n => n.remove());
    foot.querySelector('.foot-error')?.remove();

    body.append(el('div', {class: 'summary-strip'},
      el('span', {class: `kind-tag kind-tag-${plan.kind}`}, esc(plan.kind)),
      el('span', {}, plan.current ? `${esc(plan.current.name)} v${esc(plan.current.version)}` : 'original state'),
      el('span', {class: 'summary-arrow'}, '→'),
      el('span', {}, `${esc(recipe.name)} v${esc(recipe.version)}`)));

    if (plan.blocked?.length) body.append(banner('blocked', 'Blocked', plan.blocked));
    if (plan.warnings?.length) body.append(banner('warning', 'Warnings', plan.warnings));
    if (plan.notes?.length) body.append(banner('note', 'Notes', plan.notes));

    if (plan.files?.length) for (const file of plan.files) body.append(fileBlock(file));
    else body.append(el('p', {class: 'plan-empty'}, 'Nothing to write; this recipe is already in place.'));

    if (plan.launch) body.append(el('div', {class: 'launch-box'},
      banner('note', 'Start new sessions with', []), el('code', {}, esc(plan.launch))));

    const blocked = (plan.blocked?.length ?? 0) > 0;
    applyBtn.disabled = blocked || !plan.files?.length;
    applyBtn.textContent = blocked ? 'Apply (blocked)' : 'Apply';
  };

  const runPreview = async () => {
    for (const field of fields) {
      if (!field.valid()) { showError('Fill in the required options first.'); return; }
    }
    const options = Object.assign({}, ...fields.map(f => f.read()));
    applyBtn.disabled = true;
    previewBtn.disabled = true;
    try {
      const plan = await api('/api/preview', {
        method: 'POST',
        body: {harness: target.harness, home: target.home, recipe: recipe.key, options},
      });
      renderPlan(plan);
    } catch (error) { showError(error.message); }
    finally { previewBtn.disabled = false; }
  };
  previewBtn.addEventListener('click', runPreview);
  optionsForm?.addEventListener('change', runPreview);

  applyBtn.addEventListener('click', async () => {
    if (!currentPlan) return;
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying…';
    try {
      const result = await api('/api/apply', {method: 'POST', body: {planId: currentPlan.id}});
      close();
      await refreshAll();
      showResult(`${kindWord === 'Switch' ? 'Switched' : 'Installed'}`, result);
    } catch (error) { showError(error.message); }
  });

  await runPreview();
}

// ---------------------------------------------------------------- undo dialog (rollback / uninstall)
async function openUndoDialog(target, all) {
  const kindWord = all ? 'Uninstall' : 'Rollback';
  const body = el('div', {class: 'dialog-body'}, el('div', {class: 'skeleton', style: 'min-height:120px'}));
  const foot = el('div', {class: 'dialog-foot'});
  const cancelBtn = el('button', {class: 'btn'}, 'Cancel');
  const applyBtn = el('button', {class: `btn ${all ? 'btn-danger' : 'btn-primary'}`}, kindWord);
  foot.append(cancelBtn, el('span', {class: 'spacer'}), applyBtn);

  const {close} = openDialog([
    dialogHead(`${kindWord} ${target.name}`,
      target.label ? `${target.label} — ${target.home}` : target.home),
    body, foot,
  ], {wide: true});

  cancelBtn.addEventListener('click', () => close());
  let currentPlan = null;

  try {
    const plan = await api('/api/preview-undo', {
      method: 'POST',
      body: {harness: target.harness, home: target.home, all},
    });
    currentPlan = plan;
    body.textContent = '';

    const restores = plan.restores;
    body.append(el('div', {class: 'summary-strip'},
      el('span', {class: `kind-tag kind-tag-${plan.kind}`}, esc(plan.kind)),
      el('span', {}, target.managed?.recipe ? `${esc(target.managed.recipe.name)} v${esc(target.managed.recipe.version)}` : 'current state'),
      el('span', {class: 'summary-arrow'}, '→'),
      el('span', {}, restores ? `${esc(restores.name)} v${esc(restores.version)}` : 'original state (before the loader)')));

    if (plan.blocked?.length) body.append(banner('blocked', 'Blocked', plan.blocked));
    if (plan.drift?.length) body.append(banner('warning', 'Drift detected',
      plan.drift.map(d => `${d.path} (${d.unit})`)));

    if (plan.files?.length) for (const file of plan.files) body.append(fileBlock(file));
    else body.append(el('p', {class: 'plan-empty'}, 'Nothing to restore.'));

    const blocked = (plan.blocked?.length ?? 0) > 0;
    applyBtn.disabled = blocked;
    if (blocked) applyBtn.textContent = `${kindWord} (blocked)`;
  } catch (error) {
    body.textContent = '';
    body.append(el('div', {class: 'target-error'}, error.message));
    applyBtn.disabled = true;
  }

  applyBtn.addEventListener('click', async () => {
    if (!currentPlan) return;
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying…';
    try {
      const result = await api('/api/apply', {method: 'POST', body: {planId: currentPlan.id}});
      close();
      await refreshAll();
      showResult(kindWord, result);
    } catch (error) {
      applyBtn.disabled = false;
      applyBtn.textContent = kindWord;
      foot.append(el('div', {class: 'foot-error'}, error.message));
    }
  });
}

// ---------------------------------------------------------------- result toast dialog
function showResult(action, result) {
  const lines = [];
  if (result.message) lines.push(result.message);
  if (result.backup) lines.push(`Backup: ${result.backup}`);
  if (!result.changed) lines.push('No files changed.');
  const {close} = openDialog([
    dialogHead(action, null),
    el('div', {class: 'dialog-body'},
      el('p', {}, lines[0] ?? ''),
      lines.slice(1).map(line => el('p', {class: 'mono', style: 'font-size:11.5px;color:var(--text-soft)'}, line)),
      result.launch ? el('div', {class: 'launch-box'}, el('code', {}, esc(result.launch))) : null,
      (result.notes ?? []).length ? banner('note', 'Notes', result.notes) : null),
    el('div', {class: 'dialog-foot'}, el('span', {class: 'spacer'}),
      el('button', {class: 'btn btn-primary', onclick: () => close()}, 'Done')),
  ]);
}

// ---------------------------------------------------------------- recipe text viewer
async function openTextViewer(key) {
  const body = el('div', {class: 'dialog-body'}, el('div', {class: 'skeleton', style: 'min-height:120px'}));
  const {close} = openDialog([
    dialogHead('Recipe text', key),
    body,
    el('div', {class: 'dialog-foot'}, el('span', {class: 'spacer'}),
      el('button', {class: 'btn', onclick: () => close()}, 'Close')),
  ], {wide: true});
  try {
    const recipe = await api(`/api/recipe?key=${encodeURIComponent(key)}`);
    body.textContent = '';
    const keys = Object.keys(recipe.texts ?? {});
    const textHost = el('div', {});
    const tabs = el('div', {class: 'viewer-tabs'});
    const show = (k) => {
      for (const t of tabs.children) t.classList.toggle('is-active', t.dataset.k === k);
      textHost.textContent = '';
      const text = recipe.texts[k];
      textHost.append(text
        ? el('pre', {class: 'viewer-text'}, esc(text))
        : el('p', {class: 'viewer-empty'}, 'This recipe does not define this text.'));
    };
    for (const k of keys) {
      tabs.append(el('button', {class: 'viewer-tab', 'data-k': k, onclick: () => show(k)}, k));
    }
    body.append(tabs, textHost);
    show(keys[0]);
  } catch (error) {
    body.textContent = '';
    body.append(el('div', {class: 'target-error'}, error.message));
  }
}

// ---------------------------------------------------------------- boot
async function refreshAll() {
  const [overview, recipes] = await Promise.all([api('/api/overview'), api('/api/recipes')]);
  state.overview = overview;
  state.recipes = recipes;
  renderOverview();
  renderRecipes();
}

initTabs();
document.getElementById('refreshBtn').addEventListener('click', refreshAll);
(async () => {
  const targetsHost = document.getElementById('targets');
  for (let i = 0; i < 3; i++) targetsHost.append(el('div', {class: 'skeleton', style: 'min-height:190px'}));
  try {
    state.config = await api('/api/config');
    await refreshAll();
  } catch (error) {
    targetsHost.textContent = '';
    targetsHost.append(el('div', {class: 'target-error'}, `Failed to load: ${error.message}`));
  }
})();
