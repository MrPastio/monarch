import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function restrictProtectedIntegrationAcl(rootPath, options = {}) {
  if (!path.isAbsolute(rootPath)) return false;
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return true;
  const domain = String(options.domain || process.env.USERDOMAIN || '').trim();
  const username = String(options.username || process.env.USERNAME || '').trim();
  if (!username) return false;
  const actor = domain ? `${domain}\\${username}` : username;
  const execute = options.execute || ((file, args, executeOptions) => execFileAsync(file, args, executeOptions));
  try {
    await execute('icacls.exe', [path.resolve(rootPath), '/inheritance:r', '/grant:r', `${actor}:(OI)(CI)F`,
      '/grant:r', '*S-1-5-18:(OI)(CI)F', '/C', '/Q'], { windowsHide: true, timeout: 15_000 });
    const recordNames = options.recordNames ?? ['groq-max.safe'];
    if (!Array.isArray(recordNames) || recordNames.length > 8
      || recordNames.some(name => typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/u.test(name))) return false;
    for (const recordName of recordNames) {
      const recordPath = path.join(path.resolve(rootPath), recordName);
      const record = await lstat(recordPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (record && (!record.isFile() || record.isSymbolicLink())) return false;
      if (record) await execute('icacls.exe', [recordPath, '/inheritance:r', '/grant:r', `${actor}:F`,
        '/grant:r', '*S-1-5-18:F', '/C', '/Q'], { windowsHide: true, timeout: 15_000 });
    }
    return true;
  } catch { return false; }
}
