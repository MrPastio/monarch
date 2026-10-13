import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SecurityRuntimeConfig } from './client';

export interface SecurityScanJob {
  jobId: string;
  kind: 'system' | 'file';
  path?: string;
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  elapsedSeconds: number;
  result: Record<string, unknown> | null;
  error: string | null;
}

/** One bounded read-only scan per runtime. Never resumes or re-executes an effect. */
export class SecurityScanJobs {
  private job: SecurityScanJob | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private failure: string | null = null;

  constructor(private readonly config: SecurityRuntimeConfig) {}

  status(): SecurityScanJob | null {
    if (!this.job) return null;
    const active = this.job.status === 'running' || this.job.status === 'stopping';
    return { ...this.job, elapsedSeconds: active ? Math.max(0, Math.floor((Date.now() - Date.parse(this.job.startedAt)) / 1000)) : this.job.elapsedSeconds };
  }

  start(kind: 'system' | 'file', targetPath?: string): SecurityScanJob {
    if (this.child) throw new Error('Другая проверка ещё выполняется. Дождись завершения или останови её.');
    if (kind === 'file' && (!targetPath || !path.isAbsolute(targetPath))) throw new Error('Выбери файл с абсолютным путём.');
    const args = kind === 'system' ? ['scan-system', '--summary-only', '--no-llm'] : ['deep-scan-file', targetPath!, '--no-llm'];
    const jobId = randomUUID();
    this.job = { jobId, kind, ...(kind === 'file' ? { path: targetPath! } : {}), status: 'running', startedAt: new Date().toISOString(), elapsedSeconds: 0, result: null, error: null };
    this.failure = null;
    const child = spawn(this.config.pythonPath, ['-m', 'monarch_security', '--config', this.config.configPath, ...args], {
      cwd: this.config.projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MONARCH_SECURITY_DATA_ROOT: this.config.dataRoot, PYTHONUTF8: '1',
        PYTHONPATH: [path.join(this.config.projectRoot, 'src'), process.env.MONARCH_SECURITY_SITE_PACKAGES || ''].filter(Boolean).join(path.delimiter) },
    });
    this.child = child;
    child.stdin.on('error', () => undefined); child.stdin.end();
    let stdout = '', stderr = '', bytes = 0;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(String(chunk));
      if (bytes > 8 * 1024 * 1024) { this.terminate(jobId, 'Результат превысил допустимый размер.'); return; }
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.once('error', () => this.finish(jobId, 'failed', null, 'Не удалось запустить проверку.'));
    child.once('close', code => {
      if (this.job?.jobId !== jobId) return;
      if (this.job.status === 'stopping') {
        this.finish(jobId, this.failure ? 'failed' : 'cancelled', null, this.failure);
        return;
      }
      let result: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || 'null');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed;
      } catch { /* An invalid or truncated result is never a completed scan. */ }
      const valid = code === 0 && result && result.ok !== false && (kind === 'system' ? !!result.summary : !!result.assessment);
      this.finish(jobId, valid ? 'completed' : 'failed', result,
        valid ? null : stderr ? 'Проверка завершилась с ошибкой. Проверь доступ к файлу и состояние службы.' : 'Проверка не вернула полный результат.');
    });
    this.deadline = setTimeout(() => this.terminate(jobId, 'Проверка не уложилась в отведённое время.'), 150000);
    this.deadline.unref?.();
    return this.status()!;
  }

  cancel(jobId: string): SecurityScanJob | null {
    if (!this.job || this.job.jobId !== jobId) return null;
    this.terminate(jobId, null);
    return this.status();
  }

  dispose(): void {
    if (this.job) this.terminate(this.job.jobId, null);
  }

  private terminate(jobId: string, error: string | null): void {
    if (!this.child || this.job?.jobId !== jobId || this.job.status === 'stopping') return;
    this.failure = error;
    this.job.status = 'stopping';
    const child = this.child;
    if (process.platform === 'win32' && child.pid) {
      // The PID is from this exact live read-only worker. No protector or
      // unrelated Python process is selected by executable name.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { try { child.kill(); } catch { /* Keep stopping until close. */ } });
    } else {
      try { child.kill(); } catch { /* Keep ownership until close. */ }
    }
  }

  private finish(jobId: string, status: SecurityScanJob['status'], result: Record<string, unknown> | null, error: string | null): void {
    if (this.job?.jobId !== jobId) return;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null; this.child = null;
    this.job = { ...this.status()!, status, result, error };
  }
}
