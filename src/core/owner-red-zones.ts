import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expandPathTokens, immutableMonarchSafeRoots } from './filesystem-policy';
import { uniqueStrings } from './utils';
import { renameWithWindowsRetrySync } from './durable-json';

export const OWNER_RED_ZONE_SCHEMA = 'monarch.owner-red-zones.v1' as const;
export const MAX_OWNER_RED_ZONES = 32;

export interface OwnerRedZone {
  id: string;
  path: string;
  label: string;
  addedAt: string;
}

interface StoredOwnerRedZones {
  schemaVersion: typeof OWNER_RED_ZONE_SCHEMA;
  revision: number;
  zones: OwnerRedZone[];
}

export class OwnerRedZoneError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OwnerRedZoneError';
  }
}

export class OwnerRedZoneStore {
  private readonly filePath: string;
  private state: StoredOwnerRedZones;

  constructor(stateRoot: string) {
    this.filePath = path.join(path.resolve(stateRoot), 'settings', 'owner-red-zones.v1.json');
    this.state = this.readState();
  }

  list(): OwnerRedZone[] {
    return this.state.zones.map((zone) => ({ ...zone }));
  }

  paths(): string[] {
    return this.state.zones.map((zone) => zone.path);
  }

  add(rawPath: string, now = new Date()): OwnerRedZone {
    const resolved = normalizeOwnerRedZonePath(rawPath);
    const existing = this.state.zones.find((zone) => sameZonePath(zone.path, resolved));
    if (existing) return { ...existing };
    if (this.state.zones.length >= MAX_OWNER_RED_ZONES) {
      throw new OwnerRedZoneError('limit', 'Можно закрыть не больше 32 папок.');
    }
    const next: OwnerRedZone = {
      id: zoneIdForPath(resolved),
      path: resolved,
      label: zoneLabel(resolved),
      addedAt: now.toISOString(),
    };
    const zones = this.state.zones
      .filter((zone) => !isPathInside(zone.path, resolved))
      .concat(next);
    this.writeState({ ...this.state, revision: this.state.revision + 1, zones });
    return { ...next };
  }

  remove(id: string): OwnerRedZone | null {
    const index = this.state.zones.findIndex((zone) => zone.id === id);
    if (index < 0) return null;
    const [removed] = this.state.zones.splice(index, 1);
    this.writeState({ ...this.state, revision: this.state.revision + 1, zones: [...this.state.zones] });
    return removed ? { ...removed } : null;
  }

  private readState(): StoredOwnerRedZones {
    if (!existsSync(this.filePath)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredOwnerRedZones;
      if (parsed?.schemaVersion !== OWNER_RED_ZONE_SCHEMA || !Array.isArray(parsed.zones)) return emptyState();
      return {
        schemaVersion: OWNER_RED_ZONE_SCHEMA,
        revision: Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
        zones: parsed.zones.map(normalizeStoredZone).filter((zone): zone is OwnerRedZone => Boolean(zone)),
      };
    } catch {
      return emptyState();
    }
  }

  private writeState(next: StoredOwnerRedZones): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
    renameWithWindowsRetrySync(temp, this.filePath);
    this.state = next;
  }
}

export function normalizeOwnerRedZonePath(rawPath: string): string {
  const resolved = expandPathTokens(String(rawPath || '').trim());
  if (!resolved || !path.isAbsolute(resolved) || resolved.includes('\0') || resolved.length > 1024) {
    throw new OwnerRedZoneError('invalid-path', 'Нужен точный путь к папке.');
  }
  const safeRoots = immutableMonarchSafeRoots(resolved);
  if (safeRoots.some((root) => sameZonePath(resolved, root) || isPathInside(resolved, root))) {
    throw new OwnerRedZoneError('protected', 'Safe закрыт всегда и не настраивается.');
  }
  return path.resolve(resolved);
}

function normalizeStoredZone(value: unknown): OwnerRedZone | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  try {
    const resolved = normalizeOwnerRedZonePath(String(record.path || ''));
    const id = typeof record.id === 'string' && record.id.startsWith('red_zone_') ? record.id : zoneIdForPath(resolved);
    const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim().slice(0, 80) : zoneLabel(resolved);
    const addedAt = typeof record.addedAt === 'string' && record.addedAt ? record.addedAt : new Date(0).toISOString();
    return { id, path: resolved, label, addedAt };
  } catch {
    return null;
  }
}

function zoneIdForPath(resolved: string): string {
  return 'red_zone_' + createHash('sha256').update(resolved.toLocaleLowerCase('en-US')).digest('hex').slice(0, 12);
}

function zoneLabel(resolved: string): string {
  const base = path.basename(resolved.replace(/[\\/]+$/u, '')) || resolved;
  return base.slice(0, 80);
}

function emptyState(): StoredOwnerRedZones {
  return { schemaVersion: OWNER_RED_ZONE_SCHEMA, revision: 0, zones: [] };
}

function sameZonePath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/u, '').toLocaleLowerCase('en-US')
    === path.resolve(right).replace(/[\\/]+$/u, '').toLocaleLowerCase('en-US');
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function mergeOwnerRedZoneRoots(existing: readonly string[] | undefined, ownerRoots: readonly string[] | undefined): string[] {
  return uniqueStrings([...(existing || []), ...(ownerRoots || [])]);
}
