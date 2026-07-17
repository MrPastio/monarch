import type {
  MonarchCapability,
  MonarchExecutionRequest,
  MonarchPermissionDecision,
  MonarchPermissionProfile,
  MonarchPolicyDecision,
  MonarchPolicyEvidence,
  MonarchRisk,
  MonarchRiskVector,
} from './contracts';
import { deriveRiskVector, normalizeAutonomyModeFromSandbox } from './action-protocol';
import { MonarchCapabilityLeaseStore } from './capability-leases';
import { MonarchPermissionGate } from './permission-gate';

const SAFE_WORKSPACE_MUTATIONS = new Set([
  'workspace.files.write',
  'workspace.files.append',
  'workspace.files.mkdir',
  'workspace.files.copy',
  'workspace.files.replace',
  'workspace.files.restore',
]);

const SAFE_FULL_LOCAL_DEVICE_ACTIONS = new Set([
  'device.app.open',
  'device.volume.get',
  'device.volume.set',
  'device.media.control',
]);

export interface MonarchPolicyPreflight {
  decision: MonarchPolicyDecision;
  permission: MonarchPermissionDecision;
}

export interface MonarchSecurityPolicyFact {
  ok: boolean;
  status: string;
  report: string;
  evidenceCodes?: string[];
  hard?: boolean;
  overrideable?: boolean;
}

export interface MonarchPolicyRuntimeFacts {
  modelCommandsEnabled?: boolean;
  modelConfirmationMode?: 'adaptive' | 'always';
}

export class MonarchPolicyKernel {
  constructor(
    private readonly permissions: MonarchPermissionGate,
    readonly leases: MonarchCapabilityLeaseStore,
  ) {}

  preflight(
    request: MonarchExecutionRequest,
    capability: MonarchCapability,
    effectiveRisk: MonarchRisk,
    runtimeFacts: MonarchPolicyRuntimeFacts = {},
  ): MonarchPolicyPreflight {
    const effectiveCapability = effectiveRisk === capability.risk ? capability : { ...capability, risk: effectiveRisk };
    const derivedRiskVector = deriveRiskVector(effectiveCapability, asRecord(request.input));
    const riskVector = request.riskVector
      ? mergeRiskVectorsConservatively(derivedRiskVector, request.riskVector)
      : derivedRiskVector;
    const evidence: MonarchPolicyEvidence[] = [];
    if (request.proposalId) {
      evidence.push({
        source: 'provenance',
        code: 'proposal.typed.canonicalized',
        severity: 'info',
        message: `Typed action proposal ${request.proposalId} was normalized before policy evaluation.`,
      });
    }

    const hardBoundary = deterministicHardBoundary(request, riskVector);
    if (hardBoundary) {
      evidence.push(hardBoundary);
      return {
        permission: denyPermission(effectiveRisk, hardBoundary.message),
        decision: decision('deny', effectiveRisk, riskVector, evidence, hardBoundary.message, false, request),
      };
    }

    const coderExecution = request.executionMode === 'coder' && request.moduleId === 'coder';
    if (request.proposalId && runtimeFacts.modelCommandsEnabled === false && !coderExecution) {
      const modelPolicyBlock: MonarchPolicyEvidence = {
        source: 'security',
        code: 'model-policy.commands-disabled',
        severity: 'block',
        hard: true,
        message: 'Model-proposed commands are disabled by the explicit user policy.',
      };
      evidence.push(modelPolicyBlock);
      return {
        permission: denyPermission(effectiveRisk, modelPolicyBlock.message),
        decision: decision('deny', effectiveRisk, riskVector, evidence, modelPolicyBlock.message, false, request),
      };
    }
    if (request.proposalId && runtimeFacts.modelConfirmationMode === 'always' && !coderExecution) {
      const requiresConfirmation = request.confirmed !== true;
      const modelPolicyEvidence: MonarchPolicyEvidence = {
        source: 'security',
        code: requiresConfirmation ? 'model-policy.confirmation-required' : 'model-policy.confirmation-satisfied',
        severity: requiresConfirmation ? 'warn' : 'info',
        message: requiresConfirmation
          ? 'The explicit user policy requires confirmation for every model-proposed command.'
          : 'The exact model-proposed command was confirmed under the always-confirm policy.',
      };
      evidence.push(modelPolicyEvidence);
      if (requiresConfirmation) {
        return {
          permission: {
            mode: 'confirm',
            reason: modelPolicyEvidence.message,
            risk: effectiveRisk,
            requiresUserConfirmation: true,
          },
          decision: decision('confirm', effectiveRisk, riskVector, evidence, modelPolicyEvidence.message, false, request),
        };
      }
    }

    if ((Boolean(request.proposalId) || request.moduleId === 'workspace')
      && riskVector.reversibility === 'irreversible'
      && riskVector.effect !== 'none'
      && riskVector.effect !== 'read'
      && request.confirmed !== true
      && !coderExecution) {
      const irreversibleEvidence: MonarchPolicyEvidence = {
        source: 'runtime',
        code: 'risk.irreversible.confirmation-required',
        severity: 'warn',
        message: 'Irreversible actions require confirmation for the exact canonical input in every autonomy mode.',
      };
      evidence.push(irreversibleEvidence);
      return {
        permission: {
          mode: 'confirm',
          reason: irreversibleEvidence.message,
          risk: effectiveRisk,
          requiresUserConfirmation: true,
        },
        decision: decision('confirm', effectiveRisk, riskVector, evidence, irreversibleEvidence.message, false, request),
      };
    }

    const leaseMatch = request.intentHash
      ? this.leases.match(request, effectiveCapability, riskVector)
      : { ok: false, code: 'lease-intent-missing', reason: 'Request has no task intent binding.' };
    if (leaseMatch.ok && leaseMatch.lease) {
      evidence.push({
        source: 'lease',
        code: 'lease.scope.allowed',
        severity: 'info',
        message: leaseMatch.reason,
      });
      const permission: MonarchPermissionDecision = {
        mode: 'allow',
        reason: leaseMatch.reason,
        risk: effectiveRisk,
        requiresUserConfirmation: false,
      };
      return {
        permission,
        decision: {
          ...decision('allow', effectiveRisk, riskVector, evidence, leaseMatch.reason, false, request),
          leaseId: leaseMatch.lease.leaseId,
        },
      };
    }
    if (request.leaseId) {
      evidence.push({ source: 'lease', code: leaseMatch.code, severity: 'warn', message: leaseMatch.reason });
    }

    if (request.proposalId
      && request.confirmed !== true
      && riskVector.effect !== 'none'
      && riskVector.effect !== 'read'
      && !hasCompatibleModelActionIntent(request.originatingUserText || '', capability.id)
      && !coderExecution) {
      const intentEvidence: MonarchPolicyEvidence = {
        source: 'provenance',
        code: 'proposal.user-intent-unproven',
        severity: 'warn',
        message: 'The current user text does not deterministically authorize this model-proposed mutation; exact confirmation is required.',
      };
      evidence.push(intentEvidence);
      return {
        permission: {
          mode: 'confirm',
          reason: intentEvidence.message,
          risk: effectiveRisk,
          requiresUserConfirmation: true,
        },
        decision: decision('confirm', effectiveRisk, riskVector, evidence, intentEvidence.message, false, request),
      };
    }

    const scopedPermissions = request.permissionProfileOverride
      ? new MonarchPermissionGate(request.permissionProfileOverride)
      : this.permissions;
    const profile = scopedPermissions.getProfile();
    const permission = isAutonomyFastPath(request, effectiveCapability, riskVector, profile)
      ? {
        mode: 'allow' as const,
        reason: 'Selected autonomy mode covers this deterministic local action.',
        risk: effectiveRisk,
        requiresUserConfirmation: false,
      }
      : scopedPermissions.evaluate(request, effectiveCapability);
    evidence.push({
      source: 'permission',
      code: `permission.${permission.mode}`,
      severity: permission.mode === 'deny' ? 'block' : permission.mode === 'confirm' ? 'warn' : 'info',
      message: permission.reason,
      ...(permission.mode === 'deny' ? { hard: true } : {}),
    });
    if (permission.mode !== 'allow') {
      return {
        permission,
        decision: decision(permission.mode, effectiveRisk, riskVector, evidence, permission.reason, false, request),
      };
    }

    const requiresSecurityReview = shouldRequestSecurityReview(request, effectiveCapability, riskVector, profile);
    evidence.push({
      source: 'runtime',
      code: requiresSecurityReview ? 'security.review.required' : 'security.fast-path.deterministic',
      severity: requiresSecurityReview ? 'info' : 'info',
      message: requiresSecurityReview
        ? 'Action needs Security evidence before the final policy verdict.'
        : 'Deterministic local action is covered by the single policy fast path.',
    });
    return {
      permission,
      decision: decision('allow', effectiveRisk, riskVector, evidence, permission.reason, requiresSecurityReview, request),
    };
  }

  finalize(preflight: MonarchPolicyPreflight, request: MonarchExecutionRequest, security?: MonarchSecurityPolicyFact): MonarchPolicyDecision {
    if (preflight.decision.outcome !== 'allow' || !preflight.decision.requiresSecurityReview || !security) {
      return preflight.decision;
    }
    const codes = security.evidenceCodes?.length ? security.evidenceCodes : [`security.${security.status}`];
    const hard = security.hard === true || codes.some(isHardSecurityEvidenceCode);
    const securityEvidence = codes.map((code): MonarchPolicyEvidence => ({
      source: 'security',
      code,
      severity: security.ok ? 'info' : security.status === 'approval_required' ? 'warn' : 'block',
      message: security.report,
      ...(hard ? { hard: true } : {}),
    }));
    const evidence = [...preflight.decision.evidence, ...securityEvidence];
    if (security.ok || security.status === 'allowed') {
      return { ...preflight.decision, evidence, reason: security.report, requiresSecurityReview: false };
    }
    if (security.status === 'approval_required') {
      if (request.confirmed) {
        return { ...preflight.decision, evidence, reason: 'Exact action confirmation satisfies the Security approval fact.', requiresSecurityReview: false };
      }
      return {
        ...preflight.decision,
        outcome: 'confirm',
        reason: security.report,
        evidence,
        requiresSecurityReview: false,
      };
    }
    if (security.status === 'blocked') {
      if (!hard && security.overrideable && request.confirmed && request.securityOverrideConfirmed) {
        return {
          ...preflight.decision,
          outcome: 'allow',
          reason: 'User overrode a non-hard Security advisory for the exact action.',
          evidence,
          requiresSecurityReview: false,
          securityOverride: true,
        };
      }
      return {
        ...preflight.decision,
        outcome: hard || !security.overrideable ? 'deny' : 'confirm',
        reason: security.report,
        evidence,
        requiresSecurityReview: false,
        ...(!hard && security.overrideable ? { securityOverride: true } : {}),
      };
    }
    return {
      ...preflight.decision,
      outcome: 'deny',
      reason: security.report || 'Security evidence is unavailable.',
      evidence,
      requiresSecurityReview: false,
    };
  }

  recordLeaseUse(decision: MonarchPolicyDecision, request: MonarchExecutionRequest): void {
    if (decision.leaseId) this.leases.recordUse(decision.leaseId, request, decision.riskVector);
  }
}

function isAutonomyFastPath(
  request: MonarchExecutionRequest,
  capability: MonarchCapability,
  riskVector: MonarchRiskVector,
  profile: MonarchPermissionProfile,
): boolean {
  if (request.moduleId === 'security') return false;
  if (request.executionMode === 'coder' && request.moduleId === 'coder') return true;
  if (riskVector.effect === 'none' || riskVector.effect === 'read') return true;
  const autonomyMode = profile.autonomyMode || normalizeAutonomyModeFromSandbox(profile.sandboxMode);
  if ((autonomyMode === 'workspace-autonomous' || autonomyMode === 'full-local')
    && SAFE_WORKSPACE_MUTATIONS.has(capability.id)
    && (riskVector.reversibility === 'reversible' || (autonomyMode === 'full-local' && riskVector.reversibility === 'compensatable'))
    && riskVector.externality === 'local'
    && riskVector.privilege === 'user'
    && riskVector.data !== 'secret') return true;
  return autonomyMode === 'full-local'
    && SAFE_FULL_LOCAL_DEVICE_ACTIONS.has(capability.id)
    && riskVector.reversibility !== 'irreversible'
    && riskVector.privilege === 'user';
}

function shouldRequestSecurityReview(
  request: MonarchExecutionRequest,
  capability: MonarchCapability,
  riskVector: MonarchRiskVector,
  profile: MonarchPermissionProfile,
): boolean {
  if (request.moduleId === 'security') return false;
  if (request.executionMode === 'coder' && request.moduleId === 'coder') return false;
  if (riskVector.effect === 'none' || riskVector.effect === 'read') return false;
  const autonomyMode = profile.autonomyMode || normalizeAutonomyModeFromSandbox(profile.sandboxMode);
  if ((autonomyMode === 'workspace-autonomous' || autonomyMode === 'full-local')
    && SAFE_WORKSPACE_MUTATIONS.has(capability.id)
    && (riskVector.reversibility === 'reversible' || (autonomyMode === 'full-local' && riskVector.reversibility === 'compensatable'))
    && riskVector.externality === 'local'
    && riskVector.privilege === 'user'
    && riskVector.data !== 'secret') return false;
  if (autonomyMode === 'full-local'
    && SAFE_FULL_LOCAL_DEVICE_ACTIONS.has(capability.id)
    && riskVector.reversibility !== 'irreversible'
    && riskVector.privilege === 'user') return false;
  return true;
}

function deterministicHardBoundary(request: MonarchExecutionRequest, risk: MonarchRiskVector): MonarchPolicyEvidence | null {
  if (risk.data === 'secret' && (risk.externality !== 'local' || risk.effect === 'network')) {
    return {
      source: 'provenance',
      code: 'data.secret.external-flow',
      severity: 'block',
      hard: true,
      message: 'Secret-like data cannot be sent to an external destination through the general agent path.',
    };
  }
  if (risk.novelty === 'arbitrary-code' && risk.privilege === 'security-control') {
    return {
      source: 'runtime',
      code: 'runtime.arbitrary-code.security-control',
      severity: 'block',
      hard: true,
      message: 'Arbitrary code cannot directly control Monarch security boundaries.',
    };
  }
  if (request.proposalHash && request.proposalHash.length !== 64) {
    return {
      source: 'provenance',
      code: 'proposal.hash.invalid',
      severity: 'block',
      hard: true,
      message: 'Typed proposal has an invalid canonical hash.',
    };
  }
  return null;
}

function decision(
  outcome: MonarchPolicyDecision['outcome'],
  risk: MonarchRisk,
  riskVector: MonarchRiskVector,
  evidence: MonarchPolicyEvidence[],
  reason: string,
  requiresSecurityReview: boolean,
  request: MonarchExecutionRequest,
): MonarchPolicyDecision {
  return {
    outcome,
    policyId: 'monarch.single-policy.v1',
    reason,
    risk,
    riskVector,
    ...(request.proposalHash ? { canonicalProposalHash: request.proposalHash } : {}),
    evidence,
    requiresSecurityReview,
  };
}

function denyPermission(risk: MonarchRisk, reason: string): MonarchPermissionDecision {
  return { mode: 'deny', reason, risk, requiresUserConfirmation: false };
}

function isHardSecurityEvidenceCode(code: string): boolean {
  return /(?:catastrophic|red-zone|drive-root|workspace-root|secret|credential|security-tamper|root-escape|symlink)/i.test(code);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeRiskVectorsConservatively(derived: MonarchRiskVector, supplied: MonarchRiskVector): MonarchRiskVector {
  return {
    effect: derived.effect,
    scope: riskier(derived.scope, supplied.scope, ['single-object', 'bounded-set', 'workspace', 'system', 'external']),
    reversibility: riskier(derived.reversibility, supplied.reversibility, ['read-only', 'reversible', 'compensatable', 'irreversible']),
    externality: riskier(derived.externality, supplied.externality, ['local', 'localhost', 'trusted-origin', 'new-origin', 'public']),
    privilege: riskier(derived.privilege, supplied.privilege, ['user', 'elevated', 'security-control']),
    data: riskier(derived.data, supplied.data, ['public', 'workspace', 'personal', 'secret']),
    novelty: riskier(derived.novelty, supplied.novelty, ['known-capability', 'new-args', 'arbitrary-code']),
  };
}

function riskier<T extends string>(left: T, right: T, order: readonly T[]): T {
  return order.indexOf(right) > order.indexOf(left) ? right : left;
}

function hasCompatibleModelActionIntent(userText: string, capabilityId: string): boolean {
  const text = userText.trim();
  if (!text) return false;
  const mutationIntent = /(?:\b(?:add|append|apply|build|change|copy|create|edit|fix|implement|make|modify|move|rename|replace|save|scaffold|update|write)\b|добав|допиш|запиш|замен|измен|исправ|обнов|реализ|созд|сдела|собер|скопир|перемест|переимен|сохран)/i;
  if (!mutationIntent.test(text)) return false;
  if (capabilityId === 'workspace.files.delete') {
    return /(?:\b(?:delete|remove)\b|удал|сотр|убер)/i.test(text);
  }
  return true;
}
