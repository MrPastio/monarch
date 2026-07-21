import { randomUUID } from 'node:crypto';

export type StudioBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten';

export interface StudioPhotoFilters {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  blur: number;
  grayscale: number;
  sepia: number;
  invert: number;
}

interface StudioPhotoObjectBase {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  blendMode: StudioBlendMode;
}

export interface StudioImageObject extends StudioPhotoObjectBase {
  kind: 'image';
  source: string;
  filters: StudioPhotoFilters;
}

export interface StudioTextObject extends StudioPhotoObjectBase {
  kind: 'text';
  text: string;
  color: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700;
  align: 'left' | 'center' | 'right';
}

export interface StudioShapeObject extends StudioPhotoObjectBase {
  kind: 'shape';
  shape: 'rectangle' | 'ellipse' | 'line';
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface StudioDrawingObject extends StudioPhotoObjectBase {
  kind: 'drawing';
  points: Array<{ x: number; y: number }>;
  color: string;
  strokeWidth: number;
}

export type StudioPhotoObject =
  | StudioImageObject
  | StudioTextObject
  | StudioShapeObject
  | StudioDrawingObject;

export interface StudioCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StudioPhotoDocument {
  source?: string;
  rotation: 0 | 90 | 180 | 270;
  flipX: boolean;
  flipY: boolean;
  crop: StudioCropRect | null;
  objects: StudioPhotoObject[];
  selectedObjectIds: string[];
}

export type StudioPhotoOperation =
  | { type: 'photo.source.set'; source: string }
  | { type: 'photo.canvas.resize'; width: number; height: number }
  | { type: 'photo.canvas.background'; background: string }
  | { type: 'photo.transform.rotate'; degrees: 90 | -90 | 180 }
  | { type: 'photo.transform.flip'; axis: 'x' | 'y' }
  | { type: 'photo.crop.set'; crop: StudioCropRect }
  | { type: 'photo.crop.clear' }
  | { type: 'photo.object.add'; object: unknown }
  | { type: 'photo.object.update'; objectId: string; patch: unknown }
  | { type: 'photo.object.remove'; objectId: string }
  | { type: 'photo.object.duplicate'; objectId: string }
  | { type: 'photo.object.reorder'; objectId: string; index: number }
  | { type: 'photo.selection.set'; objectIds: string[] };

export type StudioPhotoOperationResult =
  | {
    ok: true;
    document: StudioPhotoDocument;
    canvas?: { width: number; height: number; background: string };
    summary: string;
  }
  | {
    ok: false;
    document: StudioPhotoDocument;
    summary: string;
    error: string;
  };

export interface StudioPhotoValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function createPhotoDocument(): StudioPhotoDocument {
  return {
    rotation: 0,
    flipX: false,
    flipY: false,
    crop: null,
    objects: [],
    selectedObjectIds: [],
  };
}

export function applyPhotoOperation(
  document: StudioPhotoDocument,
  operation: unknown,
  canvas: { width: number; height: number; background: string }
): StudioPhotoOperationResult {
  const next = clonePhotoDocument(document);
  if (!isRecord(operation) || typeof operation.type !== 'string') {
    return failure(next, 'Photo operation requires a type.', 'invalid-photo-operation');
  }

  switch (operation.type) {
  case 'photo.source.set': {
    const source = readString(operation.source);
    if (!source) {
      return failure(next, 'Photo source cannot be empty.', 'invalid-photo-source');
    }
    next.source = source;
    return success(next, 'Photo source updated.');
  }
  case 'photo.canvas.resize': {
    const width = readInteger(operation.width);
    const height = readInteger(operation.height);
    if (!validCanvasSize(width) || !validCanvasSize(height)) {
      return failure(next, 'Canvas dimensions must be integers from 16 to 16384.', 'invalid-canvas-size');
    }
    if (
      next.crop
      && (next.crop.x + next.crop.width > width || next.crop.y + next.crop.height > height)
    ) {
      return failure(
        next,
        'Resize would place the current crop outside the canvas. Clear or adjust the crop first.',
        'photo-crop-outside-resized-canvas'
      );
    }
    return success(next, `Canvas resized to ${width}×${height}.`, {
      width,
      height,
      background: canvas.background,
    });
  }
  case 'photo.canvas.background': {
    const background = normalizeColor(readString(operation.background), true);
    if (!background) {
      return failure(next, 'Canvas background must be transparent or a CSS hex color.', 'invalid-canvas-background');
    }
    return success(next, 'Canvas background updated.', {
      ...canvas,
      background,
    });
  }
  case 'photo.transform.rotate': {
    const degrees = Number(operation.degrees);
    if (degrees !== 90 && degrees !== -90 && degrees !== 180) {
      return failure(next, 'Rotation must be 90, -90, or 180 degrees.', 'invalid-photo-rotation');
    }
    next.rotation = normalizeRightAngle(next.rotation + degrees);
    return success(next, `Photo rotated to ${next.rotation} degrees.`);
  }
  case 'photo.transform.flip': {
    if (operation.axis === 'x') {
      next.flipX = !next.flipX;
    } else if (operation.axis === 'y') {
      next.flipY = !next.flipY;
    } else {
      return failure(next, 'Flip axis must be x or y.', 'invalid-photo-flip');
    }
    return success(next, `Photo flipped on the ${operation.axis} axis.`);
  }
  case 'photo.crop.set': {
    const crop = normalizeCrop(operation.crop, canvas);
    if (!crop) {
      return failure(next, 'Crop must stay inside the canvas and have a positive size.', 'invalid-photo-crop');
    }
    next.crop = crop;
    return success(next, 'Photo crop updated.');
  }
  case 'photo.crop.clear':
    next.crop = null;
    return success(next, 'Photo crop cleared.');
  case 'photo.object.add': {
    const object = normalizePhotoObject(operation.object);
    if (!object) {
      return failure(next, 'Photo object is invalid.', 'invalid-photo-object');
    }
    if (next.objects.some((entry) => entry.id === object.id)) {
      return failure(next, `Photo object already exists: ${object.id}`, 'photo-object-exists');
    }
    next.objects.push(object);
    next.selectedObjectIds = [object.id];
    return success(next, `${object.name} added.`);
  }
  case 'photo.object.update': {
    const objectId = readString(operation.objectId);
    const index = next.objects.findIndex((entry) => entry.id === objectId);
    if (index < 0) {
      return failure(next, `Photo object not found: ${objectId}`, 'photo-object-not-found');
    }
    const current = next.objects[index]!;
    if (current.locked && (!isRecord(operation.patch) || operation.patch.locked !== false)) {
      return failure(next, `Photo object is locked: ${objectId}`, 'photo-object-locked');
    }
    const updated = patchPhotoObject(current, operation.patch);
    if (!updated) {
      return failure(next, `Photo object patch is invalid: ${objectId}`, 'invalid-photo-object-patch');
    }
    next.objects[index] = updated;
    return success(next, `${updated.name} updated.`);
  }
  case 'photo.object.remove': {
    const objectId = readString(operation.objectId);
    const object = next.objects.find((entry) => entry.id === objectId);
    if (!object) {
      return failure(next, `Photo object not found: ${objectId}`, 'photo-object-not-found');
    }
    if (object.locked) {
      return failure(next, `Photo object is locked: ${objectId}`, 'photo-object-locked');
    }
    next.objects = next.objects.filter((entry) => entry.id !== objectId);
    next.selectedObjectIds = next.selectedObjectIds.filter((id) => id !== objectId);
    return success(next, `${object.name} removed.`);
  }
  case 'photo.object.duplicate': {
    const objectId = readString(operation.objectId);
    const object = next.objects.find((entry) => entry.id === objectId);
    if (!object) {
      return failure(next, `Photo object not found: ${objectId}`, 'photo-object-not-found');
    }
    const duplicate = cloneJson(object);
    duplicate.id = randomUUID();
    duplicate.name = `${object.name} copy`;
    duplicate.x += 24;
    duplicate.y += 24;
    next.objects.push(duplicate);
    next.selectedObjectIds = [duplicate.id];
    return success(next, `${object.name} duplicated.`);
  }
  case 'photo.object.reorder': {
    const objectId = readString(operation.objectId);
    const currentIndex = next.objects.findIndex((entry) => entry.id === objectId);
    const requestedIndex = readInteger(operation.index);
    if (currentIndex < 0) {
      return failure(next, `Photo object not found: ${objectId}`, 'photo-object-not-found');
    }
    if (!Number.isInteger(requestedIndex)) {
      return failure(next, 'Layer index must be an integer.', 'invalid-photo-layer-index');
    }
    const [object] = next.objects.splice(currentIndex, 1);
    if (!object) {
      return failure(next, `Photo object not found: ${objectId}`, 'photo-object-not-found');
    }
    const index = Math.max(0, Math.min(requestedIndex, next.objects.length));
    next.objects.splice(index, 0, object);
    return success(next, `${object.name} moved to layer ${index + 1}.`);
  }
  case 'photo.selection.set': {
    if (!Array.isArray(operation.objectIds)) {
      return failure(next, 'Selection must be an array of object ids.', 'invalid-photo-selection');
    }
    const requested = unique(operation.objectIds.map(readString).filter(Boolean));
    const existing = new Set(next.objects.map((object) => object.id));
    if (requested.some((id) => !existing.has(id))) {
      return failure(next, 'Selection contains an unknown photo object.', 'photo-selection-not-found');
    }
    next.selectedObjectIds = requested;
    return success(next, `${requested.length} photo objects selected.`);
  }
  default:
    return failure(next, `Unsupported photo operation: ${operation.type}`, 'unsupported-photo-operation');
  }
}

export function validatePhotoDocument(value: unknown): StudioPhotoValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['photo document must be an object'], warnings };
  }
  if (![0, 90, 180, 270].includes(Number(value.rotation))) {
    errors.push('photo rotation must be 0, 90, 180, or 270');
  }
  if (typeof value.flipX !== 'boolean' || typeof value.flipY !== 'boolean') {
    errors.push('photo flip state must contain booleans');
  }
  if (!Array.isArray(value.objects)) {
    errors.push('photo objects must be an array');
  } else {
    const objects = value.objects.map((object) => normalizePhotoObject(object, false));
    if (objects.some((object) => !object)) {
      errors.push('photo objects contain an invalid object');
    }
    const ids = objects.filter((object): object is StudioPhotoObject => Boolean(object)).map((object) => object.id);
    if (new Set(ids).size !== ids.length) {
      errors.push('photo object ids must be unique');
    }
  }
  if (!Array.isArray(value.selectedObjectIds)) {
    errors.push('selectedObjectIds must be an array');
  } else if (Array.isArray(value.objects)) {
    const objectIds = new Set(value.objects
      .filter(isRecord)
      .map((object) => readString(object.id))
      .filter(Boolean));
    const selectedIds = value.selectedObjectIds.map(readString).filter(Boolean);
    if (selectedIds.length !== value.selectedObjectIds.length) {
      errors.push('selectedObjectIds must contain non-empty strings');
    }
    if (selectedIds.some((id) => !objectIds.has(id))) {
      errors.push('selectedObjectIds contains an unknown photo object');
    }
  }
  if (value.crop !== null && value.crop !== undefined) {
    if (!isRecord(value.crop)) {
      errors.push('photo crop must be an object or null');
    } else if (
      ![value.crop.x, value.crop.y, value.crop.width, value.crop.height].every(
        (entry) => typeof entry === 'number' && Number.isFinite(entry)
      )
      || Number(value.crop.x) < 0
      || Number(value.crop.y) < 0
      || Number(value.crop.width) <= 0
      || Number(value.crop.height) <= 0
    ) {
      errors.push('photo crop coordinates are invalid');
    }
  }
  if (typeof value.source === 'string' && value.source.startsWith('data:') && value.source.length > 128 * 1024) {
    warnings.push('large embedded image data should be stored as a file reference');
  }
  return { ok: errors.length === 0, errors: unique(errors), warnings: unique(warnings) };
}

function normalizePhotoObject(
  value: unknown,
  generateId = true
): StudioPhotoObject | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!generateId && !isStoredPhotoObjectValid(value)) {
    return null;
  }
  const kind = value.kind;
  if (kind !== 'image' && kind !== 'text' && kind !== 'shape' && kind !== 'drawing') {
    return null;
  }
  const requestedId = readString(value.id);
  if (!requestedId && !generateId) {
    return null;
  }
  const id = requestedId || randomUUID();
  const common: StudioPhotoObjectBase = {
    id,
    name: (readString(value.name) || defaultName(kind)).slice(0, 80),
    x: readFinite(value.x, 0),
    y: readFinite(value.y, 0),
    width: clamp(readFinite(value.width, kind === 'text' ? 480 : 320), 1, 16384),
    height: clamp(readFinite(value.height, kind === 'text' ? 96 : 240), 1, 16384),
    rotation: normalizeDegrees(readFinite(value.rotation, 0)),
    opacity: clamp(readFinite(value.opacity, 1), 0, 1),
    visible: value.visible !== false,
    locked: value.locked === true,
    blendMode: normalizeBlendMode(readString(value.blendMode)),
  };

  if (kind === 'image') {
    const source = readString(value.source);
    if (!source) {
      return null;
    }
    return {
      ...common,
      kind,
      source,
      filters: normalizeFilters(value.filters),
    };
  }
  if (kind === 'text') {
    return {
      ...common,
      kind,
      text: readString(value.text) || 'Текст',
      color: normalizeColor(readString(value.color)) || '#ffffff',
      fontFamily: (readString(value.fontFamily) || 'Inter').slice(0, 80),
      fontSize: clamp(readFinite(value.fontSize, 48), 6, 512),
      fontWeight: normalizeFontWeight(value.fontWeight),
      align: normalizeTextAlign(value.align),
    };
  }
  if (kind === 'shape') {
    return {
      ...common,
      kind,
      shape: value.shape === 'ellipse' || value.shape === 'line' ? value.shape : 'rectangle',
      fill: normalizeColor(readString(value.fill), true) || '#ff9d2e',
      stroke: normalizeColor(readString(value.stroke), true) || 'transparent',
      strokeWidth: clamp(readFinite(value.strokeWidth, 0), 0, 128),
    };
  }

  const points = Array.isArray(value.points)
    ? value.points.map(normalizePoint).filter((point): point is { x: number; y: number } => Boolean(point))
    : [];
  if (points.length < 2) {
    return null;
  }
  return {
    ...common,
    kind,
    points,
    color: normalizeColor(readString(value.color)) || '#ffffff',
    strokeWidth: clamp(readFinite(value.strokeWidth, 6), 1, 128),
  };
}

function isStoredPhotoObjectValid(value: Record<string, unknown>): boolean {
  const kind = value.kind;
  const commonValid = Boolean(readString(value.id))
    && Boolean(readString(value.name))
    && [value.x, value.y, value.width, value.height, value.rotation, value.opacity].every(
      (entry) => typeof entry === 'number' && Number.isFinite(entry)
    )
    && Number(value.width) > 0
    && Number(value.width) <= 16384
    && Number(value.height) > 0
    && Number(value.height) <= 16384
    && Number(value.opacity) >= 0
    && Number(value.opacity) <= 1
    && typeof value.visible === 'boolean'
    && typeof value.locked === 'boolean'
    && ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'].includes(readString(value.blendMode));
  if (!commonValid) {
    return false;
  }
  if (kind === 'image') {
    if (!readString(value.source) || !isRecord(value.filters)) {
      return false;
    }
    const ranges: Array<[unknown, number, number]> = [
      [value.filters.brightness, -1, 1],
      [value.filters.contrast, -1, 1],
      [value.filters.saturation, -1, 1],
      [value.filters.hue, -180, 180],
      [value.filters.blur, 0, 1],
      [value.filters.grayscale, 0, 1],
      [value.filters.sepia, 0, 1],
      [value.filters.invert, 0, 1],
    ];
    return ranges.every(([entry, min, max]) => (
      typeof entry === 'number' && Number.isFinite(entry) && entry >= min && entry <= max
    ));
  }
  if (kind === 'text') {
    return Boolean(readString(value.text))
      && Boolean(normalizeColor(readString(value.color)))
      && Boolean(readString(value.fontFamily))
      && typeof value.fontSize === 'number'
      && Number.isFinite(value.fontSize)
      && value.fontSize >= 6
      && value.fontSize <= 512
      && [400, 500, 600, 700].includes(Number(value.fontWeight))
      && (value.align === 'left' || value.align === 'center' || value.align === 'right');
  }
  if (kind === 'shape') {
    return (value.shape === 'rectangle' || value.shape === 'ellipse' || value.shape === 'line')
      && Boolean(normalizeColor(readString(value.fill), true))
      && Boolean(normalizeColor(readString(value.stroke), true))
      && typeof value.strokeWidth === 'number'
      && Number.isFinite(value.strokeWidth)
      && value.strokeWidth >= 0
      && value.strokeWidth <= 128;
  }
  if (kind === 'drawing') {
    return Array.isArray(value.points)
      && value.points.length >= 2
      && value.points.every((point) => Boolean(normalizePoint(point)))
      && Boolean(normalizeColor(readString(value.color)))
      && typeof value.strokeWidth === 'number'
      && Number.isFinite(value.strokeWidth)
      && value.strokeWidth >= 1
      && value.strokeWidth <= 128;
  }
  return false;
}

function patchPhotoObject(current: StudioPhotoObject, patch: unknown): StudioPhotoObject | null {
  if (!isRecord(patch) || (patch.kind !== undefined && patch.kind !== current.kind)) {
    return null;
  }
  const candidate: Record<string, unknown> = {
    ...current,
    ...pickDefined(patch, [
      'name', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked', 'blendMode',
    ]),
  };
  if (current.kind === 'image') {
    candidate.source = patch.source ?? current.source;
    candidate.filters = isRecord(patch.filters)
      ? { ...current.filters, ...patch.filters }
      : current.filters;
  } else if (current.kind === 'text') {
    Object.assign(candidate, pickDefined(patch, [
      'text', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'align',
    ]));
  } else if (current.kind === 'shape') {
    Object.assign(candidate, pickDefined(patch, ['shape', 'fill', 'stroke', 'strokeWidth']));
  } else {
    Object.assign(candidate, pickDefined(patch, ['points', 'color', 'strokeWidth']));
  }
  return normalizePhotoObject(candidate);
}

function normalizeFilters(value: unknown): StudioPhotoFilters {
  const filters = isRecord(value) ? value : {};
  return {
    brightness: clamp(readFinite(filters.brightness, 0), -1, 1),
    contrast: clamp(readFinite(filters.contrast, 0), -1, 1),
    saturation: clamp(readFinite(filters.saturation, 0), -1, 1),
    hue: clamp(readFinite(filters.hue, 0), -180, 180),
    blur: clamp(readFinite(filters.blur, 0), 0, 1),
    grayscale: clamp(readFinite(filters.grayscale, 0), 0, 1),
    sepia: clamp(readFinite(filters.sepia, 0), 0, 1),
    invert: clamp(readFinite(filters.invert, 0), 0, 1),
  };
}

function normalizeCrop(
  value: unknown,
  canvas: { width: number; height: number }
): StudioCropRect | null {
  if (!isRecord(value)) {
    return null;
  }
  const crop = {
    x: readFinite(value.x, Number.NaN),
    y: readFinite(value.y, Number.NaN),
    width: readFinite(value.width, Number.NaN),
    height: readFinite(value.height, Number.NaN),
  };
  if (
    !Object.values(crop).every(Number.isFinite)
    || crop.x < 0
    || crop.y < 0
    || crop.width <= 0
    || crop.height <= 0
    || crop.x + crop.width > canvas.width
    || crop.y + crop.height > canvas.height
  ) {
    return null;
  }
  return crop;
}

function normalizePoint(value: unknown): { x: number; y: number } | null {
  if (!isRecord(value)) {
    return null;
  }
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function success(
  document: StudioPhotoDocument,
  summary: string,
  canvas?: { width: number; height: number; background: string }
): StudioPhotoOperationResult {
  return canvas ? { ok: true, document, summary, canvas } : { ok: true, document, summary };
}

function failure(
  document: StudioPhotoDocument,
  summary: string,
  error: string
): StudioPhotoOperationResult {
  return { ok: false, document, summary, error };
}

function clonePhotoDocument(value: StudioPhotoDocument): StudioPhotoDocument {
  return cloneJson(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultName(kind: StudioPhotoObject['kind']): string {
  switch (kind) {
  case 'image': return 'Image';
  case 'text': return 'Text';
  case 'shape': return 'Shape';
  case 'drawing': return 'Drawing';
  }
}

function normalizeRightAngle(value: number): 0 | 90 | 180 | 270 {
  const normalized = ((value % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

function normalizeDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < -180 ? normalized + 360 : normalized > 180 ? normalized - 360 : normalized;
}

function normalizeBlendMode(value: string): StudioBlendMode {
  return value === 'multiply'
    || value === 'screen'
    || value === 'overlay'
    || value === 'darken'
    || value === 'lighten'
    ? value
    : 'normal';
}

function normalizeFontWeight(value: unknown): 400 | 500 | 600 | 700 {
  const numeric = Number(value);
  return numeric === 500 || numeric === 600 || numeric === 700 ? numeric : 400;
}

function normalizeTextAlign(value: unknown): 'left' | 'center' | 'right' {
  return value === 'center' || value === 'right' ? value : 'left';
}

function normalizeColor(value: string, allowTransparent = false): string {
  if (allowTransparent && value === 'transparent') {
    return value;
  }
  if (/^#[0-9a-f]{3}$/i.test(value) || /^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{8}$/i.test(value)) {
    return value.toLowerCase();
  }
  return '';
}

function validCanvasSize(value: number): boolean {
  return Number.isInteger(value) && value >= 16 && value <= 16384;
}

function readInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : Number.NaN;
}

function readFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      output[key] = source[key];
    }
  }
  return output;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
