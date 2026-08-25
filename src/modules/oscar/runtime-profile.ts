import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface NvidiaRuntimeProbeOptions {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  programFiles?: string;
  fileExists?: (candidate: string) => boolean;
  run?: (candidate: string, args: string[]) => SpawnSyncReturns<string>;
}

export function hasWorkingNvidiaRuntime(options: NvidiaRuntimeProbeOptions = {}): boolean {
  if ((options.platform || process.platform) !== 'win32') return false;
  const systemRoot = options.systemRoot || process.env.SystemRoot || 'C:\\Windows';
  const programFiles = options.programFiles
    || process.env.ProgramW6432
    || process.env.ProgramFiles
    || 'C:\\Program Files';
  const fileExists = options.fileExists || existsSync;
  const run = options.run || ((candidate, args) => spawnSync(candidate, args, {
    encoding: 'utf8',
    timeout: 4_000,
    windowsHide: true,
  }));
  const candidates = [
    path.join(systemRoot, 'System32', 'nvidia-smi.exe'),
    path.join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ];

  for (const candidate of candidates) {
    if (!fileExists(candidate)) continue;
    const result = run(candidate, [
      '--query-gpu=name,driver_version',
      '--format=csv,noheader,nounits',
    ]);
    if (result.status === 0 && String(result.stdout || '').trim()) return true;
  }
  return false;
}
