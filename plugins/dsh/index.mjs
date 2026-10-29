// recipe-loader built-in DSH plugin.
// Adapted from gpt-with-taste adapters/dsh/runtime.mjs (MIT). Changes: the
// behavior text is the loader-managed recipe.json snapshot, re-read whenever
// it changes, so switching a recipe never touches DSH profile configuration.
import {readFile, stat} from 'node:fs/promises';
import {createUserMessage} from '@deepseek-ai/dsh-llm';

export const name = 'recipe-loader';
export const inject = ['systemPrompt', 'agents'];
const sectionName = 'recipe-loader:behavior';
const KEYS = ['main', 'sub', 'independent', 'userSteer', 'subSteer', 'agentSteer'];

export function snapshotReader(url = new URL('./recipe.json', import.meta.url)) {
  let cache = {mtime: -1, value: null};
  return async () => {
    const {mtimeMs} = await stat(url);
    if (mtimeMs !== cache.mtime) {
      const value = JSON.parse(await readFile(url, 'utf8'));
      for (const key of KEYS) if (typeof value.texts?.[key] !== 'string') throw new Error(`recipe.json is missing texts.${key}`);
      cache = {mtime: mtimeMs, value};
    }
    return cache.value;
  };
}

/** Native DSH augmentation; the active recipe decides the text. */
export async function apply(ctx, config = {}) {
  const rootRole = config.rootRole ?? 'main';
  if (!['main', 'independent'].includes(rootRole)) throw new Error('recipe-loader rootRole must be main or independent');
  const snapshot = snapshotReader(config.snapshot ? new URL(config.snapshot) : undefined);
  let current = await snapshot();
  const texts = () => current.texts;
  const refresh = async () => { current = await snapshot(); };
  const roleOf = agent => agent.session.header.origin === 'subagent' ? 'sub' : rootRole;

  ctx.systemPrompt.section({
    name: sectionName,
    order: 10,
    text: ({agent}) => agent === undefined ? '' : texts()[roleOf(agent)],
  });

  ctx.on('agent/pre-step', async ({agent}, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    await refresh();
    const role = roleOf(agent);
    return {
      ...decision,
      messages: decision.messages.flatMap(message => {
        let key;
        switch (message.source.kind) {
          case 'user':
            key = role === 'sub' ? 'subSteer' : role === 'main' ? 'userSteer' : undefined;
            break;
          case 'coordinator':
            key = role === 'sub' ? 'subSteer' : undefined;
            break;
          case 'subagent-report':
          case 'subagent-settled':
            key = role === 'sub' ? 'subSteer' : role === 'main' ? 'agentSteer' : undefined;
            break;
          default:
            return [message];
        }
        const text = key && texts()[key]?.trim();
        if (!text) return [message];
        return [createUserMessage({
          source: {kind: 'plugin', plugin: name, form: 'instructions'},
          content: [{type: 'text', text}],
        }), message];
      }),
    };
  });
}
