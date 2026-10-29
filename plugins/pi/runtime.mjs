// recipe-loader built-in Pi extension.
// Adapted from gpt-with-taste adapters/pi/runtime/runtime.mjs (MIT), whose
// transport adapts SpadeLushen/pi-gpt-with-taste (MIT; see THIRD_PARTY_LICENSE).
// Changes: behavior text comes from the loader-managed recipe.json snapshot,
// which is re-read when it changes, and model scope comes from its `scope`.
import {readFileSync, statSync} from 'node:fs';
import {block, projectMessages} from './projection.mjs';
import {ensurePayloadInstructions} from './payload.mjs';

const KEYS = ['main', 'sub', 'independent', 'userSteer', 'subSteer', 'agentSteer'];
const registrations = new WeakSet();
const STATE = 'recipe-loader:state';
const SNAPSHOT = new URL('./recipe.json', import.meta.url);

let cache = {mtime: -1, value: null};
export function loadSnapshot(url = SNAPSHOT) {
  const mtime = statSync(url).mtimeMs;
  if (cache.url === url.href && cache.mtime === mtime) return cache.value;
  const value = JSON.parse(readFileSync(url, 'utf8'));
  for (const key of KEYS) if (typeof value.texts?.[key] !== 'string') throw new Error(`recipe.json is missing texts.${key}`);
  cache = {url: url.href, mtime, value};
  return value;
}

function overrides(ctx) {
  return ctx.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === STATE)?.data ?? {};
}
function report(ctx, text, level = 'info') {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else console.error(`recipe-loader: ${text}`);
}
function inScope(scope = {}, model) {
  if (!model) return false;
  if (Array.isArray(scope.providers) && scope.providers.length && !scope.providers.includes(model.provider)) return false;
  if (scope.modelIdPattern && !new RegExp(scope.modelIdPattern).test(model.id)) return false;
  return true;
}

export function createRecipeExtension({role = 'main', completedResultTypes = [], snapshot = SNAPSHOT} = {}) {
  if (!['main', 'sub', 'independent'].includes(role)) throw new Error('recipe-loader role must be main, sub or independent');
  const completed = new Set(completedResultTypes);
  return function recipeExtension(pi) {
    if (registrations.has(pi)) throw new Error('Load only one recipe-loader entry per Pi session');
    registrations.add(pi);
    loadSnapshot(snapshot); // fail at startup when the snapshot is unreadable
    const texts = () => Object.fromEntries(KEYS.map(key => [key, loadSnapshot(snapshot).texts[key].trim()]));
    const decision = ctx => {
      const state = overrides(ctx), snap = loadSnapshot(snapshot);
      const active = state.enabled !== false && inScope(snap.scope, ctx.model);
      return {role, active, steering: state.steering !== false, completedResultTypes: completed};
    };
    let warned = false;
    pi.on('context_with_system', (event, ctx) => ({messages: projectMessages(event.messages, texts(), decision(ctx))}));
    pi.on('before_provider_request', (event, ctx) => {
      if (!decision(ctx).active) return;
      const result = ensurePayloadInstructions(event.payload, block(texts(), role));
      if (!result.supported && !warned) report(ctx,
        'Final-request guard cannot inspect this payload format; the system-section injection remains active.', 'warning');
      warned = !result.supported;
      return result.payload;
    });
    pi.registerCommand('recipe', {
      description: 'recipe-loader: status, on, off, steer on, steer off, reset',
      handler: async (args, ctx) => {
        const command = args.trim() || 'status';
        const state = {...overrides(ctx)};
        if (command === 'on' || command === 'off') state.enabled = command === 'on';
        else if (command === 'steer on' || command === 'steer off') state.steering = command === 'steer on';
        else if (!['status', 'reset'].includes(command)) { report(ctx, 'Usage: /recipe status|on|off|steer on|steer off|reset', 'warning'); return; }
        if (command !== 'status') pi.appendEntry(STATE, command === 'reset' ? {} : state);
        const snap = loadSnapshot(snapshot), current = decision(ctx);
        report(ctx, `Recipe: ${snap.recipe.name} ${snap.recipe.version}\nRole: ${role}\nActive: ${current.active}\nSteering: ${current.steering && role !== 'independent'}`);
      },
    });
  };
}
export default createRecipeExtension();
