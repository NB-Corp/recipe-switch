// managed by recipe-switch. Plain plugin definitions are accepted by the loader;
// no SDK import is needed when installed outside OpenClaw's own package tree.
import fs from 'node:fs/promises';

const isSubagent = key => typeof key === 'string' && /^(?:agent:[^:]+:)?subagent:/i.test(key.trim());

export default {
  id: 'recipe-switch',
  name: 'Recipe Switch',
  register(api) {
    api.on('before_prompt_build', async (_event, ctx) => {
      const snapshot = JSON.parse(await fs.readFile(new URL('./recipe.json', import.meta.url), 'utf8'));
      if (snapshot.managedBy !== 'recipe-switch') throw new Error('Not a recipe-switch snapshot');
      const sub = isSubagent(ctx?.sessionKey), texts = snapshot.texts ?? {};
      return {
        appendSystemContext: texts[sub ? 'sub' : 'main'] || undefined,
        prependContext: texts[sub ? 'subSteer' : 'userSteer'] || undefined,
      };
    });
  },
};
