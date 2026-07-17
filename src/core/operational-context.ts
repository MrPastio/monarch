import path from 'node:path';
import type { MonarchIntentResult } from './contracts';

export interface MonarchPendingOperationalAction {
  capabilityId: string;
  input: Record<string, unknown>;
  missingInput: string[];
}

export interface MonarchOperationalContext {
  lastDirectoryPath?: string;
  lastFilePath?: string;
  lastCapabilityId?: string;
  pendingAction?: MonarchPendingOperationalAction;
  updatedAt?: string;
}

export function reduceOperationalContext(
  current: MonarchOperationalContext,
  result: MonarchIntentResult,
): MonarchOperationalContext {
  const next: MonarchOperationalContext = { ...current };
  const output = asRecord(result.execution?.output);
  const routeInput = asRecord(result.route?.input);
  const observedPath = readString(output.path) || readString(routeInput.path);

  if (result.execution?.ok && result.route?.capabilityId) {
    next.lastCapabilityId = result.route.capabilityId;
    delete next.pendingAction;
    if (result.route.capabilityId === 'workspace.files.mkdir' && observedPath) {
      next.lastDirectoryPath = observedPath;
    } else if (result.route.capabilityId.startsWith('workspace.files.') && observedPath) {
      next.lastFilePath = observedPath;
      next.lastDirectoryPath = path.dirname(observedPath);
    }
  } else if (
    result.execution?.error === 'clarification-required'
    && next.lastDirectoryPath
    && /(?:в\s+этой\s+папке|in\s+this\s+(?:folder|directory)).{0,48}(?:текстов[а-яё]*\s+файл|text\s+file)/i.test(result.intent.text)
  ) {
    next.pendingAction = {
      capabilityId: 'workspace.files.write',
      input: { path: path.join(next.lastDirectoryPath, 'note.txt'), overwrite: false },
      missingInput: ['content'],
    };
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

export function readOperationalContext(value: unknown): MonarchOperationalContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>).operationalContext;
  return candidate && typeof candidate === 'object' ? candidate as MonarchOperationalContext : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
