import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function readDurableJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeDurableJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, filePath);
  } catch {
    try {
      writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } catch {
      // A read-only runtime must not disable the in-memory policy path.
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
