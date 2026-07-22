import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
    ...defaultRedZoneRoots(workspaceRoot, options.protectWorkspaceInternals !== false),
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

  const driveRoot = path.parse(resolvedPath).root;
  if ((isWriteLike(operation) || isDeleteLike(operation)) && samePath(resolvedPath, driveRoot)) {
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
  const valueNames = kind === 'desktop'
    ? ['Desktop', '{754AC886-DF64-4CBA-86B5-F7FBF4FBCEF5}']
    : ['Downloads', '{374DE290-123F-4565-9164-39C4925E467B}'];
  const psArray = valueNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders')",
    `$names = @(${psArray})`,
    'foreach ($key in $keys) {',
    '  $props = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue',
    '  if ($null -eq $props) { continue }',
    '  foreach ($name in $names) {',
    '    $prop = $props.PSObject.Properties[$name]',
    '    if ($null -ne $prop -and [string]::IsNullOrWhiteSpace([string]$prop.Value) -eq $false) {',
    '      [Environment]::ExpandEnvironmentVariables([string]$prop.Value)',
    '    }',
    '  }',
    '}',
  ].join('; ');

  try {
    const candidates = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
      windowsHide: true,
    }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    windowsKnownFolderCache.set(kind, candidates);
    return candidates;
  } catch {
    windowsKnownFolderCache.set(kind, []);
    return [];
  }
}

function defaultRedZoneRoots(workspaceRoot: string, protectWorkspaceInternals: boolean): string[] {
  const systemRoot = process.env.SystemRoot || path.join(systemDriveRoot(), 'Windows');
  const workspaceDriveRoot = path.parse(workspaceRoot).root || systemDriveRoot();
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const roots = [
    path.join(workspaceDriveRoot, 'MonarchData', 'Safe'),
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
