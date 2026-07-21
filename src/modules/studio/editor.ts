import { randomUUID } from 'node:crypto';
import {
  applyPhotoOperation,
  type StudioPhotoOperation,
} from './photo-document';
import {
  validateStudioProject,
  type StudioEditableSnapshot,
  type StudioProjectV1,
} from './project';
import {
  applyVideoOperation,
  type StudioVideoOperation,
} from './video-timeline';

export type StudioProjectOperation =
  | { type: 'project.rename'; name: string }
  | { type: 'project.export.update'; format?: string; quality?: number };

export type StudioEditOperation =
  | { scope: 'photo'; label?: string; operation: StudioPhotoOperation }
  | { scope: 'video'; label?: string; operation: StudioVideoOperation }
  | { scope: 'project'; label?: string; operation: StudioProjectOperation };

export type StudioEditResult =
  | {
    ok: true;
    project: StudioProjectV1;
    summary: string;
    warnings: string[];
  }
  | {
    ok: false;
    project: StudioProjectV1;
    summary: string;
    error: string;
  };

const MAX_HISTORY_ENTRIES = 50;

export function applyStudioEdit(
  project: StudioProjectV1,
  edit: unknown
): StudioEditResult {
  const current = cloneJson(project);
  const initialValidation = validateStudioProject(current);
  if (!initialValidation.ok) {
    return failure(
      current,
      `Studio project is invalid: ${initialValidation.errors.join('; ')}`,
      'invalid-studio-project'
    );
  }
  if (!isRecord(edit) || !isRecord(edit.operation)) {
    return failure(current, 'Studio edit requires scope and operation.', 'invalid-studio-edit');
  }

  const before = snapshotProject(current);
  const next = cloneJson(current);
  let scope: 'photo' | 'video' | 'project';
  let summary = '';
  let warnings: string[] = [];

  if (edit.scope === 'photo') {
    scope = 'photo';
    const result = applyPhotoOperation(next.photo, edit.operation, next.canvas);
    if (!result.ok) {
      return failure(current, result.summary, result.error);
    }
    next.photo = result.document;
    if (result.canvas) {
      next.canvas = result.canvas;
    }
    summary = result.summary;
  } else if (edit.scope === 'video') {
    scope = 'video';
    const result = applyVideoOperation(next.video, edit.operation);
    if (!result.ok) {
      return failure(current, result.summary, result.error);
    }
    next.video = result.timeline;
    summary = result.summary;
    warnings = result.warnings;
  } else if (edit.scope === 'project') {
    scope = 'project';
    const result = applyProjectOperation(next, edit.operation);
    if (!result.ok) {
      return failure(current, result.summary, result.error);
    }
    summary = result.summary;
  } else {
    return failure(current, 'Studio edit scope must be photo, video, or project.', 'invalid-studio-edit-scope');
  }

  const validation = validateStudioProject(next);
  if (!validation.ok) {
    return failure(
      current,
      `Studio edit would create an invalid project: ${validation.errors.join('; ')}`,
      'invalid-studio-edit-result'
    );
  }

  if (isTransientEdit(edit)) {
    return {
      ok: true,
      project: next,
      summary,
      warnings: unique([...warnings, ...validation.warnings]),
    };
  }

  next.updatedAt = new Date().toISOString();
  const entries = next.history.entries.slice(0, next.history.cursor + 1);
  entries.push({
    id: randomUUID(),
    label: normalizeLabel(readString(edit.label), summary),
    scope,
    createdAt: next.updatedAt,
    before,
    after: snapshotProject(next),
  });
  while (entries.length > MAX_HISTORY_ENTRIES) {
    entries.shift();
  }
  next.history = {
    entries,
    cursor: entries.length - 1,
  };

  return {
    ok: true,
    project: next,
    summary,
    warnings: unique([...warnings, ...validation.warnings]),
  };
}

export function stepStudioHistory(
  project: StudioProjectV1,
  direction: 'undo' | 'redo'
): StudioEditResult {
  const current = cloneJson(project);
  const validation = validateStudioProject(current);
  if (!validation.ok) {
    return failure(
      current,
      `Studio project is invalid: ${validation.errors.join('; ')}`,
      'invalid-studio-project'
    );
  }

  if (direction === 'undo') {
    const entry = current.history.entries[current.history.cursor];
    if (!entry) {
      return failure(current, 'Nothing to undo.', 'studio-history-start');
    }
    restoreSnapshot(current, entry.before);
    current.history.cursor -= 1;
    current.updatedAt = new Date().toISOString();
    return {
      ok: true,
      project: current,
      summary: `Undid: ${entry.label}`,
      warnings: [],
    };
  }

  if (direction === 'redo') {
    const entry = current.history.entries[current.history.cursor + 1];
    if (!entry) {
      return failure(current, 'Nothing to redo.', 'studio-history-end');
    }
    restoreSnapshot(current, entry.after);
    current.history.cursor += 1;
    current.updatedAt = new Date().toISOString();
    return {
      ok: true,
      project: current,
      summary: `Redid: ${entry.label}`,
      warnings: [],
    };
  }

  return failure(current, 'History direction must be undo or redo.', 'invalid-studio-history-direction');
}

function applyProjectOperation(
  project: StudioProjectV1,
  operation: Record<string, unknown>
): { ok: true; summary: string } | { ok: false; summary: string; error: string } {
  switch (operation.type) {
  case 'project.rename': {
    const name = readString(operation.name);
    if (name.length < 1 || name.length > 120) {
      return { ok: false, summary: 'Project name must contain 1-120 characters.', error: 'invalid-project-name' };
    }
    project.name = name;
    return { ok: true, summary: `Project renamed to ${name}.` };
  }
  case 'project.export.update': {
    if (operation.format !== undefined) {
      const format = readString(operation.format).toLowerCase();
      const allowed = project.mode === 'photo'
        ? ['png', 'jpeg', 'jpg', 'webp']
        : ['mp4', 'webm', 'gif'];
      if (!allowed.includes(format)) {
        return { ok: false, summary: `Unsupported export format: ${format}`, error: 'unsupported-export-format' };
      }
      project.export.format = format === 'jpg' ? 'jpeg' : format;
    }
    if (operation.quality !== undefined) {
      const quality = Number(operation.quality);
      if (!Number.isFinite(quality) || quality < 0.1 || quality > 1) {
        return { ok: false, summary: 'Export quality must be between 0.1 and 1.', error: 'invalid-export-quality' };
      }
      project.export.quality = quality;
    }
    return { ok: true, summary: 'Project export settings updated.' };
  }
  default:
    return {
      ok: false,
      summary: `Unsupported project operation: ${String(operation.type || '')}`,
      error: 'unsupported-project-operation',
    };
  }
}

function snapshotProject(project: StudioProjectV1): StudioEditableSnapshot {
  return cloneJson({
    name: project.name,
    mode: project.mode,
    canvas: project.canvas,
    photo: project.photo,
    video: project.video,
    export: project.export,
  });
}

function restoreSnapshot(project: StudioProjectV1, snapshot: StudioEditableSnapshot): void {
  const restored = cloneJson(snapshot);
  project.name = restored.name;
  project.mode = restored.mode;
  project.canvas = restored.canvas;
  project.photo = restored.photo;
  project.video = restored.video;
  project.export = restored.export;
}

function normalizeLabel(label: string, fallback: string): string {
  return (label || fallback || 'Studio edit').slice(0, 120);
}

function isTransientEdit(edit: Record<string, unknown>): boolean {
  if (!isRecord(edit.operation)) {
    return false;
  }
  return edit.operation.type === 'photo.selection.set'
    || edit.operation.type === 'video.selection.set'
    || edit.operation.type === 'video.timeline.playhead';
}

function failure(
  project: StudioProjectV1,
  summary: string,
  error: string
): StudioEditResult {
  return { ok: false, project, summary, error };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
