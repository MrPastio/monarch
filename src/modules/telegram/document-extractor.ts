import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Isolated interpreter with an OS memory/process limit and a bounded pipe.
 * No token, runtime credentials, document path, shell or output directory. */
export async function extractTelegramDocument(projectRoot: string, format: 'pdf' | 'docx', bytes: Buffer, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw Error('Документ превышает 8 МиБ.');
  const python = process.env.OSCAR_PYTHON || path.join(projectRoot, 'oscar', '.venv', 'Scripts', 'python.exe');
  const script = path.join(projectRoot, 'oscar', 'backend', 'oscar_agent', 'telegram_document_worker.py');
  if (!existsSync(python) || !existsSync(script)) throw Error('Обработчик документов не установлен.');
  return new Promise((resolve, reject) => {
    const dependencyRoot = process.env.MONARCH_BACKEND_ENVIRONMENT_ROOT;
    const args = ['-I', '-B', '-X', 'utf8', script, ...(dependencyRoot ? ['--dependency-root', path.join(dependencyRoot, 'oscar', 'common')] : [])];
    const child = spawn(python, args, { cwd: path.dirname(script), windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', WINDIR: process.env.WINDIR ?? 'C:\\Windows' }, stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false; let size = 0; const chunks: Buffer[] = [];
    const finish = (error?: Error, text?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (child.exitCode === null) child.kill('SIGKILL');
      if (error) reject(error); else resolve(text!);
    };
    const abort = () => finish(Error('Извлечение документа остановлено.'));
    const timer = setTimeout(() => finish(Error('Обработчик документа превысил лимит времени.')), 10_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(Error('Обработчик документов недоступен.')));
    child.stdin.on('error', () => finish(Error('Документ не принят обработчиком.')));
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 40_000) finish(Error('Результат извлечения превышает лимит.')); else chunks.push(chunk); });
    child.on('close', code => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0 || typeof result.text !== 'string' || !result.text.trim() || Buffer.byteLength(result.text) > 24_000) throw Error();
        finish(undefined, result.text + (result.truncated ? '\n[Документ длинный: извлечён ограниченный фрагмент.]' : ''));
      } catch { finish(Error('Не удалось безопасно извлечь текст. Нужен PDF с текстовым слоем или обычный DOCX без шифрования.')); }
    });
    if (signal?.aborted) abort();
    if (!settled) child.stdin.end(JSON.stringify({ format, dataBase64: bytes.toString('base64') }));
  });
}
