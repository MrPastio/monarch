import path from 'node:path';
import type {
  MonarchActionProposalV1,
  MonarchCapability,
  MonarchCapabilityLeaseBudgets,
  MonarchCapabilityLeaseUsage,
  MonarchCapabilityLeaseV1,
  MonarchExecutionRequest,
  MonarchRiskVector,
} from './contracts';
import { extractActionOrigins, extractActionPaths } from './action-protocol';
import { createMonarchId, nowIso } from './utils';
import { readDurableJson, writeDurableJson } from './durable-json';

const DEFAULT_TASK_LEASE_MS = 30 * 60 * 1000;
const MAX_LEASE_MS = 8 * 60 * 60 * 1000;
const WORKSPACE_REVERSIBLE_CAPABILITIES = [
  'workspace.root.get',
  'workspace.files.read',
  'workspace.files.list',
  'workspace.files.search',
  'workspace.files.write',
  'workspace.files.append',
  'workspace.files.mkdir',
  'workspace.files.copy',
  'workspace.files.replace',
  'workspace.files.restore',
] as const;

export interface IssueCapabilityLeaseOptions {
  intentHash: string;
  capabilities: string[];
  roots?: string[];
  pathGlobs?: string[];
  origins?: string[];
  expiresInMs?: number;
  budgets?: Partial<MonarchCapabilityLeaseBudgets>;
  allowEffects?: string[];
  denyEffects?: string[];
  modelId?: string;
  skillIds?: string[];
}

export interface CapabilityLeaseMatch {
  ok: boolean;
  lease?: MonarchCapabilityLeaseV1;
  code: string;
  reason: string;
}

interface PersistedCapabilityLeasesV1 {
  version: 1;
  leases: MonarchCapabilityLeaseV1[];
}

export class MonarchCapabilityLeaseStore {
  private readonly leases = new Map<string, MonarchCapabilityLeaseV1>();

  constructor(
    private readonly workspaceRoot = process.cwd(),
    private readonly persistencePath?: string,
  ) {
    this.restore();
  }

  issue(options: IssueCapabilityLeaseOptions): MonarchCapabilityLeaseV1 {
    const issuedAt = nowIso();
    const expiresInMs = clampInteger(options.expiresInMs ?? DEFAULT_TASK_LEASE_MS, 60_000, MAX_LEASE_MS);
    const budgets = normalizeBudgets(options.budgets);
    const lease: MonarchCapabilityLeaseV1 = {
      version: 1,
      leaseId: createMonarchId('lease'),
      intentHash: options.intentHash,
      capabilities: uniqueStrings(options.capabilities).slice(0, 64),
      roots: uniqueStrings((options.roots || []).map((root) => path.resolve(this.workspaceRoot, root))).slice(0, 16),
      pathGlobs: uniqueStrings(options.pathGlobs || []).slice(0, 32),
      origins: uniqueStrings(options.origins || []).slice(0, 32),
      issuedAt,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      budgets,
      usage: emptyUsage(),
      allowEffects: uniqueStrings(options.allowEffects || ['read', 'write']),
      denyEffects: uniqueStrings(options.denyEffects || ['delete', 'execute', 'network', 'money', 'identity', 'security-sensitive']),
      modelId: String(options.modelId || 'unknown').slice(0, 200),
      skillIds: uniqueStrings(options.skillIds || []).slice(0, 8),
      revocable: true,
      status: 'active',
    };
    if (lease.capabilities.length === 0) throw new Error('Capability lease requires at least one capability.');
    this.leases.set(lease.leaseId, lease);
    this.persist();
    return cloneLease(lease);
  }

  issueForProposal(proposal: MonarchActionProposalV1): MonarchCapabilityLeaseV1 {
    const isReversibleWorkspace = proposal.capabilityId.startsWith('workspace.')
      && proposal.riskVector.effect !== 'delete'
      && proposal.riskVector.reversibility !== 'irreversible';
    return this.issue({
      intentHash: proposal.intentHash,
      capabilities: isReversibleWorkspace
        ? [...WORKSPACE_REVERSIBLE_CAPABILITIES]
        : [proposal.capabilityId],
      ...(isReversibleWorkspace
        ? { roots: [this.workspaceRoot] }
        : proposal.scope.roots ? { roots: proposal.scope.roots } : {}),
      ...(proposal.scope.origins ? { origins: proposal.scope.origins } : {}),
      expiresInMs: DEFAULT_TASK_LEASE_MS,
      budgets: isReversibleWorkspace
        ? { maxActions: 80, maxFiles: 50, maxBytesWritten: 5 * 1024 * 1024, maxDeletes: 0, maxNetworkRequests: 0 }
        : { maxActions: 8, maxFiles: 8, maxBytesWritten: 1024 * 1024, maxDeletes: 0, maxNetworkRequests: 0 },
      allowEffects: isReversibleWorkspace ? ['read', 'write'] : [proposal.riskVector.effect],
      denyEffects: ['delete', 'money', 'identity', 'security-sensitive'],
      modelId: proposal.provenance.model,
      skillIds: proposal.provenance.skillIds,
    });
  }

  match(
    request: MonarchExecutionRequest,
    capability: MonarchCapability,
    riskVector: MonarchRiskVector,
  ): CapabilityLeaseMatch {
    this.refreshStatuses();
    const candidates = request.leaseId
      ? [this.leases.get(request.leaseId)].filter((lease): lease is MonarchCapabilityLeaseV1 => Boolean(lease))
      : [...this.leases.values()].filter((lease) => lease.status === 'active' && lease.intentHash === request.intentHash);
    if (candidates.length === 0) return { ok: false, code: 'lease-not-found', reason: 'No active task lease matches this intent.' };

    for (const lease of candidates) {
      const result = matchLease(lease, request, capability, riskVector, this.workspaceRoot);
      if (result.ok) return { ...result, lease: cloneLease(lease) };
    }
    return { ok: false, code: 'lease-out-of-scope', reason: 'Active task lease does not cover this action scope or budget.' };
  }

  recordUse(leaseId: string, request: MonarchExecutionRequest, riskVector: MonarchRiskVector): MonarchCapabilityLeaseV1 | null {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.status !== 'active') return null;
    const cost = actionCost(request, riskVector);
    lease.usage.actions += cost.actions;
    lease.usage.files += cost.files;
    lease.usage.bytesWritten += cost.bytesWritten;
    lease.usage.deletes += cost.deletes;
    lease.usage.networkRequests += cost.networkRequests;
    if (!withinBudgets(lease.budgets, lease.usage)) lease.status = 'exhausted';
    this.persist();
    return cloneLease(lease);
  }

  revoke(leaseId: string): MonarchCapabilityLeaseV1 | null {
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    lease.status = 'revoked';
    this.persist();
    return cloneLease(lease);
  }

  get(leaseId: string): MonarchCapabilityLeaseV1 | null {
    this.refreshStatuses();
    const lease = this.leases.get(leaseId);
    return lease ? cloneLease(lease) : null;
  }

  list(options: { activeOnly?: boolean } = {}): MonarchCapabilityLeaseV1[] {
    this.refreshStatuses();
    return [...this.leases.values()]
      .filter((lease) => !options.activeOnly || lease.status === 'active')
      .sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt))
      .map(cloneLease);
  }

  private refreshStatuses(): void {
    const now = Date.now();
    let changed = false;
    for (const lease of this.leases.values()) {
      if (lease.status === 'active' && Date.parse(lease.expiresAt) <= now) {
        lease.status = 'expired';
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private restore(): void {
    if (!this.persistencePath) return;
    const persisted = readDurableJson<PersistedCapabilityLeasesV1>(this.persistencePath);
    if (!persisted || persisted.version !== 1 || !Array.isArray(persisted.leases)) return;
    for (const candidate of persisted.leases.slice(-500)) {
      if (!isPersistedLease(candidate)) continue;
      this.leases.set(candidate.leaseId, cloneLease(candidate));
    }
    this.refreshStatuses();
  }

  private persist(): void {
    if (!this.persistencePath) return;
    writeDurableJson(this.persistencePath, {
      version: 1,
      leases: [...this.leases.values()].slice(-500).map(cloneLease),
    } satisfies PersistedCapabilityLeasesV1);
  }
}

function matchLease(
  lease: MonarchCapabilityLeaseV1,
  request: MonarchExecutionRequest,
  capability: MonarchCapability,
  riskVector: MonarchRiskVector,
  workspaceRoot: string,
): CapabilityLeaseMatch {
  if (lease.status !== 'active') return { ok: false, code: `lease-${lease.status}`, reason: `Lease is ${lease.status}.` };
  if (request.intentHash !== lease.intentHash) return { ok: false, code: 'lease-intent-mismatch', reason: 'Lease belongs to another user task.' };
  if (!lease.capabilities.includes(capability.id)) return { ok: false, code: 'lease-capability-mismatch', reason: 'Capability is outside the lease.' };
  if (!lease.allowEffects.includes(riskVector.effect) || lease.denyEffects.includes(riskVector.effect)) {
    return { ok: false, code: 'lease-effect-denied', reason: 'Action effect is outside the lease.' };
  }
  if (riskVector.reversibility === 'irreversible') return { ok: false, code: 'lease-irreversible', reason: 'Irreversible actions cannot use this task lease.' };

  const input = asRecord(request.input);
  const paths = extractActionPaths(input).map((entry) => path.resolve(workspaceRoot, entry));
  if (paths.length > 0 && lease.roots.length === 0) return { ok: false, code: 'lease-root-missing', reason: 'Lease has no filesystem root.' };
  if (paths.some((candidate) => !lease.roots.some((root) => isPathInside(candidate, root)))) {
    return { ok: false, code: 'lease-path-outside-root', reason: 'Action path is outside lease roots.' };
  }
  if (paths.length > 0 && lease.pathGlobs.length > 0 && paths.some((candidate) => !matchesAnyPathGlob(candidate, lease.pathGlobs, lease.roots))) {
    return { ok: false, code: 'lease-path-glob-mismatch', reason: 'Action path does not match the lease path pattern.' };
  }
  const origins = extractActionOrigins(input);
  if (origins.some((origin) => !lease.origins.includes(origin))) {
    return { ok: false, code: 'lease-origin-mismatch', reason: 'Network destination is outside the lease.' };
  }

  const projected = addUsage(lease.usage, actionCost(request, riskVector));
  if (!withinBudgets(lease.budgets, projected)) return { ok: false, code: 'lease-budget-exceeded', reason: 'Action would exceed the lease budget.' };
  return { ok: true, lease, code: 'lease-allowed', reason: 'Action is covered by a scoped task lease.' };
}

function actionCost(request: MonarchExecutionRequest, riskVector: MonarchRiskVector): MonarchCapabilityLeaseUsage {
  const input = asRecord(request.input);
  const paths = extractActionPaths(input);
  const contentBytes = Object.entries(input).reduce((total, [key, value]) => (
    /content|text|data/i.test(key) && typeof value === 'string' ? total + Buffer.byteLength(value, 'utf8') : total
  ), 0);
  return {
    actions: 1,
    files: paths.length,
    bytesWritten: riskVector.effect === 'write' ? contentBytes : 0,
    deletes: riskVector.effect === 'delete' ? Math.max(paths.length, 1) : 0,
    networkRequests: riskVector.effect === 'network' ? 1 : 0,
  };
}

function normalizeBudgets(value: Partial<MonarchCapabilityLeaseBudgets> | undefined): MonarchCapabilityLeaseBudgets {
  return {
    maxActions: clampInteger(value?.maxActions ?? 40, 1, 1_000),
    maxFiles: clampInteger(value?.maxFiles ?? 50, 0, 10_000),
    maxBytesWritten: clampInteger(value?.maxBytesWritten ?? 5 * 1024 * 1024, 0, 1024 * 1024 * 1024),
    maxDeletes: clampInteger(value?.maxDeletes ?? 0, 0, 10_000),
    maxNetworkRequests: clampInteger(value?.maxNetworkRequests ?? 0, 0, 10_000),
  };
}

function withinBudgets(budgets: MonarchCapabilityLeaseBudgets, usage: MonarchCapabilityLeaseUsage): boolean {
  return usage.actions <= budgets.maxActions
    && usage.files <= (budgets.maxFiles ?? Number.MAX_SAFE_INTEGER)
    && usage.bytesWritten <= (budgets.maxBytesWritten ?? Number.MAX_SAFE_INTEGER)
    && usage.deletes <= (budgets.maxDeletes ?? Number.MAX_SAFE_INTEGER)
    && usage.networkRequests <= (budgets.maxNetworkRequests ?? Number.MAX_SAFE_INTEGER);
}

function addUsage(left: MonarchCapabilityLeaseUsage, right: MonarchCapabilityLeaseUsage): MonarchCapabilityLeaseUsage {
  return {
    actions: left.actions + right.actions,
    files: left.files + right.files,
    bytesWritten: left.bytesWritten + right.bytesWritten,
    deletes: left.deletes + right.deletes,
    networkRequests: left.networkRequests + right.networkRequests,
  };
}

function emptyUsage(): MonarchCapabilityLeaseUsage {
  return { actions: 0, files: 0, bytesWritten: 0, deletes: 0, networkRequests: 0 };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  if (candidate.toLowerCase() === root.toLowerCase()) return true;
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function matchesAnyPathGlob(candidatePath: string, globs: string[], roots: string[]): boolean {
  const candidates = [normalizeGlobPath(path.resolve(candidatePath))];
  for (const root of roots) {
    const relative = path.relative(root, candidatePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) candidates.push(normalizeGlobPath(relative));
  }
  return globs.some((glob) => {
    const matcher = globToRegExp(normalizeGlobPath(glob));
    return candidates.some((candidate) => matcher.test(candidate));
  });
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`, 'i');
}

function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function cloneLease(lease: MonarchCapabilityLeaseV1): MonarchCapabilityLeaseV1 {
  return {
    ...lease,
    capabilities: [...lease.capabilities],
    roots: [...lease.roots],
    pathGlobs: [...lease.pathGlobs],
    origins: [...lease.origins],
    budgets: { ...lease.budgets },
    usage: { ...lease.usage },
    allowEffects: [...lease.allowEffects],
    denyEffects: [...lease.denyEffects],
    skillIds: [...lease.skillIds],
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function isPersistedLease(value: unknown): value is MonarchCapabilityLeaseV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return lease.version === 1
    && typeof lease.leaseId === 'string'
    && typeof lease.intentHash === 'string'
    && Array.isArray(lease.capabilities)
    && Array.isArray(lease.roots)
    && Array.isArray(lease.pathGlobs)
    && Array.isArray(lease.origins)
    && typeof lease.issuedAt === 'string'
    && typeof lease.expiresAt === 'string'
    && Boolean(lease.budgets && typeof lease.budgets === 'object')
    && Boolean(lease.usage && typeof lease.usage === 'object')
    && Array.isArray(lease.allowEffects)
    && Array.isArray(lease.denyEffects)
    && typeof lease.modelId === 'string'
    && Array.isArray(lease.skillIds)
    && (lease.status === 'active' || lease.status === 'revoked' || lease.status === 'expired' || lease.status === 'exhausted');
}
