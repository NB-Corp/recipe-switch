#!/usr/bin/env node
// Export the CLI and runtime without the optional web UI or development tools.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKER = '# Vendored recipe-switch\n';
const COPY = ['bin', 'src', 'plugins', 'LICENSE'];
const UI_COMMAND = `  if (command === 'ui') {
    const {serve} = await import('../src/server.mjs');
    await serve({service, port: Number(flags.port ?? 4517), open: !flags['no-open']});
    return;
  }`;

export async function vendor(targetDir) {
  if (!targetDir) throw new Error('Usage: node scripts/vendor.mjs <targetDir>');
  const target = path.resolve(targetDir), source = path.resolve(ROOT);
  if (target === source || target.startsWith(source + path.sep) || source.startsWith(target + path.sep))
    throw new Error('Choose a vendor directory outside the recipe-switch checkout');
  const entries = await fs.readdir(target).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.length && !(await fs.readFile(path.join(target, 'VENDORED.md'), 'utf8').catch(() => '')).startsWith(MARKER))
    throw new Error('Target must be empty or an existing export from this script');

  const cli = (await fs.readFile(path.join(ROOT, 'bin/recipe-switch.mjs'), 'utf8')).replaceAll('\r\n', '\n');
  if (cli.split(UI_COMMAND).length !== 2) throw new Error('CLI ui command changed; update the CLI-only export');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim();
  const changes = execFileSync('git', ['status', '--porcelain', '--', ...COPY, 'package.json'], {cwd: ROOT, encoding: 'utf8'}).trim();
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const essentials = Object.fromEntries(['name', 'version', 'private', 'license', 'type', 'engines', 'bin', 'dependencies', 'optionalDependencies']
    .filter(key => pkg[key] !== undefined).map(key => [key, pkg[key]]));
  essentials.description = 'Install, switch and roll back behavior recipes across coding harnesses (CLI-only vendored runtime).';

  await fs.mkdir(target, {recursive: true});
  for (const entry of COPY) {
    await fs.rm(path.join(target, entry), {recursive: true, force: true});
    await fs.cp(path.join(ROOT, entry), path.join(target, entry), {recursive: true,
      filter: file => !['ui', 'tests', '.tmp', 'node_modules'].includes(path.basename(file))});
  }
  await fs.writeFile(path.join(target, 'bin/recipe-switch.mjs'), cli
    .replace(UI_COMMAND, `  if (command === 'ui') throw new Error('The web UI ships with the full recipe-switch checkout.');`)
    .replace('Local web UI on 127.0.0.1', 'Web UI ships with the full recipe-switch checkout'));
  await fs.writeFile(path.join(target, 'package.json'), JSON.stringify(essentials, null, 2) + '\n');
  await fs.writeFile(path.join(target, 'VENDORED.md'), `${MARKER}
Source: recipe-switch
Source commit: \`${commit}\`
${changes ? `\nIncludes working-tree changes in the copied paths:\n\n\`\`\`text\n${changes}\n\`\`\`\n` : ''}
This export contains bin/, src/ (including vendor/), plugins/, LICENSE and the
runtime package metadata. The CLI's ui command points to the full recipe-switch
checkout; UI assets, tests and development scripts are omitted.

Refresh from the recipe-switch checkout:

\`\`\`sh
node scripts/vendor.mjs <targetDir>
\`\`\`
`);
  console.log(`Vendored recipe-switch ${commit} → ${target}`);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  vendor(process.argv[2]).catch(error => { console.error(`vendor: ${error.message}`); process.exitCode = 1; });
