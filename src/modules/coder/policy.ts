import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { expandPathTokens, isPathWithinRoot, type MonarchFilesystemOperation } from '../../core';

export type CoderPathPolicyReason =
  | 'allowed'
  | 'invalid-path'
  | 'drive-root-blocked'
  | 'system-path-blocked'
  | 'credential-path-blocked'
  | 'monarch-system-path-blocked';

export interface CoderPathPolicyResult {
  allowed: boolean;
  reason: CoderPathPolicyReason;
  originalPath: string;
  resolvedPath: string;
  operation: MonarchFilesystemOperation;
  message: string;
}

export interface CoderPolicyOptions {
  monarchRoot: string;
  workspaceCoderRoot?: string;
}

const DANGEROUS_EXECUTABLES = new Set([
  'bcdedit',
  'bootcfg',
  'cipher',
  'diskpart',
  'diskshadow',
  'format',
  'manage-bde',
  'mountvol',
  'reagentc',
  'regini',
  'shutdown',
  'takeown',
  'vssadmin',
  'wbadmin',
]);

const CATASTROPHIC_COMMAND_PATTERNS = [
  /(?:^|[\s;&|])(?:rm|rmdir|del|erase|remove-item)\b[^\r\n]*(?:\s-[a-z]*r[a-z]*f|\s\/s\b|\s-recurse\b)/i,
  /(?:^|[\s;&|])(?:format|diskpart|bcdedit|bootcfg|reagentc|vssadmin|wbadmin|manage-bde)\b/i,
  /(?:^|[\s;&|])reg(?:\.exe)?\s+(?:delete|add)\s+(?:HKLM|HKEY_LOCAL_MACHINE|HKCR|HKEY_CLASSES_ROOT)\b/i,
  /(?:set-executionpolicy\s+unrestricted|start-process[^\r\n]*-verb\s+runas|\brunas(?:\.exe)?\b)/i,
  /(?:disableantispyware|win32_shadowcopy|systemrestore|delete\s+shadows|clear-eventlog)/i,
  /(?:curl|wget|invoke-webrequest|invoke-restmethod)\b[^\r\n]*(?:--data|-d\s|--upload-file|-uploadfile|-method\s+(?:post|put|patch))/i,
  /(?:-encodedcommand\b|frombase64string\s*\(|invoke-expression\s+\(|\biex\s*\()/i,
];

export class CoderHostPolicy {
  readonly monarchRoot: string;
  readonly workspaceCoderRoot: string;
  readonly protectedSystemRoots: string[];
  readonly protectedCredentialPaths: string[];

  constructor(options: CoderPolicyOptions) {
    this.monarchRoot = path.resolve(options.monarchRoot);
    this.workspaceCoderRoot = path.resolve(options.workspaceCoderRoot || path.join(this.monarchRoot, 'Workspace Coder'));
    this.protectedSystemRoots = systemProtectedRoots();
    this.protectedCredentialPaths = credentialProtectedPaths();
  }

  async evaluatePath(
    rawPath: unknown,
    operation: MonarchFilesystemOperation,
    fallbackRoot: string,
  ): Promise<CoderPathPolicyResult> {
    const originalPath = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!originalPath || originalPath.includes('\0')) {
      return this.result(false, 'invalid-path', originalPath, '', operation);
    }
    const resolvedPath = expandPathTokens(originalPath, fallbackRoot);
    if (!resolvedPath) {
      return this.result(false, 'invalid-path', originalPath, '', operation);
    }
    const canonicalPath = await resolveExistingPath(resolvedPath);
    const driveRoot = path.parse(canonicalPath).root;
    if (isMutation(operation) && samePath(canonicalPath, driveRoot)) {
      return this.result(false, 'drive-root-blocked', originalPath, canonicalPath, operation);
    }
    if (isMutation(operation) && this.protectedSystemRoots.some((root) => isPathWithinRoot(canonicalPath, root, { allowRoot: true }))) {
      return this.result(false, 'system-path-blocked', originalPath, canonicalPath, operation);
    }
    if (this.protectedCredentialPaths.some((root) => isPathWithinRoot(canonicalPath, root, { allowRoot: true }))) {
      return this.result(false, 'credential-path-blocked', originalPath, canonicalPath, operation);
    }
    if (
      isPathWithinRoot(canonicalPath, this.monarchRoot, { allowRoot: true })
      && !isPathWithinRoot(canonicalPath, this.workspaceCoderRoot, { allowRoot: true })
    ) {
      return this.result(false, 'monarch-system-path-blocked', originalPath, canonicalPath, operation);
    }
    return this.result(true, 'allowed', originalPath, canonicalPath, operation);
  }

  assertProjectRoot(candidate: string): string {
    const resolved = path.resolve(candidate);
    if (samePath(resolved, path.parse(resolved).root)) {
      throw new Error('A drive root cannot be used as a Coder project.');
    }
    if (this.protectedSystemRoots.some((root) => isPathWithinRoot(resolved, root, { allowRoot: true }))) {
      throw new Error('System folders cannot be registered as Coder projects.');
    }
    if (
      isPathWithinRoot(resolved, this.monarchRoot, { allowRoot: true })
      && !isPathWithinRoot(resolved, this.workspaceCoderRoot, { allowRoot: true })
    ) {
      throw new Error('Monarch system files are immutable in Coder Mode. Use Workspace Coder or another folder.');
    }
    return resolved;
  }

  validateCommand(executable: string, args: string[], cwd: string): void {
    const normalizedExecutable = path.basename(executable).replace(/\.exe$/i, '').toLowerCase();
    if (!normalizedExecutable || DANGEROUS_EXECUTABLES.has(normalizedExecutable)) {
      throw new Error(`Command '${normalizedExecutable || executable}' is blocked because it can damage the host.`);
    }
    if (args.length > 96 || args.some((arg) => arg.length > 8_192)) {
      throw new Error('Command arguments exceed Coder Mode bounds.');
    }
    const commandText = [normalizedExecutable, ...args].join(' ');
    if (CATASTROPHIC_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText))) {
      throw new Error('Command is blocked by the host-protection boundary.');
    }
    if (/\bgh\s+auth\s+token\b|\bgit\s+credential(?:-\w+)?\s+(?:fill|get)\b|\bhf\s+auth\s+login\b[^\r\n]*--token\b/i.test(commandText)) {
      throw new Error('Commands that reveal or inject credentials are blocked; use the installed credential store through normal GitHub or Hugging Face commands.');
    }
    const normalizedCommandText = commandText.replace(/\\\\/g, '\\').replace(/\//g, '\\').toLowerCase();
    const protectedReferences = [...this.protectedSystemRoots, ...this.protectedCredentialPaths]
      .map((root) => path.resolve(root).replace(/\//g, '\\').toLowerCase());
    if (protectedReferences.some((root) => normalizedCommandText.includes(root))) {
      throw new Error('Command arguments reference protected operating-system or credential files.');
    }
    const monarchRoot = this.monarchRoot.replace(/\//g, '\\').toLowerCase();
    const workspaceCoderRoot = this.workspaceCoderRoot.replace(/\//g, '\\').toLowerCase();
    const commandOutsideWorkspace = normalizedCommandText.split(workspaceCoderRoot).join('');
    if (commandOutsideWorkspace.includes(monarchRoot)) {
      throw new Error('Command arguments reference protected Monarch system files.');
    }
    if (/(?:%windir%|%systemroot%|\$env:(?:windir|systemroot|programfiles|programdata)|\\windows\\system32)/i.test(commandText)) {
      throw new Error('Command arguments reference protected operating-system locations.');
    }
    if (/(?:%userprofile%|\$env:userprofile|~)[^\r\n]*(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.git-credentials|\.npmrc|\.pypirc)/i.test(commandText)) {
      throw new Error('Command arguments reference protected credential storage.');
    }
    const pathCandidates = collectCommandPathCandidates(args, cwd);
    for (const candidate of pathCandidates) {
      if (this.protectedSystemRoots.some((root) => isPathWithinRoot(candidate, root, { allowRoot: true }))) {
        throw new Error(`Command targets a protected system path: ${candidate}`);
      }
      if (
        isPathWithinRoot(candidate, this.monarchRoot, { allowRoot: true })
        && !isPathWithinRoot(candidate, this.workspaceCoderRoot, { allowRoot: true })
      ) {
        throw new Error(`Command cannot modify Monarch system files: ${candidate}`);
      }
    }
  }

  private result(
    allowed: boolean,
    reason: CoderPathPolicyReason,
    originalPath: string,
    resolvedPath: string,
    operation: MonarchFilesystemOperation,
  ): CoderPathPolicyResult {
    const messages: Record<CoderPathPolicyReason, string> = {
      allowed: 'Coder filesystem access allowed.',
      'invalid-path': 'Path cannot be normalized safely.',
      'drive-root-blocked': 'Drive-root mutations are blocked.',
      'system-path-blocked': 'System files are protected from Coder Mode mutations.',
      'credential-path-blocked': 'Credential stores are inaccessible in Coder Mode.',
      'monarch-system-path-blocked': 'Monarch system files are inaccessible in Coder Mode.',
    };
    return { allowed, reason, originalPath, resolvedPath, operation, message: messages[reason] };
  }
}

async function resolveExistingPath(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (samePath(parent, current)) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const realParent = await realpath(current).catch(() => current);
  return path.resolve(realParent, ...suffix);
}

function collectCommandPathCandidates(args: string[], cwd: string): string[] {
  const result: string[] = [];
  for (const arg of args) {
    const cleaned = arg.trim().replace(/^['"]|['"]$/g, '');
    if (!cleaned || /^https?:\/\//i.test(cleaned) || cleaned.startsWith('-') || cleaned.startsWith('/')) continue;
    if (/^[A-Za-z]:[\\/]/.test(cleaned) || cleaned.startsWith('\\\\') || /[\\/]/.test(cleaned)) {
      try {
        result.push(path.resolve(path.isAbsolute(cleaned) ? cleaned : path.join(cwd, cleaned)));
      } catch {
        // Malformed path-like arguments are handled by the process itself.
      }
    }
  }
  return result;
}

function systemProtectedRoots(): string[] {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const systemDrive = path.parse(systemRoot).root || 'C:\\';
  return [
    systemRoot,
    process.env.ProgramFiles || path.join(systemDrive, 'Program Files'),
    process.env['ProgramFiles(x86)'] || path.join(systemDrive, 'Program Files (x86)'),
    process.env.ProgramData || path.join(systemDrive, 'ProgramData'),
    path.join(systemDrive, 'Boot'),
    path.join(systemDrive, 'Recovery'),
    path.join(systemDrive, 'EFI'),
    path.join(systemDrive, 'System Volume Information'),
  ].filter(Boolean).map((root) => path.resolve(root));
}

function credentialProtectedPaths(): string[] {
  const userProfile = process.env.USERPROFILE || '';
  const appData = process.env.APPDATA || '';
  const candidates = [
    ...(userProfile ? [
      path.join(userProfile, '.ssh'),
      path.join(userProfile, '.gnupg'),
      path.join(userProfile, '.aws'),
      path.join(userProfile, '.azure'),
      path.join(userProfile, '.kube'),
      path.join(userProfile, '.git-credentials'),
      path.join(userProfile, '.npmrc'),
      path.join(userProfile, '.pypirc'),
      path.join(userProfile, '.config', 'gh'),
    ] : []),
    ...(appData ? [path.join(appData, 'GitHub CLI'), path.join(appData, 'gh')] : []),
  ];
  return candidates.map((candidate) => path.resolve(candidate));
}

function isMutation(operation: MonarchFilesystemOperation): boolean {
  return operation !== 'read' && operation !== 'list' && operation !== 'search';
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
