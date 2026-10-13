import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');
const defaultPolicyPath = path.join(defaultRepoRoot, 'config', 'subordinate-agents.policy.json');
const allowedStatuses = new Set(['admitted', 'controller', 'integrator', 'controller-integrator', 'denied']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, filePath);
}

function normalizeRepoPath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('A repository path is required.');
  const supplied = value.trim().replaceAll('\\', '/');
  if (/[\0-\x1F]/u.test(supplied) || supplied.includes(':')) throw new Error(`Repository path contains unsafe characters: ${value}`);
  if (supplied.split('/').includes('..')) throw new Error(`Repository path may not escape the root: ${value}`);
  if (supplied.split('/').some((component) => /[.\s]$/u.test(component))) {
    throw new Error(`Repository path contains a Windows-ambiguous component: ${value}`);
  }
  const normalized = path.posix.normalize(supplied).replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalized === '' || normalized === '.' || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`Repository path must be relative: ${value}`);
  }
  if (normalized.split('/').includes('..')) throw new Error(`Repository path may not escape the root: ${value}`);
  return normalized;
}

function matchesPathRule(candidate, rule) {
  const normalizedCandidate = normalizeRepoPath(candidate).toLowerCase();
  const normalizedRule = normalizeRepoPath(rule.replace(/\/\*\*$/u, '')).toLowerCase();
  if (rule.endsWith('/**')) {
    return normalizedCandidate === normalizedRule || normalizedCandidate.startsWith(`${normalizedRule}/`);
  }
  return normalizedCandidate === normalizedRule;
}

function rulesOverlap(first, second) {
  if (first === '**' || second === '**') return true;
  const firstBase = normalizeRepoPath(first.endsWith('/**') ? first.slice(0, -3) : first).toLowerCase();
  const secondBase = normalizeRepoPath(second.endsWith('/**') ? second.slice(0, -3) : second).toLowerCase();
  return firstBase === secondBase
    || (first.endsWith('/**') && secondBase.startsWith(`${firstBase}/`))
    || (second.endsWith('/**') && firstBase.startsWith(`${secondBase}/`));
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Policy must be a JSON object.');
  if (policy.schemaVersion !== 1) throw new Error('Unsupported subordinate-agent policy schema.');
  if (typeof policy.policyId !== 'string' || policy.policyId.trim() === '') throw new Error('policyId is required.');
  if (policy.defaults?.unknownAgentStatus !== 'denied') throw new Error('Unknown agents must fail closed.');
  if (policy.defaults?.acceptance !== 'integrator-review-required') throw new Error('An authorized integrator review must remain the acceptance gate.');
  if (!['derivatively-admitted', 'denied'].includes(policy.delegation?.grokSubagents)) {
    throw new Error('Unsupported Grok subagent admission mode.');
  }
  if (policy.delegation.grokSubagents === 'derivatively-admitted' && policy.delegation.maxDepth !== 1) {
    throw new Error('Derivatively admitted Grok subagents require depth one.');
  }
  if (!Array.isArray(policy.agents) || policy.agents.length === 0) throw new Error('Policy agents are required.');
  const ids = new Set();
  for (const agent of policy.agents) {
    if (!agent || typeof agent.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(agent.id)) {
      throw new Error('Every agent requires a canonical lowercase id.');
    }
    if (ids.has(agent.id)) throw new Error(`Duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
    if (!allowedStatuses.has(agent.status)) throw new Error(`Unsupported status for ${agent.id}: ${agent.status}`);
    if (!Array.isArray(agent.roles)) throw new Error(`Agent roles must be an array: ${agent.id}`);
  }
  const codex = policy.agents.find((agent) => agent.id === 'codex');
  if (codex?.subordinate !== false || !codex.roles.includes('controller') || !codex.roles.includes('integrator')) {
    throw new Error('Codex must remain a non-subordinate controller/integrator until an owner-recorded policy change.');
  }
  for (const principal of policy.agents.filter((agent) => agent.status === 'controller-integrator')) {
    if (principal.subordinate !== false || !principal.roles.includes('controller') || !principal.roles.includes('integrator')) {
      throw new Error(`Controller-integrator ${principal.id} must be a non-subordinate controller/integrator.`);
    }
  }
  if (!Array.isArray(policy.recordedOwnerGrants)) throw new Error('recordedOwnerGrants must be an array.');
  const grantRoles = new Set(policy.ownerAuthority?.roleGrant?.allowedRoles ?? []);
  for (const grant of policy.recordedOwnerGrants) {
    if (!ids.has(grant.agentId) || !grantRoles.has(grant.role)) throw new Error('Recorded owner grant has an invalid agent or role.');
    for (const field of ['scope', 'lifetime', 'approvalRef']) {
      if (typeof grant[field] !== 'string' || grant[field].trim() === '') throw new Error(`Recorded owner grant requires ${field}.`);
    }
  }
  for (const agent of policy.agents.filter((candidate) => candidate.subordinate && agentMayWork(candidate))) {
    const requiredRoles = agent.status === 'controller-integrator'
      ? ['controller', 'integrator']
      : agent.status === 'admitted'
        ? ['admitted']
        : [agent.status];
    for (const role of requiredRoles) {
      if (!policy.recordedOwnerGrants.some((grant) => grant.agentId === agent.id && grant.role === role)) {
        throw new Error(`Agent ${agent.id} is missing a recorded owner grant for ${role}.`);
      }
    }
    if (agent.identityKind !== undefined && agent.identityKind !== 'host-session') {
      throw new Error(`Unsupported identityKind for ${agent.id}: ${agent.identityKind}`);
    }
    if (!Array.isArray(agent.allowedModes) || agent.allowedModes.length === 0
        || !(agent.executable || agent.identityKind === 'host-session')) {
      throw new Error(`Admitted subordinate agent ${agent.id} requires allowedModes and an executable or host-session identity.`);
    }
    if (agent.identityKind === 'host-session' && agent.executable) {
      throw new Error(`Agent ${agent.id} cannot declare both identityKind:host-session and an executable.`);
    }
  }
  const grok = policy.agents.find((agent) => agent.id === 'grok');
  if (policy.delegation.grokSubagents === 'derivatively-admitted'
      && (grok?.subagents?.allowed !== true || grok.subagents.maxDepth !== policy.delegation.maxDepth)) {
    throw new Error('Grok subagent configuration must match the delegation policy.');
  }
  if (!Array.isArray(policy.protectedRepositoryPaths) || policy.protectedRepositoryPaths.length === 0) {
    throw new Error('Protected repository paths are required.');
  }
  if (!Array.isArray(policy.restrictions) || policy.restrictions.length === 0) throw new Error('Policy restrictions are required.');
  const restrictionIds = new Set();
  for (const restriction of policy.restrictions) {
    if (!restriction || typeof restriction.id !== 'string' || restrictionIds.has(restriction.id)) {
      throw new Error('Every restriction requires a unique id.');
    }
    restrictionIds.add(restriction.id);
    if (restriction.ownerOverridable !== true) {
      throw new Error(`Repository restriction must support exact owner exceptions: ${restriction.id}`);
    }
    if (!['task-toggle', 'controller-mediated', 'broker-required'].includes(restriction.enforcement)) {
      throw new Error(`Unsupported enforcement for ${restriction.id}.`);
    }
    if (!Array.isArray(restriction.directPermitTargets) || !Array.isArray(restriction.denyRules)) {
      throw new Error(`Restriction arrays are invalid: ${restriction.id}`);
    }
  }
  return policy;
}

function resolveAgent(policy, agentId) {
  const known = policy.agents.find((agent) => agent.id === agentId);
  return known ?? {
    id: agentId,
    status: policy.defaults.unknownAgentStatus,
    roles: [],
    subordinate: true,
    reason: 'Unknown agents fail closed',
  };
}

function agentMayWork(agent) {
  return ['admitted', 'controller', 'integrator', 'controller-integrator'].includes(agent.status);
}

function agentMayIssue(agent) {
  return agent.roles.includes('controller');
}

function expandTokens(value, repoRoot) {
  const replacements = {
    '${REPO}': repoRoot.replaceAll('\\', '/'),
    '${USERPROFILE}': String(process.env.USERPROFILE || '').replaceAll('\\', '/'),
    '${APPDATA}': String(process.env.APPDATA || '').replaceAll('\\', '/'),
  };
  let expanded = value;
  for (const [token, replacement] of Object.entries(replacements)) expanded = expanded.replaceAll(token, replacement);
  if (/\$\{[^}]+\}/u.test(expanded)) throw new Error(`Unresolved policy token: ${value}`);
  return expanded;
}

function loadPolicy(policyPath = defaultPolicyPath) {
  const absolute = path.resolve(policyPath);
  const raw = readFileSync(absolute);
  return { path: absolute, raw, digest: sha256(raw), policy: validatePolicy(JSON.parse(raw.toString('utf8'))) };
}

function gitBuffer(repoRoot, args, allowFailure = false) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFailure) return Buffer.alloc(0);
    const stderr = error?.stderr?.toString('utf8').trim();
    throw new Error(stderr || `git ${args.join(' ')} failed.`);
  }
}

function gitText(repoRoot, args) {
  return gitBuffer(repoRoot, args).toString('utf8').trim();
}

function nullSeparated(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).map((entry) => entry.replaceAll('\\', '/'));
}

function gitIndexSymlinks(repoRoot) {
  const records = nullSeparated(gitBuffer(repoRoot, ['ls-files', '-s', '-z']));
  return records.flatMap((record) => {
    const match = /^(\d+) [0-9a-f]+ \d+\t(.+)$/u.exec(record);
    return match?.[1] === '120000' ? [match[2]] : [];
  });
}

function collectFiles(root, relative, output) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || stat.isFile()) {
    output.add(relative.replaceAll('\\', '/'));
    return;
  }
  if (!stat.isDirectory()) return;
  for (const child of readdirSync(absolute)) collectFiles(root, path.join(relative, child), output);
}

function collectPhysicalSymlinks(root, relative, output) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    output.add(relative.replaceAll('\\', '/'));
    return;
  }
  if (!stat.isDirectory()) return;
  for (const child of readdirSync(absolute)) collectPhysicalSymlinks(root, path.join(relative, child), output);
}

function symlinksOverlappingRules(repoRoot, rules) {
  const symlinks = new Set(gitIndexSymlinks(repoRoot));
  for (const rule of rules) {
    const base = normalizeRepoPath(rule.replace(/\/\*\*$/u, ''));
    const components = base.split('/');
    for (let index = 1; index <= components.length; index += 1) {
      const ancestor = components.slice(0, index).join('/');
      const absolute = path.join(repoRoot, ancestor);
      if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
        symlinks.add(ancestor);
        break;
      }
    }
    if (rule.endsWith('/**')) collectPhysicalSymlinks(repoRoot, base, symlinks);
  }
  return [...symlinks].filter((symlink) => rules.some((rule) => (
    rulesOverlap(rule, symlink) || rulesOverlap(rule, `${symlink}/**`)
  ))).sort();
}

function pathEvidence(repoRoot, relative) {
  const absolute = path.join(repoRoot, relative);
  let working = 'missing';
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) working = `symlink:${readlinkSync(absolute)}`;
    else if (stat.isFile()) working = `file:${sha256(readFileSync(absolute))}`;
    else working = `other:${stat.mode}`;
  }
  const index = sha256(gitBuffer(repoRoot, ['ls-files', '-s', '-z', '--', relative], true));
  return sha256(`${working}\nindex:${index}`);
}

function workspaceSnapshot(repoRoot, protectedPaths = []) {
  const canonicalRoot = path.resolve(gitText(repoRoot, ['rev-parse', '--show-toplevel']));
  if (canonicalRoot.toLowerCase() !== path.resolve(repoRoot).toLowerCase()) {
    throw new Error(`Controller must run at the repository root: ${canonicalRoot}`);
  }
  const files = new Set([
    ...nullSeparated(gitBuffer(repoRoot, ['diff', '--name-only', '-z', 'HEAD', '--'])),
    ...nullSeparated(gitBuffer(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ]);
  for (const rule of protectedPaths) {
    const normalized = normalizeRepoPath(rule.replace(/\/\*\*$/u, ''));
    if (rule.endsWith('/**')) collectFiles(repoRoot, normalized, files);
    else files.add(normalized);
  }
  const entries = {};
  for (const relative of [...files].sort()) entries[relative] = pathEvidence(repoRoot, relative);
  const symlinks = new Set(gitIndexSymlinks(repoRoot));
  for (const relative of files) {
    const absolute = path.join(repoRoot, relative);
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) symlinks.add(relative);
  }
  return {
    branch: gitText(repoRoot, ['branch', '--show-current']),
    head: gitText(repoRoot, ['rev-parse', 'HEAD']),
    entries,
    symlinks: [...symlinks].sort(),
  };
}

function compareSnapshots(baseline, current, allowedPaths, protectedPaths, mode, expired = false) {
  const changedPaths = [];
  const allPaths = new Set([...Object.keys(baseline.entries), ...Object.keys(current.entries)]);
  for (const candidate of [...allPaths].sort()) {
    if (baseline.entries[candidate] !== current.entries[candidate]) changedPaths.push(candidate);
  }
  const violations = [];
  if (baseline.head !== current.head) violations.push({ code: 'head-changed', before: baseline.head, after: current.head });
  if (baseline.branch !== current.branch) violations.push({ code: 'branch-changed', before: baseline.branch, after: current.branch });
  if (expired) violations.push({ code: 'permit-expired' });
  for (const candidate of changedPaths) {
    if (current.symlinks?.some((symlink) => symlink.toLowerCase() === candidate.toLowerCase())) {
      violations.push({ code: 'symlink-scope-change', path: candidate });
      continue;
    }
    if (protectedPaths.some((rule) => matchesPathRule(candidate, rule))) {
      violations.push({ code: 'protected-path-changed', path: candidate });
      continue;
    }
    if (mode === 'observe') {
      violations.push({ code: 'observe-mode-mutation', path: candidate });
      continue;
    }
    if (!allowedPaths.some((rule) => matchesPathRule(candidate, rule))) {
      violations.push({ code: 'out-of-scope-change', path: candidate });
    }
  }
  return { changedPaths, violations, eligibleForIntegratorReview: violations.length === 0 };
}

function parseOptions(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status';
  const start = command === 'status' && argv[0]?.startsWith('--') ? 0 : 1;
  const options = new Map();
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith('--') ? argv[++index] : true;
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
  }
  return { command, options };
}

function option(options, name, fallback) {
  const values = options.get(name);
  return values?.at(-1) ?? fallback;
}

function optionList(options, name) {
  return options.get(name) ?? [];
}

function loadOwnerExceptions(filePath, policy, agentId) {
  if (!filePath) return [];
  const records = readJson(path.resolve(filePath));
  if (!Array.isArray(records)) throw new Error('Owner exceptions file must contain a JSON array.');
  return records.map((record) => {
    const restriction = policy.restrictions.find((candidate) => candidate.id === record.restrictionId);
    if (!restriction || restriction.ownerOverridable !== true) throw new Error(`Unknown owner exception: ${record.restrictionId}`);
    if (record.agentId !== agentId) throw new Error(`Owner exception agent mismatch: ${record.restrictionId}`);
    for (const field of ['target', 'purpose', 'approvalRef']) {
      if (typeof record[field] !== 'string' || record[field].trim() === '') {
        throw new Error(`Owner exception ${record.restrictionId} requires ${field}.`);
      }
    }
    const direct = restriction.enforcement === 'task-toggle' && restriction.directPermitTargets.includes(record.target);
    return {
      restrictionId: restriction.id,
      agentId,
      target: record.target,
      purpose: record.purpose,
      approvalRef: record.approvalRef,
      enforcement: restriction.enforcement,
      direct,
    };
  });
}

function loadTaskRoleGrants(filePath, policy, agentId) {
  if (!filePath) return [];
  const records = readJson(path.resolve(filePath));
  if (!Array.isArray(records)) throw new Error('Task role grants file must contain a JSON array.');
  const allowedRoles = new Set(policy.ownerAuthority.roleGrant.allowedRoles);
  return records.map((record) => {
    if (record.agentId !== agentId) throw new Error('Task role grant agent mismatch.');
    if (!allowedRoles.has(record.role)) throw new Error(`Unsupported owner-granted role: ${record.role}`);
    for (const field of ['purpose', 'approvalRef']) {
      if (typeof record[field] !== 'string' || record[field].trim() === '') throw new Error(`Task role grant requires ${field}.`);
    }
    return {
      agentId,
      role: record.role,
      purpose: record.purpose,
      approvalRef: record.approvalRef,
      lifetime: 'task',
    };
  });
}

function verifyExecutable(agent, repoRoot) {
  if (agent.identityKind === 'host-session') {
    return { applicable: false, identityKind: 'host-session' };
  }
  if (!agent.executable) return { applicable: false };
  const executablePath = path.resolve(expandTokens(agent.executable.path, repoRoot));
  if (!existsSync(executablePath)) throw new Error(`Agent executable is missing: ${executablePath}`);
  const digest = sha256(readFileSync(executablePath));
  if (digest !== agent.executable.sha256.toUpperCase()) throw new Error(`Executable fingerprint mismatch for ${agent.id}.`);
  const version = spawnSync(executablePath, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (version.status !== 0 || !String(version.stdout).includes(agent.executable.version)) {
    throw new Error(`Executable version mismatch for ${agent.id}.`);
  }
  const escaped = executablePath.replaceAll("'", "''");
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const securityModule = path.join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'Modules',
    'Microsoft.PowerShell.Security',
    'Microsoft.PowerShell.Security.psd1',
  ).replaceAll("'", "''");
  const command = `$ErrorActionPreference='Stop'; Import-Module '${securityModule}' -Force; $s=Get-AuthenticodeSignature -LiteralPath '${escaped}'; [pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`;
  const signature = spawnSync(powershell, ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (signature.status !== 0) throw new Error(`Authenticode verification failed for ${agent.id}.`);
  const parsed = JSON.parse(signature.stdout.trim());
  if (parsed.Status !== agent.executable.authenticodeStatus || !parsed.Subject.includes(agent.executable.signerSubjectContains)) {
    throw new Error(`Authenticode identity mismatch for ${agent.id}.`);
  }
  return { applicable: true, path: executablePath, version: version.stdout.trim(), sha256: digest, signature: parsed };
}

function controlRoot(repoRoot) {
  return path.join(repoRoot, '.agent-control');
}

function taskPath(repoRoot, taskId) {
  return path.join(controlRoot(repoRoot), 'tasks', `${taskId}.json`);
}

function resolveTaskPath(repoRoot, value) {
  if (!value) throw new Error('--task is required.');
  const tasksRoot = path.resolve(controlRoot(repoRoot), 'tasks');
  const supplied = String(value);
  if (!supplied.includes('/') && !supplied.includes('\\') && !/^task-[a-z0-9-]+$/iu.test(supplied)) {
    throw new Error('Task id is invalid.');
  }
  const resolved = supplied.includes('/') || supplied.includes('\\') ? path.resolve(supplied) : taskPath(repoRoot, supplied);
  const relative = path.relative(tasksRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.extname(resolved).toLowerCase() !== '.json') {
    throw new Error('Task record must remain inside .agent-control/tasks.');
  }
  return resolved;
}

function issueTask({ repoRoot, policyRecord, options }) {
  const agentId = String(option(options, 'agent', 'grok'));
  const issuerId = String(option(options, 'issuer', 'codex'));
  const agent = resolveAgent(policyRecord.policy, agentId);
  const issuer = resolveAgent(policyRecord.policy, issuerId);
  const roleGrants = loadTaskRoleGrants(option(options, 'role-grants-file'), policyRecord.policy, agentId);
  const grantedWorkRole = roleGrants.some((grant) => ['admitted', 'controller', 'integrator'].includes(grant.role));
  if (!agentMayWork(agent) && !grantedWorkRole) throw new Error(`Agent is not admitted: ${agentId}`);
  if (!agentMayIssue(issuer)) throw new Error(`Issuer is not a controller: ${issuerId}`);
  if (agent.identityKind === 'host-session') {
    throw new Error(`${agentId} is a host-session agent and cannot be spawned via subordinate-agent-control; it already runs as the invoking session, not a controller-launched process.`);
  }
  const mode = String(option(options, 'mode', 'observe'));
  if (!agent.allowedModes?.includes(mode)) throw new Error(`Mode is not allowed for ${agentId}: ${mode}`);
  if (!agent.executable) throw new Error(`No executable identity is configured for ${agentId}.`);
  const objective = String(option(options, 'objective', '')).trim();
  if (!objective) throw new Error('--objective is required.');
  const allowedPaths = optionList(options, 'allow').map((value) => normalizeRepoPath(String(value)));
  if (mode === 'implement' && allowedPaths.length === 0) throw new Error('Implementation permits require at least one --allow path.');
  for (const allowed of allowedPaths) {
    if (policyRecord.policy.protectedRepositoryPaths.some((protectedPath) => rulesOverlap(allowed, protectedPath))) {
      throw new Error(`Allowed scope overlaps a protected policy path: ${allowed}`);
    }
  }
  const symlinkScopes = symlinksOverlappingRules(repoRoot, allowedPaths);
  if (symlinkScopes.length > 0) throw new Error(`Allowed scope crosses a symlink: ${symlinkScopes.join(', ')}`);
  const minutes = Number(option(options, 'minutes', 120));
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) throw new Error('--minutes must be between 5 and 480.');
  const exceptions = loadOwnerExceptions(option(options, 'exceptions-file'), policyRecord.policy, agentId);
  const issuedAt = new Date();
  const id = `task-${issuedAt.toISOString().replace(/[-:.TZ]/gu, '')}-${randomBytes(4).toString('hex')}`;
  const task = {
    schemaVersion: 1,
    id,
    status: 'issued',
    agentId,
    issuedBy: issuerId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + minutes * 60_000).toISOString(),
    policyId: policyRecord.policy.policyId,
    policySha256: policyRecord.digest,
    mode,
    objective,
    allowedPaths,
    taskRoleGrants: roleGrants,
    ownerExceptions: exceptions,
    subagents: {
      allowed: agent.subagents?.allowed === true,
      maxDepth: Math.min(agent.subagents?.maxDepth ?? 0, policyRecord.policy.delegation.maxDepth),
      inheritance: policyRecord.policy.delegation.inheritance,
    },
    integratorReviewRequired: true,
    baseline: workspaceSnapshot(repoRoot, policyRecord.policy.protectedRepositoryPaths),
  };
  const outputPath = taskPath(repoRoot, id);
  writeJsonAtomic(outputPath, task);
  return { task, path: outputPath };
}

function effectiveDenyRules(policy, task, repoRoot) {
  const directLifted = new Set(task.ownerExceptions.filter((exception) => exception.direct).map((exception) => exception.restrictionId));
  return policy.restrictions.flatMap((restriction) => directLifted.has(restriction.id)
    ? []
    : restriction.denyRules.map((rule) => expandTokens(rule, repoRoot)));
}

function buildLaunch(agent, policy, task, repoRoot) {
  const executablePath = path.resolve(expandTokens(agent.executable.path, repoRoot));
  const webAllowed = task.ownerExceptions.some((exception) => exception.direct
    && exception.restrictionId === 'web-search'
    && exception.target === 'grok-web-search');
  const args = ['--cwd', repoRoot, '--permission-mode', task.mode === 'observe' ? 'plan' : 'default'];
  if (!task.subagents.allowed) args.push('--no-subagents');
  if (!webAllowed) args.push('--disable-web-search');
  for (const rule of effectiveDenyRules(policy, task, repoRoot)) args.push('--deny', rule);
  const mediated = task.ownerExceptions.filter((exception) => !exception.direct);
  const rules = [
    `MONARCH CONTROLLED TASK ${task.id}`,
    `Agent: ${task.agentId}; mode: ${task.mode}; expires: ${task.expiresAt}.`,
    `Objective: ${task.objective}`,
    `Owner-granted task roles: ${task.taskRoleGrants?.length ? task.taskRoleGrants.map((grant) => grant.role).join(', ') : 'none'}.`,
    `Editable scope: ${task.allowedPaths.length ? task.allowedPaths.join(', ') : 'none (read-only)'}.`,
    `Subagents: ${task.subagents.allowed ? `allowed at depth ${task.subagents.maxDepth}; inherit the strictest parent permit and may not delegate further` : 'disabled'}.`,
    'Do not change branch/HEAD, policy/control files, permissions, task state or pre-existing unrelated work.',
    'Do not commit, push, publish, release, delete or claim completion without receipts and authorized-integrator review.',
    mediated.length
      ? `Owner-approved outcomes requiring controller/broker mediation (do not execute directly): ${mediated.map((item) => `${item.restrictionId}:${item.target}`).join(', ')}.`
      : 'No controller/broker-mediated owner exceptions.',
  ].join('\n');
  args.push('--rules', rules, task.objective);
  return { executablePath, args, webAllowed };
}

function finalizeTask(repoRoot, policy, task, processExitCode) {
  const current = workspaceSnapshot(repoRoot, policy.protectedRepositoryPaths);
  const expired = Date.now() > Date.parse(task.expiresAt);
  const comparison = compareSnapshots(
    task.baseline,
    current,
    task.allowedPaths,
    policy.protectedRepositoryPaths,
    task.mode,
    expired,
  );
  task.closedAt = new Date().toISOString();
  task.processExitCode = processExitCode;
  task.finalSnapshot = current;
  task.comparison = comparison;
  task.status = comparison.eligibleForIntegratorReview && processExitCode === 0 ? 'candidate' : 'rejected';
  task.accepted = false;
  return task;
}

function launchTask({ repoRoot, policyRecord, options }) {
  const filePath = resolveTaskPath(repoRoot, option(options, 'task'));
  const task = readJson(filePath);
  if (!['issued', 'running'].includes(task.status)) throw new Error(`Task cannot launch from status: ${task.status}`);
  if (task.policySha256 !== policyRecord.digest) throw new Error('Policy changed after permit issuance. Issue a new permit.');
  if (Date.now() > Date.parse(task.expiresAt)) throw new Error('Task permit expired.');
  const agent = resolveAgent(policyRecord.policy, task.agentId);
  if (!agentMayWork(agent)) throw new Error(`Agent is no longer admitted: ${task.agentId}`);
  const current = workspaceSnapshot(repoRoot, policyRecord.policy.protectedRepositoryPaths);
  if (current.head !== task.baseline.head || current.branch !== task.baseline.branch) {
    throw new Error('Branch or HEAD changed after permit issuance.');
  }
  const preflight = compareSnapshots(
    task.baseline,
    current,
    task.allowedPaths,
    policyRecord.policy.protectedRepositoryPaths,
    'implement',
    false,
  );
  if (preflight.changedPaths.length > 0) throw new Error('Workspace changed after permit issuance. Issue a new permit.');
  verifyExecutable(agent, repoRoot);
  const launch = buildLaunch(agent, policyRecord.policy, task, repoRoot);
  if (option(options, 'dry-run', false) === true) return { dryRun: true, taskId: task.id, ...launch };
  task.status = 'running';
  task.launchedAt = new Date().toISOString();
  writeJsonAtomic(filePath, task);
  const child = spawnSync(launch.executablePath, launch.args, { cwd: repoRoot, stdio: 'inherit', windowsHide: true });
  const finalized = finalizeTask(repoRoot, policyRecord.policy, task, child.status ?? 1);
  writeJsonAtomic(filePath, finalized);
  return { taskId: task.id, status: finalized.status, comparison: finalized.comparison, processExitCode: finalized.processExitCode };
}

function closeTask({ repoRoot, policyRecord, options }) {
  const filePath = resolveTaskPath(repoRoot, option(options, 'task'));
  const task = readJson(filePath);
  if (['revoked', 'candidate', 'rejected'].includes(task.status)) throw new Error(`Task cannot close from status: ${task.status}`);
  if (task.policySha256 !== policyRecord.digest) throw new Error('Policy changed after permit issuance. Task cannot close as a candidate.');
  const finalized = finalizeTask(repoRoot, policyRecord.policy, task, Number(option(options, 'exit-code', 0)));
  writeJsonAtomic(filePath, finalized);
  return { taskId: task.id, status: finalized.status, comparison: finalized.comparison };
}

function revokeTask({ repoRoot, options }) {
  const filePath = resolveTaskPath(repoRoot, option(options, 'task'));
  const task = readJson(filePath);
  task.status = 'revoked';
  task.revokedAt = new Date().toISOString();
  task.revocationReason = String(option(options, 'reason', 'Revoked by controller'));
  task.accepted = false;
  writeJsonAtomic(filePath, task);
  return { taskId: task.id, status: task.status, reason: task.revocationReason };
}

function acceptTask({ repoRoot, policyRecord, options }) {
  const filePath = resolveTaskPath(repoRoot, option(options, 'task'));
  const task = readJson(filePath);
  if (task.status !== 'candidate') throw new Error(`Only a candidate can be reviewed: ${task.status}`);
  if (task.policySha256 !== policyRecord.digest) throw new Error('Policy changed after permit issuance. Candidate requires a fresh review permit.');
  const integratorId = String(option(options, 'integrator', 'codex'));
  const integrator = resolveAgent(policyRecord.policy, integratorId);
  const durablyAuthorized = agentMayWork(integrator) && integrator.roles.includes('integrator');
  const taskAuthorized = task.taskRoleGrants?.some((grant) => grant.agentId === integratorId && grant.role === 'integrator');
  if (!durablyAuthorized && !taskAuthorized) throw new Error(`Agent is not an authorized integrator for this task: ${integratorId}`);
  const decision = String(option(options, 'decision', 'accepted'));
  if (!['accepted', 'rejected'].includes(decision)) throw new Error('--decision must be accepted or rejected.');
  const evidence = optionList(options, 'evidence').map(String).filter((value) => value.trim() !== '');
  if (evidence.length === 0) throw new Error('Integrator decision requires at least one --evidence reference.');
  const current = workspaceSnapshot(repoRoot, policyRecord.policy.protectedRepositoryPaths);
  const liveComparison = compareSnapshots(
    task.baseline,
    current,
    task.allowedPaths,
    policyRecord.policy.protectedRepositoryPaths,
    task.mode,
    Date.now() > Date.parse(task.expiresAt),
  );
  if (JSON.stringify(current) !== JSON.stringify(task.finalSnapshot) || !liveComparison.eligibleForIntegratorReview) {
    throw new Error('Workspace changed after candidate closure. Close and review a fresh candidate.');
  }
  if (decision === 'accepted' && (!task.comparison?.eligibleForIntegratorReview || task.processExitCode !== 0)) {
    throw new Error('Rejected controller evidence cannot be accepted.');
  }
  task.status = decision;
  task.accepted = decision === 'accepted';
  task.integratorDecision = {
    integratorId,
    decision,
    evidence,
    decidedAt: new Date().toISOString(),
  };
  writeJsonAtomic(filePath, task);
  return { taskId: task.id, status: task.status, integratorDecision: task.integratorDecision };
}

function statusReport(repoRoot, policyRecord, options) {
  const requested = option(options, 'agent');
  const agents = requested
    ? [resolveAgent(policyRecord.policy, String(requested))]
    : policyRecord.policy.agents;
  return {
    ok: true,
    policyId: policyRecord.policy.policyId,
    policySha256: policyRecord.digest,
    repository: {
      root: repoRoot,
      branch: gitText(repoRoot, ['branch', '--show-current']),
      head: gitText(repoRoot, ['rev-parse', 'HEAD']),
    },
    ownerRoleGrantEnabled: true,
    ownerRestrictionExceptionsEnabled: true,
    agents: agents.map((agent) => ({
      id: agent.id,
      status: agent.status,
      roles: agent.roles,
      subordinate: agent.subordinate,
      identityKind: agent.identityKind ?? (agent.executable ? 'spawnable-executable' : undefined),
      executable: agentMayWork(agent) && (agent.executable || agent.identityKind === 'host-session')
        ? verifyExecutable(agent, repoRoot)
        : undefined,
      reason: agent.reason,
    })),
    delegation: policyRecord.policy.delegation,
    acceptance: policyRecord.policy.defaults.acceptance,
  };
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseOptions(argv);
  const repoRoot = path.resolve(String(option(options, 'repo', defaultRepoRoot)));
  const policyRecord = loadPolicy(String(option(options, 'policy', defaultPolicyPath)));
  let result;
  if (command === 'status') result = statusReport(repoRoot, policyRecord, options);
  else if (command === 'issue') result = issueTask({ repoRoot, policyRecord, options });
  else if (command === 'launch') result = launchTask({ repoRoot, policyRecord, options });
  else if (command === 'close') result = closeTask({ repoRoot, policyRecord, options });
  else if (command === 'revoke') result = revokeTask({ repoRoot, options });
  else if (command === 'accept') result = acceptTask({ repoRoot, policyRecord, options });
  else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export {
  acceptTask,
  buildLaunch,
  compareSnapshots,
  issueTask,
  loadOwnerExceptions,
  loadTaskRoleGrants,
  loadPolicy,
  matchesPathRule,
  resolveAgent,
  rulesOverlap,
  symlinksOverlappingRules,
  validatePolicy,
  workspaceSnapshot,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`subordinate-agent-control: ${error.message}\n`);
    process.exitCode = 1;
  });
}
