// managed by recipe-switch. UserPromptSubmit excludes system-triggered subagents.
import fs from 'node:fs/promises';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input || '{}');
if (event.hook_event_name === 'UserPromptSubmit') {
  const snapshot = JSON.parse(await fs.readFile(new URL('./recipe.json', import.meta.url), 'utf8'));
  if (snapshot.managedBy !== 'recipe-switch') throw new Error('Not a recipe-switch snapshot');
  const text = snapshot.texts?.userSteer;
  if (text) process.stdout.write(text + '\n');
}
