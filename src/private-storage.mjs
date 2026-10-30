// Establish private storage permissions before any sensitive bytes are written.
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);

export async function privateDirectory(dir) {
  try {
    await fs.mkdir(dir, {recursive: true, mode: 0o700});
    if (process.platform === 'win32') {
      const {stdout} = await execute('whoami', [], {windowsHide: true});
      const user = stdout.trim();
      if (!user) throw new Error('Cannot identify the current Windows user');
      await execute('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {windowsHide: true});
    } else await fs.chmod(dir, 0o700);
  } catch (error) { throw new Error(`无法保护备份目录权限，拒绝写入 / Cannot secure backup directory; refusing to write: ${dir}: ${error.message}`); }
  return dir;
}
