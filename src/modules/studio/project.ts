import { randomUUID } from 'node:crypto';
import {
  createPhotoDocument,
  validatePhotoDocument,
  type StudioPhotoDocument,
} from './photo-document';
import {
  createVideoTimeline,
  validateVideoTimeline,
  type StudioVideoTimeline,
} from './video-timeline';

export type StudioProjectMode = 'photo' | 'video';

export interface StudioCanvasState {
  width: number;
  height: number;
  background: string;
}

export interface StudioExportSettings {
  format: string;
  quality: number;
}

export interface StudioEditableSnapshot {
  name: string;
  mode: StudioProjectMode;
  canvas: StudioCanvasState;
  photo: StudioPhotoDocument;
  video: StudioVideoTimeline;
  export: StudioExportSettings;
}

export interface StudioHistoryEntryV1 {
  id: string;
  label: string;
  scope: 'photo' | 'video' | 'project';
  createdAt: string;
  before: StudioEditableSnapshot;
  after: StudioEditableSnapshot;
}

export interface StudioProjectV1 {
  format: 'monarch-studio';
  version: 1;
  id: string;
  name: string;
  mode: StudioProjectMode;
  createdAt: string;
  updatedAt: string;
  canvas: StudioCanvasState;
  photo: StudioPhotoDocument;
  video: StudioVideoTimeline;
  history: {
    cursor: number;
    entries: StudioHistoryEntryV1[];
  };
  export: StudioExportSettings;
}

export interface StudioProjectValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function createStudioProject(input: unknown): StudioProjectV1 | null {
  if (!isRecord(input)) {
    return null;
  }
  const name = readString(input.name);
  const mode = input.mode === 'photo' || input.mode === 'video' ? input.mode : '';
  if (!name || !mode) {
    return null;
  }

  const now = new Date().toISOString();
  const width = clampInteger(input.width, mode === 'photo' ? 1920 : 1080, 16, 16384);
  const height = clampInteger(input.height, mode === 'photo' ? 1080 : 1920, 16, 16384);
  const fps = clampInteger(input.fps, 30, 1, 120);
  const durationMs = clampInteger(input.durationMs, mode === 'video' ? 10_000 : 0, 0, 86_400_000);
  return {
    format: 'monarch-studio',
    version: 1,
    id: randomUUID(),
    name: name.slice(0, 120),
    mode,
    createdAt: now,
    updatedAt: now,
    canvas: {
      width,
      height,
      background: normalizeColor(readString(input.background)) || '#101010',
    },
    photo: createPhotoDocument(),
    video: createVideoTimeline(Math.max(1, durationMs), fps),
    history: {
      cursor: -1,
      entries: [],
    },
    export: {
      format: mode === 'photo' ? 'png' : 'mp4',
      quality: 0.92,
    },
  };
}

export function validateStudioProject(value: unknown): StudioProjectValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['project must be an object'], warnings };
  }
  if (value.format !== 'monarch-studio') {
    errors.push('format must be monarch-studio');
  }
  if (value.version !== 1) {
    errors.push('only project version 1 is supported');
  }
  if (value.mode !== 'photo' && value.mode !== 'video') {
    errors.push('mode must be photo or video');
  }
  if (!readString(value.id)) {
    errors.push('project id is required');
  }
  if (!readString(value.name)) {
    errors.push('project name is required');
  }
  if (!isRecord(value.canvas)) {
    errors.push('canvas is required');
  } else {
    const width = Number(value.canvas.width);
    const height = Number(value.canvas.height);
    if (!Number.isInteger(width) || width < 16 || width > 16384) {
      errors.push('canvas width must be an integer from 16 to 16384');
    }
    if (!Number.isInteger(height) || height < 16 || height > 16384) {
      errors.push('canvas height must be an integer from 16 to 16384');
    }
    if (!normalizeProjectColor(readOptionalString(value.canvas.background))) {
      errors.push('canvas background must be transparent or a CSS hex color');
    }
  }
  if (!isRecord(value.history) || !Array.isArray(value.history.entries)) {
    errors.push('history entries are required');
  } else {
    const cursor = Number(value.history.cursor);
    if (!Number.isInteger(cursor) || cursor < -1 || cursor >= value.history.entries.length) {
      errors.push('history cursor is outside the available entries');
    }
    if (value.history.entries.length > 50) {
      errors.push('history cannot contain more than 50 entries');
    }
    const entryIds: string[] = [];
    value.history.entries.forEach((entry, index) => {
      const entryErrors = validateHistoryEntry(entry);
      errors.push(...entryErrors.map((error) => `history entry ${index}: ${error}`));
      if (isRecord(entry)) {
        const entryId = readOptionalString(entry.id);
        if (entryId) entryIds.push(entryId);
      }
    });
    if (new Set(entryIds).size !== entryIds.length) {
      errors.push('history entry ids must be unique');
    }
  }
  const photoValidation = validatePhotoDocument(value.photo);
  errors.push(...photoValidation.errors);
  warnings.push(...photoValidation.warnings);
  const videoValidation = validateVideoTimeline(value.video);
  errors.push(...videoValidation.errors);
  warnings.push(...videoValidation.warnings);
  if (isRecord(value.photo) && isRecord(value.photo.crop) && isRecord(value.canvas)) {
    const crop = value.photo.crop;
    if (
      Number(crop.x) + Number(crop.width) > Number(value.canvas.width)
      || Number(crop.y) + Number(crop.height) > Number(value.canvas.height)
    ) {
      errors.push('photo crop extends outside the canvas');
    }
  }
  if (!isRecord(value.export)) {
    errors.push('export settings are required');
  } else {
    const format = readOptionalString(value.export.format).toLowerCase();
    const allowed = value.mode === 'photo'
      ? ['png', 'jpeg', 'webp']
      : ['mp4', 'webm', 'gif'];
    if (!allowed.includes(format)) {
      errors.push(`unsupported ${String(value.mode || '')} export format: ${format}`);
    }
    const quality = Number(value.export.quality);
    if (!Number.isFinite(quality) || quality < 0.1 || quality > 1) {
      errors.push('export quality must be between 0.1 and 1');
    }
  }
  if (isRecord(value.photo) && value.photo.source && !readString(value.photo.source)) {
    warnings.push('photo source is present but empty');
  }

  return { ok: errors.length === 0, errors: unique(errors), warnings: unique(warnings) };
}

export function safeProjectFileName(project: StudioProjectV1): string {
  const base = project.name.toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project';
  return `${base}-${project.id.slice(0, 8)}.monarch-studio.json`;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '';
}

function normalizeProjectColor(value: string): string {
  if (value === 'transparent') {
    return value;
  }
  return /^#[0-9a-f]{3}$/i.test(value)
    || /^#[0-9a-f]{6}$/i.test(value)
    || /^#[0-9a-f]{8}$/i.test(value)
    ? value.toLowerCase()
    : '';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validateHistoryEntry(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['entry must be an object'];
  }
  const errors: string[] = [];
  if (!readOptionalString(value.id)) errors.push('id is required');
  if (!readOptionalString(value.label)) errors.push('label is required');
  if (value.scope !== 'photo' && value.scope !== 'video' && value.scope !== 'project') {
    errors.push('scope must be photo, video, or project');
  }
  if (!readOptionalString(value.createdAt)) errors.push('createdAt is required');
  errors.push(...validateEditableSnapshot(value.before).map((error) => `before ${error}`));
  errors.push(...validateEditableSnapshot(value.after).map((error) => `after ${error}`));
  return errors;
}

function validateEditableSnapshot(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['snapshot must be an object'];
  }
  const errors: string[] = [];
  if (!readOptionalString(value.name)) errors.push('snapshot name is required');
  if (!isRecord(value.canvas)) {
    errors.push('snapshot canvas is required');
  } else {
    const width = Number(value.canvas.width);
    const height = Number(value.canvas.height);
    if (!Number.isInteger(width) || width < 16 || width > 16384) {
      errors.push('snapshot canvas width is invalid');
    }
    if (!Number.isInteger(height) || height < 16 || height > 16384) {
      errors.push('snapshot canvas height is invalid');
    }
    if (!normalizeProjectColor(readOptionalString(value.canvas.background))) {
      errors.push('snapshot canvas background is invalid');
    }
  }
  errors.push(...validatePhotoDocument(value.photo).errors.map((error) => `snapshot ${error}`));
  errors.push(...validateVideoTimeline(value.video).errors.map((error) => `snapshot ${error}`));
  if (!isRecord(value.export)) {
    errors.push('snapshot export settings are required');
  } else {
    const mode = value.mode === 'photo' || value.mode === 'video' ? value.mode : '';
    if (!mode) {
      errors.push('snapshot mode is invalid');
    } else {
      const format = readOptionalString(value.export.format).toLowerCase();
      const allowed = mode === 'photo' ? ['png', 'jpeg', 'webp'] : ['mp4', 'webm', 'gif'];
      if (!allowed.includes(format)) {
        errors.push('snapshot export format is invalid');
      }
    }
    const quality = Number(value.export.quality);
    if (!Number.isFinite(quality) || quality < 0.1 || quality > 1) {
      errors.push('snapshot export quality is invalid');
    }
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
