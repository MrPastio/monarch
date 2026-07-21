import { randomUUID } from 'node:crypto';

export type StudioVideoTrackKind = 'video' | 'audio' | 'text';
export type StudioVideoClipKind = 'video' | 'audio' | 'image' | 'text';

export interface StudioVideoClip {
  id: string;
  kind: StudioVideoClipKind;
  name: string;
  source?: string;
  text?: string;
  startMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  playbackRate: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  opacity: number;
  locked: boolean;
}

export interface StudioVideoTrack {
  id: string;
  kind: StudioVideoTrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  clips: StudioVideoClip[];
}

export interface StudioVideoTimeline {
  durationMs: number;
  fps: number;
  playheadMs: number;
  selectedClipIds: string[];
  tracks: StudioVideoTrack[];
}

export type StudioVideoOperation =
  | { type: 'video.timeline.duration'; durationMs: number }
  | { type: 'video.timeline.playhead'; playheadMs: number }
  | { type: 'video.track.add'; track: unknown }
  | { type: 'video.track.update'; trackId: string; patch: unknown }
  | { type: 'video.track.remove'; trackId: string }
  | { type: 'video.track.reorder'; trackId: string; index: number }
  | { type: 'video.clip.add'; trackId: string; clip: unknown }
  | { type: 'video.clip.update'; trackId: string; clipId: string; patch: unknown }
  | { type: 'video.clip.remove'; trackId: string; clipId: string }
  | {
    type: 'video.clip.move';
    clipId: string;
    fromTrackId: string;
    toTrackId: string;
    startMs: number;
    index?: number;
  }
  | { type: 'video.clip.split'; trackId: string; clipId: string; atMs: number }
  | { type: 'video.selection.set'; clipIds: string[] };

export type StudioVideoOperationResult =
  | {
    ok: true;
    timeline: StudioVideoTimeline;
    summary: string;
    warnings: string[];
  }
  | {
    ok: false;
    timeline: StudioVideoTimeline;
    summary: string;
    error: string;
  };

export interface StudioVideoValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function createVideoTimeline(
  durationMs = 10_000,
  fps = 30
): StudioVideoTimeline {
  return {
    durationMs: clampInteger(durationMs, 1, 86_400_000),
    fps: clampInteger(fps, 1, 120),
    playheadMs: 0,
    selectedClipIds: [],
    tracks: [],
  };
}

export function applyVideoOperation(
  timeline: StudioVideoTimeline,
  operation: unknown
): StudioVideoOperationResult {
  const next = cloneJson(timeline);
  if (!isRecord(operation) || typeof operation.type !== 'string') {
    return failure(next, 'Video operation requires a type.', 'invalid-video-operation');
  }

  switch (operation.type) {
  case 'video.timeline.duration': {
    const durationMs = readInteger(operation.durationMs);
    if (!validDuration(durationMs)) {
      return failure(next, 'Timeline duration must be 1 ms to 24 hours.', 'invalid-video-duration');
    }
    const contentEnd = timelineContentEnd(next);
    if (durationMs < contentEnd) {
      return failure(
        next,
        `Timeline duration cannot be shorter than content ending at ${contentEnd} ms.`,
        'video-content-outside-duration'
      );
    }
    next.durationMs = durationMs;
    next.playheadMs = Math.min(next.playheadMs, durationMs);
    return success(next, `Timeline duration set to ${durationMs} ms.`);
  }
  case 'video.timeline.playhead': {
    const playheadMs = readFinite(operation.playheadMs, Number.NaN);
    if (!Number.isFinite(playheadMs)) {
      return failure(next, 'Playhead position must be a number.', 'invalid-video-playhead');
    }
    next.playheadMs = clamp(playheadMs, 0, next.durationMs);
    return success(next, `Playhead moved to ${Math.round(next.playheadMs)} ms.`);
  }
  case 'video.track.add': {
    const track = normalizeTrack(operation.track);
    if (!track) {
      return failure(next, 'Video track is invalid.', 'invalid-video-track');
    }
    if (next.tracks.some((entry) => entry.id === track.id)) {
      return failure(next, `Video track already exists: ${track.id}`, 'video-track-exists');
    }
    next.tracks.push(track);
    return success(next, `${track.name} added.`);
  }
  case 'video.track.update': {
    const trackId = readString(operation.trackId);
    const track = next.tracks.find((entry) => entry.id === trackId);
    if (!track) {
      return failure(next, `Video track not found: ${trackId}`, 'video-track-not-found');
    }
    if (!isRecord(operation.patch)) {
      return failure(next, 'Video track patch is invalid.', 'invalid-video-track-patch');
    }
    if (track.locked && operation.patch.locked !== false) {
      return failure(next, `Video track is locked: ${trackId}`, 'video-track-locked');
    }
    if (operation.patch.name !== undefined) {
      const name = readString(operation.patch.name);
      if (!name) {
        return failure(next, 'Video track name cannot be empty.', 'invalid-video-track-name');
      }
      track.name = name.slice(0, 80);
    }
    if (operation.patch.muted !== undefined) {
      track.muted = operation.patch.muted === true;
    }
    if (operation.patch.locked !== undefined) {
      track.locked = operation.patch.locked === true;
    }
    return success(next, `${track.name} updated.`);
  }
  case 'video.track.remove': {
    const trackId = readString(operation.trackId);
    const track = next.tracks.find((entry) => entry.id === trackId);
    if (!track) {
      return failure(next, `Video track not found: ${trackId}`, 'video-track-not-found');
    }
    if (track.locked) {
      return failure(next, `Video track is locked: ${trackId}`, 'video-track-locked');
    }
    next.tracks = next.tracks.filter((entry) => entry.id !== trackId);
    const removedIds = new Set(track.clips.map((clip) => clip.id));
    next.selectedClipIds = next.selectedClipIds.filter((id) => !removedIds.has(id));
    return success(next, `${track.name} removed.`);
  }
  case 'video.track.reorder': {
    const trackId = readString(operation.trackId);
    const currentIndex = next.tracks.findIndex((entry) => entry.id === trackId);
    const requestedIndex = readInteger(operation.index);
    if (currentIndex < 0) {
      return failure(next, `Video track not found: ${trackId}`, 'video-track-not-found');
    }
    if (!Number.isInteger(requestedIndex)) {
      return failure(next, 'Video track index must be an integer.', 'invalid-video-track-index');
    }
    const [track] = next.tracks.splice(currentIndex, 1);
    if (!track) {
      return failure(next, `Video track not found: ${trackId}`, 'video-track-not-found');
    }
    next.tracks.splice(clampInteger(requestedIndex, 0, next.tracks.length), 0, track);
    return success(next, `${track.name} reordered.`);
  }
  case 'video.clip.add': {
    const track = findTrack(next, operation.trackId);
    if (!track) {
      return failure(next, `Video track not found: ${readString(operation.trackId)}`, 'video-track-not-found');
    }
    if (track.locked) {
      return failure(next, `Video track is locked: ${track.id}`, 'video-track-locked');
    }
    const clip = normalizeClip(operation.clip, track.kind);
    if (!clip) {
      return failure(next, 'Video clip is invalid for this track.', 'invalid-video-clip');
    }
    if (findClip(next, clip.id)) {
      return failure(next, `Video clip already exists: ${clip.id}`, 'video-clip-exists');
    }
    track.clips.push(clip);
    sortClips(track);
    next.durationMs = Math.max(next.durationMs, clipEnd(clip));
    next.selectedClipIds = [clip.id];
    return success(next, `${clip.name} added.`);
  }
  case 'video.clip.update': {
    const track = findTrack(next, operation.trackId);
    const clip = track?.clips.find((entry) => entry.id === readString(operation.clipId));
    if (!track || !clip) {
      return failure(next, `Video clip not found: ${readString(operation.clipId)}`, 'video-clip-not-found');
    }
    if (
      track.locked
      || (clip.locked && (!isRecord(operation.patch) || operation.patch.locked !== false))
    ) {
      return failure(next, `Video clip is locked: ${clip.id}`, 'video-clip-locked');
    }
    const updated = patchClip(clip, operation.patch, track.kind);
    if (!updated) {
      return failure(next, `Video clip patch is invalid: ${clip.id}`, 'invalid-video-clip-patch');
    }
    const index = track.clips.findIndex((entry) => entry.id === clip.id);
    track.clips[index] = updated;
    sortClips(track);
    next.durationMs = Math.max(next.durationMs, clipEnd(updated));
    return success(next, `${updated.name} updated.`);
  }
  case 'video.clip.remove': {
    const track = findTrack(next, operation.trackId);
    const clip = track?.clips.find((entry) => entry.id === readString(operation.clipId));
    if (!track || !clip) {
      return failure(next, `Video clip not found: ${readString(operation.clipId)}`, 'video-clip-not-found');
    }
    if (track.locked || clip.locked) {
      return failure(next, `Video clip is locked: ${clip.id}`, 'video-clip-locked');
    }
    track.clips = track.clips.filter((entry) => entry.id !== clip.id);
    next.selectedClipIds = next.selectedClipIds.filter((id) => id !== clip.id);
    return success(next, `${clip.name} removed.`);
  }
  case 'video.clip.move': {
    const fromTrack = findTrack(next, operation.fromTrackId);
    const toTrack = findTrack(next, operation.toTrackId);
    const clipId = readString(operation.clipId);
    const clip = fromTrack?.clips.find((entry) => entry.id === clipId);
    const startMs = readFinite(operation.startMs, Number.NaN);
    if (!fromTrack || !toTrack || !clip) {
      return failure(next, `Video clip not found: ${clipId}`, 'video-clip-not-found');
    }
    if (fromTrack.locked || toTrack.locked || clip.locked) {
      return failure(next, `Video clip or track is locked: ${clipId}`, 'video-clip-locked');
    }
    if (!Number.isFinite(startMs) || startMs < 0 || !clipAllowedOnTrack(clip.kind, toTrack.kind)) {
      return failure(next, 'Video clip move is invalid.', 'invalid-video-clip-move');
    }
    fromTrack.clips = fromTrack.clips.filter((entry) => entry.id !== clipId);
    clip.startMs = startMs;
    const index = operation.index === undefined
      ? toTrack.clips.length
      : clampInteger(readInteger(operation.index), 0, toTrack.clips.length);
    toTrack.clips.splice(index, 0, clip);
    sortClips(toTrack);
    next.durationMs = Math.max(next.durationMs, clipEnd(clip));
    return success(next, `${clip.name} moved.`);
  }
  case 'video.clip.split': {
    const track = findTrack(next, operation.trackId);
    const clipId = readString(operation.clipId);
    const clipIndex = track?.clips.findIndex((entry) => entry.id === clipId) ?? -1;
    const clip = clipIndex >= 0 ? track?.clips[clipIndex] : undefined;
    const atMs = readFinite(operation.atMs, Number.NaN);
    if (!track || !clip) {
      return failure(next, `Video clip not found: ${clipId}`, 'video-clip-not-found');
    }
    if (track.locked || clip.locked) {
      return failure(next, `Video clip is locked: ${clip.id}`, 'video-clip-locked');
    }
    const leftDuration = atMs - clip.startMs;
    const rightDuration = clip.durationMs - leftDuration;
    if (!Number.isFinite(atMs) || leftDuration < 40 || rightDuration < 40) {
      return failure(next, 'Split point must leave at least 40 ms on both sides.', 'invalid-video-split');
    }
    const left = cloneJson(clip);
    left.durationMs = leftDuration;
    left.fadeOutMs = Math.min(left.fadeOutMs, leftDuration);
    const right = cloneJson(clip);
    right.id = randomUUID();
    right.name = `${clip.name} part 2`;
    right.startMs = atMs;
    right.durationMs = rightDuration;
    right.sourceOffsetMs += leftDuration * clip.playbackRate;
    right.fadeInMs = Math.min(right.fadeInMs, rightDuration);
    track.clips.splice(clipIndex, 1, left, right);
    next.selectedClipIds = [right.id];
    return success(next, `${clip.name} split at ${Math.round(atMs)} ms.`);
  }
  case 'video.selection.set': {
    if (!Array.isArray(operation.clipIds)) {
      return failure(next, 'Video selection must be an array of clip ids.', 'invalid-video-selection');
    }
    const ids = unique(operation.clipIds.map(readString).filter(Boolean));
    if (ids.some((id) => !findClip(next, id))) {
      return failure(next, 'Video selection contains an unknown clip.', 'video-selection-not-found');
    }
    next.selectedClipIds = ids;
    return success(next, `${ids.length} video clips selected.`);
  }
  default:
    return failure(next, `Unsupported video operation: ${operation.type}`, 'unsupported-video-operation');
  }
}

export function validateVideoTimeline(value: unknown): StudioVideoValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['video timeline must be an object'], warnings };
  }
  if (!validDuration(Number(value.durationMs))) {
    errors.push('video duration must be 1 ms to 24 hours');
  }
  const fps = Number(value.fps);
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) {
    errors.push('video fps must be an integer from 1 to 120');
  }
  const playheadMs = Number(value.playheadMs);
  if (!Number.isFinite(playheadMs) || playheadMs < 0 || playheadMs > Number(value.durationMs)) {
    errors.push('video playhead must stay inside the timeline');
  }
  if (!Array.isArray(value.tracks)) {
    errors.push('video tracks must be an array');
    return { ok: false, errors, warnings };
  }

  const tracks = value.tracks.map((track) => normalizeTrack(track, false));
  if (tracks.some((track) => !track)) {
    errors.push('video tracks contain an invalid track');
  }
  const validTracks = tracks.filter((track): track is StudioVideoTrack => Boolean(track));
  const trackIds = validTracks.map((track) => track.id);
  if (new Set(trackIds).size !== trackIds.length) {
    errors.push('video track ids must be unique');
  }
  const clipIds = validTracks.flatMap((track) => track.clips.map((clip) => clip.id));
  if (new Set(clipIds).size !== clipIds.length) {
    errors.push('video clip ids must be unique across tracks');
  }
  if (!Array.isArray(value.selectedClipIds)) {
    errors.push('selectedClipIds must be an array');
  } else {
    const selectedIds = value.selectedClipIds.map(readString).filter(Boolean);
    if (selectedIds.length !== value.selectedClipIds.length) {
      errors.push('selectedClipIds must contain non-empty strings');
    }
    const knownClipIds = new Set(clipIds);
    if (selectedIds.some((id) => !knownClipIds.has(id))) {
      errors.push('selectedClipIds contains an unknown video clip');
    }
  }
  for (const track of validTracks) {
    const ordered = [...track.clips].sort((left, right) => left.startMs - right.startMs);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (clipEnd(previous) > current.startMs) {
        warnings.push(`clips overlap on track ${track.name}: ${previous.name} and ${current.name}`);
      }
    }
  }
  const durationMs = Number(value.durationMs);
  const contentEnd = validTracks.flatMap((track) => track.clips).reduce(
    (maximum, clip) => Math.max(maximum, clipEnd(clip)),
    0
  );
  if (Number.isFinite(durationMs) && contentEnd > durationMs) {
    errors.push(`video content ends at ${contentEnd} ms after timeline duration ${durationMs} ms`);
  }
  return { ok: errors.length === 0, errors: unique(errors), warnings: unique(warnings) };
}

function normalizeTrack(value: unknown, generateIds = true): StudioVideoTrack | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!generateIds && !isStoredTrackValid(value)) {
    return null;
  }
  const kind = normalizeTrackKind(value.kind);
  if (!kind) {
    return null;
  }
  if (!generateIds && !Array.isArray(value.clips)) {
    return null;
  }
  const clipInputs = Array.isArray(value.clips) ? value.clips : [];
  const clips = clipInputs
    .map((clip) => normalizeClip(clip, kind, generateIds))
    .filter((clip): clip is StudioVideoClip => Boolean(clip));
  if (!generateIds && clips.length !== clipInputs.length) {
    return null;
  }
  const requestedId = readString(value.id);
  if (!requestedId && !generateIds) {
    return null;
  }
  return {
    id: requestedId || randomUUID(),
    kind,
    name: (readString(value.name) || defaultTrackName(kind)).slice(0, 80),
    muted: value.muted === true,
    locked: value.locked === true,
    clips,
  };
}

function normalizeClip(
  value: unknown,
  trackKind: StudioVideoTrackKind,
  generateId = true
): StudioVideoClip | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!generateId && !isStoredClipValid(value, trackKind)) {
    return null;
  }
  const kind = normalizeClipKind(value.kind, trackKind, generateId);
  if (!kind || !clipAllowedOnTrack(kind, trackKind)) {
    return null;
  }
  const source = readString(value.source);
  const text = readString(value.text);
  if (kind !== 'text' && !source) {
    return null;
  }
  if (kind === 'text' && !text) {
    return null;
  }
  const durationMs = readFinite(value.durationMs, 3_000);
  if (!validDuration(durationMs)) {
    return null;
  }
  const requestedId = readString(value.id);
  if (!requestedId && !generateId) {
    return null;
  }
  const clip: StudioVideoClip = {
    id: requestedId || randomUUID(),
    kind,
    name: (readString(value.name) || defaultClipName(kind)).slice(0, 80),
    startMs: Math.max(0, readFinite(value.startMs, 0)),
    durationMs,
    sourceOffsetMs: Math.max(0, readFinite(value.sourceOffsetMs, 0)),
    playbackRate: clamp(readFinite(value.playbackRate, 1), 0.25, 4),
    volume: clamp(readFinite(value.volume, 1), 0, 2),
    fadeInMs: clamp(readFinite(value.fadeInMs, 0), 0, durationMs),
    fadeOutMs: clamp(readFinite(value.fadeOutMs, 0), 0, durationMs),
    opacity: clamp(readFinite(value.opacity, 1), 0, 1),
    locked: value.locked === true,
  };
  if (source) {
    clip.source = source;
  }
  if (text) {
    clip.text = text;
  }
  return clip;
}

function isStoredTrackValid(value: Record<string, unknown>): boolean {
  return Boolean(readString(value.id))
    && Boolean(readString(value.name))
    && Boolean(normalizeTrackKind(value.kind))
    && typeof value.muted === 'boolean'
    && typeof value.locked === 'boolean'
    && Array.isArray(value.clips);
}

function isStoredClipValid(
  value: Record<string, unknown>,
  trackKind: StudioVideoTrackKind
): boolean {
  const kind = normalizeClipKind(value.kind, trackKind, false);
  if (
    !kind
    || !clipAllowedOnTrack(kind, trackKind)
    || !readString(value.id)
    || !readString(value.name)
    || typeof value.startMs !== 'number'
    || !Number.isFinite(value.startMs)
    || value.startMs < 0
    || typeof value.durationMs !== 'number'
    || !validDuration(value.durationMs)
    || typeof value.sourceOffsetMs !== 'number'
    || !Number.isFinite(value.sourceOffsetMs)
    || value.sourceOffsetMs < 0
    || typeof value.playbackRate !== 'number'
    || !Number.isFinite(value.playbackRate)
    || value.playbackRate < 0.25
    || value.playbackRate > 4
    || typeof value.volume !== 'number'
    || !Number.isFinite(value.volume)
    || value.volume < 0
    || value.volume > 2
    || typeof value.fadeInMs !== 'number'
    || !Number.isFinite(value.fadeInMs)
    || value.fadeInMs < 0
    || value.fadeInMs > value.durationMs
    || typeof value.fadeOutMs !== 'number'
    || !Number.isFinite(value.fadeOutMs)
    || value.fadeOutMs < 0
    || value.fadeOutMs > value.durationMs
    || typeof value.opacity !== 'number'
    || !Number.isFinite(value.opacity)
    || value.opacity < 0
    || value.opacity > 1
    || typeof value.locked !== 'boolean'
  ) {
    return false;
  }
  return kind === 'text' ? Boolean(readString(value.text)) : Boolean(readString(value.source));
}

function patchClip(
  current: StudioVideoClip,
  patch: unknown,
  trackKind: StudioVideoTrackKind
): StudioVideoClip | null {
  if (!isRecord(patch) || (patch.kind !== undefined && patch.kind !== current.kind)) {
    return null;
  }
  return normalizeClip({
    ...current,
    ...pickDefined(patch, [
      'name', 'source', 'text', 'startMs', 'durationMs', 'sourceOffsetMs', 'playbackRate',
      'volume', 'fadeInMs', 'fadeOutMs', 'opacity', 'locked',
    ]),
  }, trackKind);
}

function normalizeTrackKind(value: unknown): StudioVideoTrackKind | '' {
  return value === 'video' || value === 'audio' || value === 'text' ? value : '';
}

function normalizeClipKind(
  value: unknown,
  trackKind: StudioVideoTrackKind,
  allowDefault = true
): StudioVideoClipKind | '' {
  if (value === 'video' || value === 'audio' || value === 'image' || value === 'text') {
    return value;
  }
  return allowDefault ? trackKind : '';
}

function clipAllowedOnTrack(kind: StudioVideoClipKind, trackKind: StudioVideoTrackKind): boolean {
  if (trackKind === 'audio') {
    return kind === 'audio';
  }
  if (trackKind === 'text') {
    return kind === 'text';
  }
  return kind === 'video' || kind === 'image';
}

function findTrack(timeline: StudioVideoTimeline, trackId: unknown): StudioVideoTrack | undefined {
  const id = readString(trackId);
  return timeline.tracks.find((track) => track.id === id);
}

function findClip(
  timeline: StudioVideoTimeline,
  clipId: string
): { track: StudioVideoTrack; clip: StudioVideoClip } | undefined {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((entry) => entry.id === clipId);
    if (clip) {
      return { track, clip };
    }
  }
  return undefined;
}

function timelineContentEnd(timeline: StudioVideoTimeline): number {
  return timeline.tracks.flatMap((track) => track.clips).reduce(
    (maximum, clip) => Math.max(maximum, clipEnd(clip)),
    0
  );
}

function clipEnd(clip: StudioVideoClip): number {
  return clip.startMs + clip.durationMs;
}

function sortClips(track: StudioVideoTrack): void {
  track.clips.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
}

function success(
  timeline: StudioVideoTimeline,
  summary: string
): StudioVideoOperationResult {
  const validation = validateVideoTimeline(timeline);
  if (!validation.ok) {
    return failure(
      timeline,
      `Video operation would create an invalid timeline: ${validation.errors.join('; ')}`,
      'invalid-video-operation-result'
    );
  }
  return {
    ok: true,
    timeline,
    summary,
    warnings: validation.warnings,
  };
}

function failure(
  timeline: StudioVideoTimeline,
  summary: string,
  error: string
): StudioVideoOperationResult {
  return { ok: false, timeline, summary, error };
}

function defaultTrackName(kind: StudioVideoTrackKind): string {
  switch (kind) {
  case 'video': return 'Video';
  case 'audio': return 'Audio';
  case 'text': return 'Text';
  }
}

function defaultClipName(kind: StudioVideoClipKind): string {
  switch (kind) {
  case 'video': return 'Video clip';
  case 'audio': return 'Audio clip';
  case 'image': return 'Image';
  case 'text': return 'Text';
  }
}

function validDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 1 && value <= 86_400_000;
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

function clampInteger(value: number, min: number, max: number): number {
  return Math.round(clamp(Number.isFinite(value) ? value : min, min, max));
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
