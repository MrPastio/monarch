import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uniqueStrings } from './utils';

export type MonarchFilesystemOperation =
  | 'read'
  | 'list'
  | 'search'
  | 'write'
  | 'append'
  | 'create'
  | 'mkdir'
  | 'delete'
  | 'move'
  | 'rename';

export type MonarchFilesystemAccessReason =
  | 'allowed'
  | 'empty-path'
  | 'invalid-path'
  | 'outside-root'
  | 'drive-root-blocked'
  | 'workspace-root-delete-blocked'
  | 'read-only-zone-write-blocked'
  | 'read-only-zone-delete-blocked'
  | 'red-zone-read-blocked'
  | 'red-zone-write-blocked'
  | 'red-zone-delete-blocked';

export interface MonarchFilesystemPolicyOptions {
  workspaceRoot?: string;
  sandboxRoot?: string;
  allowedRoots?: string[];
  allowFullDiskAccess?: boolean;
  redZoneRoots?: string[];
  readOnlyRoots?: string[];
  createDirectoryRoots?: string[];
  blockRedZoneRead?: boolean;
  blockRedZoneWrite?: boolean;
  blockRedZoneDelete?: boolean;
  protectWorkspaceInternals?: boolean;
  /** Internal Owner path: keep immutable Safe roots but omit ordinary software red zones. */
  includeDefaultRedZones?: boolean;
}

export interface MonarchFilesystemPolicy {
  workspaceRoot: string;
  sandboxRoot: string;
  allowedRoots: string[];
  allowFullDiskAccess: boolean;
  redZoneRoots: string[];
  readOnlyRoots: string[];
  createDirectoryRoots: string[];
  blockRedZoneRead: boolean;
  blockRedZoneWrite: boolean;
  blockRedZoneDelete: boolean;
}

export interface MonarchFilesystemAccessResult {
  allowed: boolean;
  reason: MonarchFilesystemAccessReason;
  operation: MonarchFilesystemOperation;
  originalPath: string;
  resolvedPath: string;
  fallbackRoot: string;
  message: string;
  policy: MonarchFilesystemPolicy;
  redZoneRoots: string[];
}

export type MonarchKnownUserFolder = 'desktop' | 'downloads';

const windowsKnownFolderCache = new Map<MonarchKnownUserFolder, string[]>();

export function createFilesystemPolicy(
  options: MonarchFilesystemPolicyOptions = {}
): MonarchFilesystemPolicy {
  const workspaceRoot = expandPathTokens(options.workspaceRoot || process.cwd(), process.cwd());
  const sandboxRoot = expandPathTokens(
    options.sandboxRoot || process.env.MONARCH_WORKSPACE_ROOT || workspaceRoot,
    workspaceRoot
  );
  const allowFullDiskAccess = options.allowFullDiskAccess
    || /^(1|true|yes)$/i.test(String(process.env.MONARCH_ALLOW_FULL_DISK || ''));
  const allowedRoots = allowFullDiskAccess
    ? []
    : normalizeRoots(options.allowedRoots && options.allowedRoots.length > 0
      ? options.allowedRoots
      : [sandboxRoot], workspaceRoot);
  const redZoneRoots = uniqueStrings([
    ...immutableMonarchSafeRoots(workspaceRoot),
    ...(options.includeDefaultRedZones === false
      ? []
      : defaultRedZoneRoots(workspaceRoot, options.protectWorkspaceInternals !== false)),
    ...normalizeRoots(options.redZoneRoots || [], workspaceRoot),
  ]);
  const readOnlyRoots = uniqueStrings([
    ...defaultReadOnlyRoots(workspaceRoot, options.protectWorkspaceInternals !== false),
    ...normalizeRoots(options.readOnlyRoots || [], workspaceRoot),
  ]);
  const createDirectoryRoots = normalizeRoots(options.createDirectoryRoots || [], workspaceRoot);

  return {
    workspaceRoot,
    sandboxRoot,
    allowedRoots,
    allowFullDiskAccess,
    redZoneRoots,
    readOnlyRoots,
    createDirectoryRoots,
    blockRedZoneRead: options.blockRedZoneRead !== false,
    blockRedZoneWrite: options.blockRedZoneWrite !== false,
    blockRedZoneDelete: options.blockRedZoneDelete !== false,
  };
}

export function evaluateFilesystemAccess(
  rawPath: unknown,
  operation: MonarchFilesystemOperation,
  options: MonarchFilesystemPolicyOptions & { fallbackRoot?: string; allowRoot?: boolean } = {}
): MonarchFilesystemAccessResult {
  const policy = createFilesystemPolicy(options);
  const fallbackRoot = expandPathTokens(options.fallbackRoot || policy.sandboxRoot, policy.workspaceRoot);
  const originalPath = typeof rawPath === 'string' || Buffer.isBuffer(rawPath)
    ? String(rawPath)
    : '';
  const allowRoot = options.allowRoot !== false;

  if (rawPath === undefined || rawPath === null || !originalPath.trim()) {
    return buildAccessResult(false, 'empty-path', operation, originalPath, '', fallbackRoot, policy);
  }

  if (typeof rawPath !== 'string' && !Buffer.isBuffer(rawPath)) {
    return buildAccessResult(false, 'invalid-path', operation, originalPath, '', fallbackRoot, policy);
  }

  if (originalPath.includes('\0')) {
    return buildAccessResult(false, 'invalid-path', operation, originalPath, '', fallbackRoot, policy);
  }

  const resolvedPath = expandPathTokens(originalPath, fallbackRoot);
  if (!resolvedPath) {
    return buildAccessResult(false, 'invalid-path', operation, originalPath, '', fallbackRoot, policy);
  }

  if ((isWriteLike(operation) || isDeleteLike(operation)) && isFilesystemRoot(resolvedPath)) {
    return buildAccessResult(false, 'drive-root-blocked', operation, originalPath, resolvedPath, fallbackRoot, policy);
  }

  if (isDeleteLike(operation) && samePath(resolvedPath, policy.workspaceRoot)) {
    return buildAccessResult(false, 'workspace-root-delete-blocked', operation, originalPath, resolvedPath, fallbackRoot, policy);
  }

  if (!policy.allowFullDiskAccess && !isPathWithinAnyRoot(resolvedPath, policy.allowedRoots, { allowRoot })) {
    return buildAccessResult(false, 'outside-root', operation, originalPath, resolvedPath, fallbackRoot, policy);
  }

  const matchingRedZones = policy.redZoneRoots.filter((root) => isPathWithinRoot(resolvedPath, root, { allowRoot: true }));
  const matchingReadOnlyRoots = policy.readOnlyRoots.filter((root) => isPathWithinRoot(resolvedPath, root, { allowRoot: true }));
  if (!policy.allowFullDiskAccess && matchingReadOnlyRoots.length > 0) {
    if (isDeleteLike(operation)) {
      return buildAccessResult(false, 'read-only-zone-delete-blocked', operation, originalPath, resolvedPath, fallbackRoot, policy, matchingReadOnlyRoots);
    }
    if (isWriteLike(operation)) {
      const canCreateDirectory = operation === 'mkdir'
        && isPathWithinAnyRoot(resolvedPath, policy.createDirectoryRoots, { allowRoot: false });
      if (!canCreateDirectory) {
        return buildAccessResult(false, 'read-only-zone-write-blocked', operation, originalPath, resolvedPath, fallbackRoot, policy, matchingReadOnlyRoots);
      }
    }
  }
  if (matchingRedZones.length > 0) {
    if (isDeleteLike(operation) && policy.blockRedZoneDelete) {
      return buildAccessResult(false, 'red-zone-delete-blocked', operation, originalPath, resolvedPath, fallbackRoot, policy, matchingRedZones);
    }
    if (isWriteLike(operation) && policy.blockRedZoneWrite) {
      return buildAccessResult(false, 'red-zone-write-blocked', operation, originalPath, resolvedPath, fallbackRoot, policy, matchingRedZones);
    }
    if (isReadLike(operation) && policy.blockRedZoneRead) {
      return buildAccessResult(false, 'red-zone-read-blocked', operation, originalPath, resolvedPath, fallbackRoot, policy, matchingRedZones);
    }
  }

  return buildAccessResult(true, 'allowed', operation, originalPath, resolvedPath, fallbackRoot, policy, matchingRedZones);
}

/** True for `D:\\` / `/`, not for a file that merely lives on that root. */
export function isFilesystemRoot(targetPath: string): boolean {
  const resolved = expandPathTokens(targetPath);
  if (!resolved) return false;
  const root = path.parse(resolved).root;
  return Boolean(root) && samePath(resolved, root);
}

/**
 * Create missing parents of a file path. Never mkdir a drive root: on Windows
 * mkdir of `D:\\` throws EPERM even though the volume already exists.
 * If mkdir fails but the parent is already a directory, continue.
 */
export async function ensureWritableParentDirectory(filePath: string): Promise<void> {
  const resolved = expandPathTokens(filePath);
  if (!resolved) return;
  const parent = path.dirname(resolved);
  if (!parent || isFilesystemRoot(parent)) return;
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    const existing = await stat(parent).catch(() => undefined);
    if (existing?.isDirectory()) return;
    throw error;
  }
}

/** Bare drive destination from user text (`D:`, `диск E`), not an ordinary `D:\\folder\\file` path. */
export function extractDriveRoot(text: string): string {
  const value = String(text || '');
  const explicit = value.match(/(?:^|\s)([A-Za-z]):[\\/]?(?:\s|$)/u)?.[1]
    || value.match(/(?:drive|диск(?:е|а|у|ом)?)\s+([A-Za-z])\b/iu)?.[1];
  return explicit ? `${explicit.toUpperCase()}:\\` : '';
}

export function expandPathTokens(rawPath: string, fallbackRoot = process.cwd()): string {
  let candidate = String(rawPath || '').trim();
  if (!candidate) {
    return '';
  }

  candidate = candidate.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] || '');
  if (candidate.startsWith('~')) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (home) {
      candidate = path.join(home, candidate.slice(1));
    }
  }

  try {
    return path.resolve(path.isAbsolute(candidate) ? candidate : path.join(fallbackRoot, candidate));
  } catch {
    return '';
  }
}

export function defaultLocalReadOnlyRoots(): string[] {
  const configuredRoots = String(process.env.MONARCH_LOCAL_READ_ROOTS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const userRoots = [
    ...knownUserFolderCandidates('desktop'),
    ...knownUserFolderCandidates('downloads'),
  ];
  return normalizeRoots([...userRoots, ...configuredRoots], process.cwd());
}

/**
 * Safe is not a tunable red zone. It is projected on every Windows drive so
 * Full Access and hidden Owner overrides cannot remove it from filesystem policy.
 */
export function immutableMonarchSafeRoots(workspaceRoot = process.cwd()): string[] {
  const configured = String(process.env.MONARCH_SAFE_ROOT || '').trim();
  const workspaceDrive = path.parse(workspaceRoot).root || systemDriveRoot();
  const driveRoots = process.platform === 'win32'
    ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`)
    : [workspaceDrive];
  return normalizeRoots([
    configured,
    ...driveRoots.map((root) => path.join(root, 'MonarchData', 'Safe')),
  ].filter(Boolean), workspaceRoot);
}

export function resolveKnownUserFolder(kind: MonarchKnownUserFolder): string {
  const candidates = knownUserFolderCandidates(kind);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || '';
}

export function knownUserFolderCandidates(kind: MonarchKnownUserFolder): string[] {
  const folderName = kind === 'desktop' ? 'Desktop' : 'Downloads';
  const override = process.env[kind === 'desktop' ? 'MONARCH_DESKTOP_DIR' : 'MONARCH_DOWNLOADS_DIR'] || '';
  const userProfile = process.env.USERPROFILE || '';
  const home = process.env.HOME || '';
  const xdg = process.env[kind === 'desktop' ? 'XDG_DESKTOP_DIR' : 'XDG_DOWNLOAD_DIR'] || '';
  const cloudRoots = [
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial,
    userProfile ? path.join(userProfile, 'OneDrive') : '',
  ].filter(Boolean) as string[];
  const cloudCandidates = cloudRoots.flatMap((root) => [path.join(root, folderName)]);
  const homeCandidates = uniqueStrings([userProfile, home].filter(Boolean)).map((root) => path.join(root, folderName));
  return normalizeRoots([
    override,
    ...windowsKnownUserFolderCandidates(kind),
    xdg,
    ...cloudCandidates,
    ...homeCandidates,
  ].filter(Boolean), process.cwd());
}

export function isPathWithinRoot(
  targetPath: string,
  rootPath: string,
  options: { allowRoot?: boolean } = {}
): boolean {
  const target = expandPathTokens(targetPath);
  const root = expandPathTokens(rootPath);
  if (!target || !root) {
    return false;
  }

  if (samePath(target, root)) {
    return options.allowRoot !== false;
  }

  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function isPathWithinAnyRoot(
  targetPath: string,
  roots: string[],
  options: { allowRoot?: boolean } = {}
): boolean {
  return roots.some((root) => isPathWithinRoot(targetPath, root, options));
}

function buildAccessResult(
  allowed: boolean,
  reason: MonarchFilesystemAccessReason,
  operation: MonarchFilesystemOperation,
  originalPath: string,
  resolvedPath: string,
  fallbackRoot: string,
  policy: MonarchFilesystemPolicy,
  redZoneRoots: string[] = []
): MonarchFilesystemAccessResult {
  return {
    allowed,
    reason,
    operation,
    originalPath,
    resolvedPath,
    fallbackRoot,
    message: accessMessage(reason, policy),
    policy,
    redZoneRoots,
  };
}

function accessMessage(
  reason: MonarchFilesystemAccessReason,
  policy: MonarchFilesystemPolicy
): string {
  switch (reason) {
  case 'allowed':
    return 'Filesystem access allowed by Monarch policy.';
  case 'empty-path':
    return 'Path is empty.';
  case 'invalid-path':
    return 'Path cannot be normalized safely.';
  case 'outside-root':
    return `Path is outside allowed roots: ${policy.allowedRoots.join(', ') || policy.sandboxRoot}.`;
  case 'drive-root-blocked':
    return 'Write/delete operations against a drive root are blocked.';
  case 'workspace-root-delete-blocked':
    return 'Delete operations against the Monarch workspace root are blocked.';
  case 'read-only-zone-write-blocked':
    return 'Write operation is blocked inside a protected read-only path.';
  case 'read-only-zone-delete-blocked':
    return 'Delete operation is blocked inside a protected read-only path.';
  case 'red-zone-read-blocked':
    return 'Read operation is blocked inside a protected red-zone path.';
  case 'red-zone-write-blocked':
    return 'Write operation is blocked inside a protected red-zone path.';
  case 'red-zone-delete-blocked':
    return 'Delete operation is blocked inside a protected red-zone path.';
  }
}

function normalizeRoots(roots: string[], fallbackRoot: string): string[] {
  return uniqueStrings(roots.map((root) => expandPathTokens(root, fallbackRoot)).filter(Boolean));
}

function windowsKnownUserFolderCandidates(kind: MonarchKnownUserFolder): string[] {
  if (process.platform !== 'win32') return [];
  const cached = windowsKnownFolderCache.get(kind);
  if (cached) return cached;
  // One read per process for both folders. This sits on the policy path of the
  // agent runtime, so it must stay cheap: a synchronous PowerShell start per
  // folder (1-3 s, often past its own timeout, which then cached nothing)
  // froze the event loop long enough to fail model tokenizer deadlines.
  const keys = WINDOWS_SHELL_FOLDER_KEYS.map(readWindowsRegistryKey);
  for (const folder of ['desktop', 'downloads'] as const) {
    windowsKnownFolderCache.set(folder, uniqueStrings(keys.flatMap((values) => WINDOWS_SHELL_FOLDER_NAMES[folder]
      .map((name) => (values.get(name.toLowerCase()) ?? '').trim())
      .filter(Boolean)
      .map(expandWindowsEnvironment))));
  }
  return windowsKnownFolderCache.get(kind) ?? [];
}

const WINDOWS_SHELL_FOLDER_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
];
const WINDOWS_SHELL_FOLDER_NAMES: Record<MonarchKnownUserFolder, string[]> = {
  desktop: ['Desktop', '{754AC886-DF64-4CBA-86B5-F7FBF4FBCEF5}'],
  downloads: ['Downloads', '{374DE290-123F-4565-9164-39C4925E467B}'],
};

/** Values of one registry key, names lower-cased. `reg export` writes UTF-16LE
 * whatever the console code page is, so non-ASCII folder paths survive; plain
 * `reg query` output is OEM-encoded and locale dependent. */
function readWindowsRegistryKey(key: string): Map<string, string> {
  const values = new Map<string, string>();
  const file = path.join(os.tmpdir(), `monarch-shell-folders-${process.pid}-${randomUUID()}.reg`);
  try {
    execFileSync('reg.exe', ['export', key, file, '/y'], { stdio: 'ignore', timeout: 3000, windowsHide: true });
    return parseWindowsRegistryExport(readFileSync(file).toString('utf16le'));
  } catch {
    return values; // Missing key or reg.exe: environment-derived candidates still apply.
  } finally {
    rmSync(file, { force: true });
  }
}

export function parseWindowsRegistryExport(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const joined = text.replace(/^﻿/u, '').replace(/\\\r?\n\s*/gu, '');
  for (const line of joined.split(/\r?\n/u)) {
    const match = /^"((?:[^"\\]|\\.)*)"=(.*)$/u.exec(line.trim());
    if (!match) continue;
    const name = match[1]!.replace(/\\(.)/gu, '$1').toLowerCase();
    const raw = match[2]!;
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      values.set(name, raw.slice(1, -1).replace(/\\(.)/gu, '$1'));
    } else if (raw.startsWith('hex(2):')) {
      const bytes = raw.slice('hex(2):'.length).split(',').map((pair) => pair.trim()).filter(Boolean);
      if (bytes.length % 2 === 0 && bytes.every((pair) => /^[0-9a-f]{2}$/iu.test(pair))) {
        values.set(name, Buffer.from(bytes.map((pair) => Number.parseInt(pair, 16))).toString('utf16le').replace(/\0+$/u, ''));
      }
    }
  }
  return values;
}

function expandWindowsEnvironment(value: string): string {
  return value.replace(/%([^%]+)%/gu, (whole, name: string) => {
    const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : process.env[key] ?? whole;
  });
}

function defaultRedZoneRoots(workspaceRoot: string, protectWorkspaceInternals: boolean): string[] {
  const systemRoot = process.env.SystemRoot || path.join(systemDriveRoot(), 'Windows');
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const roots = [
    systemRoot,
    process.env.ProgramFiles || path.join(systemDriveRoot(), 'Program Files'),
    process.env['ProgramFiles(x86)'] || path.join(systemDriveRoot(), 'Program Files (x86)'),
    process.env.ProgramData || path.join(systemDriveRoot(), 'ProgramData'),
    path.join(systemDriveRoot(), 'Boot'),
    path.join(systemDriveRoot(), 'Recovery'),
    path.join(systemDriveRoot(), 'EFI'),
    path.join(systemDriveRoot(), '$Recycle.Bin'),
    path.join(systemDriveRoot(), 'System Volume Information'),
  ];

  if (userProfile) {
    roots.push(
      path.join(userProfile, '.ssh'),
      path.join(userProfile, '.gnupg'),
      path.join(userProfile, '.aws'),
      path.join(userProfile, '.azure'),
      path.join(userProfile, '.kube'),
      path.join(userProfile, '.docker')
    );
  }
  if (appData) {
    roots.push(
      path.join(appData, 'Microsoft', 'Credentials'),
      path.join(appData, 'Microsoft', 'Protect')
    );
  }
  if (localAppData) {
    roots.push(path.join(localAppData, 'Microsoft', 'Credentials'));
  }
  if (protectWorkspaceInternals) {
    roots.push(
      path.join(workspaceRoot, '.env'),
      path.join(workspaceRoot, '.env.local'),
      path.join(workspaceRoot, '.npmrc'),
      path.join(workspaceRoot, 'secrets'),
      path.join(workspaceRoot, 'runtime', 'secrets'),
      path.join(workspaceRoot, 'runtime', 'tokens'),
      path.join(workspaceRoot, 'runtime', 'credentials'),
      path.join(workspaceRoot, 'runtime', 'agent'),
      path.join(workspaceRoot, 'security', 'secrets'),
      path.join(workspaceRoot, 'security', 'keys'),
      path.join(workspaceRoot, 'security', 'data'),
      path.join(workspaceRoot, 'oscar', '.env'),
      path.join(workspaceRoot, 'oscar', 'data', 'tokens'),
      path.join(workspaceRoot, 'oscar', 'data', 'credentials')
    );
  }

  return normalizeRoots(roots, workspaceRoot);
}

function defaultReadOnlyRoots(workspaceRoot: string, protectWorkspaceInternals: boolean): string[] {
  if (!protectWorkspaceInternals) return [];
  return normalizeRoots([
    path.join(workspaceRoot, '.git'),
    path.join(workspaceRoot, '.agents'),
    path.join(workspaceRoot, '.codex'),
    path.join(workspaceRoot, '.claude'),
    path.join(workspaceRoot, '.monarch'),
    path.join(workspaceRoot, 'LLM models'),
  ], workspaceRoot);
}

function systemDriveRoot(): string {
  const systemRoot = process.env.SystemRoot || '';
  if (systemRoot) {
    return path.parse(systemRoot).root;
  }
  const systemDrive = process.env.SystemDrive || 'C:';
  return systemDrive.endsWith(path.sep) ? systemDrive : `${systemDrive}${path.sep}`;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isReadLike(operation: MonarchFilesystemOperation): boolean {
  return operation === 'read' || operation === 'list' || operation === 'search';
}

function isWriteLike(operation: MonarchFilesystemOperation): boolean {
  return operation === 'write'
    || operation === 'append'
    || operation === 'create'
    || operation === 'mkdir'
    || operation === 'move'
    || operation === 'rename';
}

function isDeleteLike(operation: MonarchFilesystemOperation): boolean {
  return operation === 'delete';
}
