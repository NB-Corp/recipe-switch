#!/usr/bin/env node
// Create a sandbox of fake harness homes and start the UI against it.
// Nothing outside the sandbox directory is written.
//   node scripts/demo.mjs [--dir DIR] [--port 4517] [--no-open] [--reset]
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function makeSandbox(dir) {
  const put = async (rel, text) => { const file = path.join(dir, rel); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, text); };
  await put('codex/config.toml', '# fake Codex home\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\n\n[mcp_servers.local]\ncommand = "fixture"\n');
  await put('kiki/config.toml', '# fake Kiki home\n[models."axon/gpt-6.1-sol"]\nprovider = "axon"\nmodel = "gpt-6.1-sol"\n\n[models."deepseek-v4-flash"]\nrecipe = "6bccd1ea-0000-0000-0000-000000000000"\nprovider = "axon-chat"\nmodel = "deepseek-v4.1-flash"\n');
  await put('kiki/store/recipes/installations', JSON.stringify({'6bccd1ea-0000-0000-0000-000000000000': {summary: {name: 'DeepSeek V4.1 — intent first', version: '1.0.0'}}}));
  await put('pi/agent/settings.json', '{\n  "defaultProvider": "openai",\n  "defaultModel": "gpt-5.5"\n}\n');
  await put('dsh/profiles/web/package.json', JSON.stringify({name: 'dsh-profile-web', private: true, dependencies: {}, dsh: {profile: {bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']}}}, null, 2) + '\n');
  await put('dsh/profiles/web/cordis.patch.yml', '[]\n');
  await put('dsh/profiles/work/package.json', JSON.stringify({name: 'dsh-profile-work', private: true, dsh: {profile: {bundles: ['@deepseek-ai/dsh-base']}}}, null, 2) + '\n');
  await put('claude/settings.json', '{\n  "model": "opus"\n}\n');
  await put('grok/rules/engineering.md', '# My engineering rules\n');
  await put('opencode/opencode.json', '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "axon/gpt-5.5"\n}\n');
  return sandboxEnv(dir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2), flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = path.resolve(flag('--dir') ?? path.join(ROOT, '.tmp', 'demo'));
  if (argv.includes('--reset')) await fs.rm(dir, {recursive: true, force: true});
  const fresh = !(await fs.access(dir).then(() => true, () => false));
  const env = fresh ? await makeSandbox(dir) : sandboxEnv(dir);
  Object.assign(process.env, env);
  const {Service} = await import('../src/service.mjs');
  const {serve} = await import('../src/server.mjs');
  console.log(`Sandbox: ${dir}${fresh ? ' (created)' : ' (reused; --reset to recreate)'}`);
  await serve({service: new Service({env: process.env, home: env.RECIPE_LOADER_HOME}), port: Number(flag('--port') ?? 4517), open: !argv.includes('--no-open')});
}

export function sandboxEnv(dir) {
  return {
    RECIPE_LOADER_HOME: path.join(dir, 'state'), CODEX_HOME: path.join(dir, 'codex'), KIKI_HOME: path.join(dir, 'kiki'),
    PI_CODING_AGENT_DIR: path.join(dir, 'pi/agent'), DSH_HOME: path.join(dir, 'dsh'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    OMP_CODING_AGENT_DIR: path.join(dir, 'omp/agent'), GROK_HOME: path.join(dir, 'grok'), OPENCODE_CONFIG_DIR: path.join(dir, 'opencode'),
  };
}
