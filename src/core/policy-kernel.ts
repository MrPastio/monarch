import type {
  MonarchCapability,
  MonarchExecutionRequest,
  MonarchPermissionDecision,
  MonarchPermissionProfile,
  MonarchPolicyDecision,
  MonarchPolicyEvidence,
  MonarchRisk,
  MonarchRiskVector,
  MonarchAuthorityContext,
  MonarchAuthorityTier,
  MonarchActionGuardReaction,
  MonarchAgentSecurityMode,
  MonarchOwnerUnrestrictedOverride,
  AgentDangerAssessmentV1,
  MonarchAgentDangerResponse,
} from './contracts';
import { createHash } from 'node:crypto';
import { MONARCH_PUBLIC_AUTHORITY_CONTEXT } from './contracts';
import {
  deriveRiskVector,
  extractActionPaths,
  isModelOwnedExecutionProposal,
  normalizeAutonomyModeFromSandbox,
} from './action-protocol';
import { MonarchCapabilityLeaseStore } from './capability-leases';
import { MonarchPermissionGate } from './permission-gate';
import { assessAgentDanger, dangerResponseForMode } from './agent-danger-assessment';
import { evaluateFilesystemAccess, type MonarchFilesystemOperation } from './filesystem-policy';

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
  'device.browser.open',
  'device.volume.get',
  'device.volume.set',
  'device.brightness.get',
  'device.brightness.set',
  'device.media.control',
]);

// These actions are already constrained to one fresh exact-window
// observation, one short input lease, and one native input atom. Full Local
// may therefore pass them to Action Guard without forcing a confirmation
// before Security has evaluated the exact action. Guided/Auto stay unchanged.
const ACTION_GUARDED_FULL_LOCAL_COMPUTER_ACTIONS = new Set([
  'computer.window.click',
  'computer.window.close',
  'computer.window.type',
  'computer.window.key',
  'computer.window.scroll',
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
  disposition: MonarchSecurityDisposition;
}

export type MonarchSecurityDisposition = 'hard-deny' | 'owner-confirmable' | 'informational';

export interface MonarchPolicyRuntimeFacts {
  modelCommandsEnabled?: boolean;
  actionGuardReaction?: MonarchActionGuardReaction;
  agentSecurityMode?: MonarchAgentSecurityMode;
  ownerOverride?: MonarchOwnerUnrestrictedOverride;
  /** Backward-compatible runtime fact emitted by older Security builds. */
  modelConfirmationMode?: 'adaptive' | 'always';
}

export interface MonarchLocalSettingsPolicyInput {
  source: 'desktop' | 'api' | 'voice' | 'telegram' | 'coder';
  command: string;
  scope: {
    type: 'chat' | 'coder-project';
    projectId?: string;
  };
  payload: unknown;
}

export interface MonarchLocalSettingsPolicyDecision {
  outcome: 'allow' | 'deny';
  reason: string;
  policyDecisionHash: string;
}

const LOCAL_SETTINGS_COMMANDS = new Set([
  'memory.create',
  'memory.update',
  'memory.delete',
  'memory.restore',
  'memory.cross-chat.set',
  'profile.update',
  'personality.profile.create',
  'personality.profile.update',
  'personality.profile.select',
  'personality.personalization.set',
  'personality.scope.copy',
  'voice.update',
  'voice.preset.create',
  'voice.preset.update',
  'voice.preset.delete',
  'voice.pronunciation.create',
  'voice.pronunciation.update',
  'voice.pronunciation.delete',
  'prompts.update',
  'prompts.reset',
  'prompts.reset-all',
  'dev.update',
  'dev.reset',
  'owner-override.update',
  'owner-override.reset',
  'skill.create',
]);

const PROTECTED_SETTINGS_KEYS = new Set([
  'authority',
  'authoritytier',
  'approvalpolicy',
  'permissionprofile',
  'securityoverrideconfirmed',
  'securityoverride',
  'entitlement',
  'deviceprivatekey',
  'credential',
  'credentials',
  'secret',
  'secrets',
  'safepath',
  'monarchsafe',
]);

export class MonarchPolicyKernel {
  constructor(
    private readonly permissions: MonarchPermissionGate,
    readonly leases: MonarchCapabilityLeaseStore,
    private readonly authority: MonarchAuthorityContext = MONARCH_PUBLIC_AUTHORITY_CONTEXT,
    private readonly workspaceRoot = process.cwd(),
  ) {}

  /**
   * Settings are local data, not capabilities and not model-proposed actions.
   * They still cross the same policy trust boundary so renderer/API input can
   * never mutate authority, permissions, Security state, credentials, or Safe.
   */
  evaluateLocalSettingsCommand(input: MonarchLocalSettingsPolicyInput): MonarchLocalSettingsPolicyDecision {
    let outcome: MonarchLocalSettingsPolicyDecision['outcome'] = 'allow';
    let reason = 'Exact Desktop settings command is limited to local context data.';
    if (input.source !== 'desktop') {
      outcome = 'deny';
      reason = 'Local settings commands are available only to an attested Desktop session.';
    } else if (!LOCAL_SETTINGS_COMMANDS.has(input.command)) {
      outcome = 'deny';
      reason = 'Unknown local settings command.';
    } else if (input.command.startsWith('owner-override.')
      && (this.authority.tier !== 'owner' || this.authority.source !== 'signed-device-entitlement')) {
      outcome = 'deny';
      reason = 'Owner Unrestricted Override requires a verified signed local Owner entitlement.';
    } else if (
      (input.command.startsWith('prompts.') || input.command.startsWith('dev.'))
      && (this.authority.tier !== 'owner' || this.authority.source !== 'signed-device-entitlement')
    ) {
      outcome = 'deny';
      reason = 'Oscar DEV settings require a verified signed owner entitlement.';
    } else if (input.scope.type === 'coder-project' && !input.scope.projectId?.trim()) {
      outcome = 'deny';
      reason = 'Coder settings require an exact project id.';
    } else if (input.scope.type === 'chat' && input.scope.projectId) {
      outcome = 'deny';
      reason = 'Chat settings cannot carry a Coder project id.';
    } else if (!input.command.startsWith('owner-override.') && containsProtectedSettingsKey(input.payload)) {
      outcome = 'deny';
      reason = 'Settings payload attempts to mutate a protected authority boundary.';
    }
    const policyDecisionHash = createHash('sha256')
      .update(stablePolicyJson({
        schemaVersion: 1,
        outcome,
        reason,
        source: input.source,
        command: input.command,
        scope: input.scope,
        payload: input.payload,
      }))
      .digest('hex');
    return { outcome, reason, policyDecisionHash };
  }

  getEffectivePermissionProfile(request: MonarchExecutionRequest): MonarchPermissionProfile {
    const profile = request.permissionProfileOverride
      ? new MonarchPermissionGate(request.permissionProfileOverride).getProfile()
      : this.permissions.getProfile();
    if (this.authorityTierForRequest(request) === 'owner'
      && profile.sandboxMode === 'danger-full-access'
      && profile.approvalPolicy === 'never') {
      return { ...profile, autonomyMode: 'full-local', approvalPolicy: 'on-request' };
    }
    return profile;
  }

  authorityTierForRequest(request: MonarchExecutionRequest): MonarchAuthorityTier {
    return this.authority.tier === 'owner' && (request.source === 'desktop' || request.source === 'coder')
      ? 'owner'
      : 'public';
  }

  approvalBindingMatches(request: MonarchExecutionRequest, policy: MonarchPolicyDecision): boolean {
    const carriesPolicyBinding = Boolean(
      request.approvalPolicyDecisionHash
      || request.approvalPurpose
      || request.authorityTierAtApproval,
    );
    if (!carriesPolicyBinding) return request.securityOverrideConfirmed !== true;
    if (!request.approvalPolicyDecisionHash || !request.approvalPurpose || !request.authorityTierAtApproval) return false;
    if (request.approvalPolicyDecisionHash !== policy.policyDecisionHash) return false;
    if (request.authorityTierAtApproval !== policy.authorityTier) return false;
    if (request.approvalPurpose === 'owner-security-override') {
      return policy.authorityTier === 'owner' && policy.securityOverride === true;
    }
    return request.approvalPurpose === 'policy';
  }

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
    const profile = this.getEffectivePermissionProfile(request);
    const authorityTier = this.authorityTierForRequest(request);
    const modelOwnedProposal = isModelOwnedExecutionProposal(request);
    // Agent Runtime always uses the adaptive danger policy. A persisted
    // Security mode wins when present; otherwise Full Access defaults to
    // Observe and narrower profiles default to Guard. Falling back to the
    // legacy irreversible-action gate here would silently rebuild the old
    // approval wall whenever Security has not emitted its startup event yet.
    const adaptiveDangerPolicy = runtimeFacts.agentSecurityMode !== undefined
      || request.executionMode === 'agent-runtime';
    const agentSecurityMode = runtimeAgentSecurityMode(runtimeFacts, profile);
    const dangerAssessment = assessAgentDanger({
      request,
      risk: effectiveRisk,
      riskVector,
      ...(request.source ? { source: request.source } : {}),
    });
    const ownerOverrideActive = isOwnerOverrideActive(runtimeFacts.ownerOverride, request, authorityTier);
    const baselineDangerResponse = dangerResponseForMode(agentSecurityMode, dangerAssessment.dangerProbability);
    const ownerShellPolicy = request.capabilityId === 'system.shell.run'
      ? runtimeFacts.ownerOverride?.shellApprovalPolicy || 'always'
      : null;
    let dangerResponse = baselineDangerResponse;
    if ((dangerResponse === 'confirm' || dangerResponse === 'block') && ownerOverrideActive) {
      // Shell keeps an independent Owner policy. `risk-based` converts even a
      // critical stop into an exact action-card; `never` is the explicit local
      // choice that suppresses the card. The response stays stable after an
      // approval so its durable policy hash cannot drift.
      dangerResponse = ownerShellPolicy === 'risk-based' ? 'confirm' : 'owner-override';
    }
    const dangerContext = { assessment: dangerAssessment, response: dangerResponse };
    const requiresSecurityReview = adaptiveDangerPolicy
      ? dangerResponse === 'enhanced-readback'
      : shouldRequestSecurityReview(request, effectiveCapability, riskVector, profile);
    const evidence: MonarchPolicyEvidence[] = [];
    const makeDecision = (
      outcome: MonarchPolicyDecision['outcome'],
      reason: string,
      securityReview: boolean,
    ) => decision(
      outcome,
      effectiveRisk,
      riskVector,
      evidence,
      reason,
      securityReview,
      request,
      authorityTier,
      undefined,
      dangerContext,
      ownerOverrideActive,
    );
    if (request.proposalId) {
      evidence.push({
        source: 'provenance',
        code: 'proposal.typed.canonicalized',
        severity: 'info',
        message: `Typed action proposal ${request.proposalId} was normalized before policy evaluation.`,
      });
    }

    const hardBoundary = deterministicHardBoundary(request, riskVector, {
      profile,
      ownerOverrideActive,
      workspaceRoot: this.workspaceRoot,
    });
    if (hardBoundary) {
      evidence.push(hardBoundary);
      return {
        permission: denyPermission(effectiveRisk, hardBoundary.message),
        decision: makeDecision('deny', hardBoundary.message, false),
      };
    }

    const coderExecution = request.executionMode === 'coder' && request.moduleId === 'coder';
    if (modelOwnedProposal && runtimeFacts.modelCommandsEnabled === false && !coderExecution) {
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
        decision: makeDecision('deny', modelPolicyBlock.message, false),
      };
    }

    const dangerGoverned = modelOwnedProposal || request.executionMode === 'agent-runtime';
    if (dangerGoverned && request.capabilityId === 'system.shell.run') {
      const shellPolicy = ownerOverrideActive
        ? ownerShellPolicy || 'always'
        : 'always';
      if (shellPolicy === 'always' && request.confirmed !== true) {
        const shellEvidence: MonarchPolicyEvidence = {
          source: 'security',
          code: 'shell.exact-action-card.required',
          severity: 'warn',
          message: 'Every shell invocation requires an exact action-card under the current Owner shell policy.',
        };
        evidence.push(shellEvidence);
        return {
          permission: {
            mode: 'confirm',
            reason: shellEvidence.message,
            risk: effectiveRisk,
            requiresUserConfirmation: true,
          },
          decision: makeDecision('confirm', shellEvidence.message, false),
        };
      }
    }
    if (dangerGoverned && adaptiveDangerPolicy && dangerResponse === 'block') {
      const blocked: MonarchPolicyEvidence = {
        source: 'security',
        code: 'danger-score.stop',
        severity: 'block',
        message: `Security stopped a ${dangerAssessment.dangerProbability}% danger action. Owner Unrestricted Override is required.`,
      };
      evidence.push(blocked);
      return {
        permission: denyPermission(effectiveRisk, blocked.message),
        decision: makeDecision('deny', blocked.message, false),
      };
    }
    if (dangerGoverned && adaptiveDangerPolicy && dangerResponse === 'confirm' && request.confirmed !== true) {
      const confirmation: MonarchPolicyEvidence = {
        source: 'security',
        code: 'danger-score.exact-action-card',
        severity: 'warn',
        message: `Security requires an exact action-card for a ${dangerAssessment.dangerProbability}% danger action.`,
      };
      evidence.push(confirmation);
      return {
        permission: {
          mode: 'confirm',
          reason: confirmation.message,
          risk: effectiveRisk,
          requiresUserConfirmation: true,
        },
        decision: makeDecision('confirm', confirmation.message, false),
      };
    }
    evidence.push({
      source: 'security',
      code: `danger-score.${dangerResponse}`,
      severity: dangerResponse === 'enhanced-readback' ? 'warn' : 'info',
      message: `Local danger assessment: ${dangerAssessment.dangerProbability}% (${dangerAssessment.band}); response ${dangerResponse}.`,
    });
    const actionGuardReaction = runtimeActionGuardReaction(runtimeFacts);
    if (!adaptiveDangerPolicy && modelOwnedProposal && actionGuardReaction === 'confirm-all' && !coderExecution) {
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
          decision: makeDecision('confirm', modelPolicyEvidence.message, requiresSecurityReview),
        };
      }
    }

    if (!adaptiveDangerPolicy && (Boolean(request.proposalId) || request.moduleId === 'workspace')
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
        decision: makeDecision('confirm', irreversibleEvidence.message, requiresSecurityReview),
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
          ...makeDecision('allow', leaseMatch.reason, false),
          leaseId: leaseMatch.lease.leaseId,
        },
      };
    }
    if (request.leaseId) {
      evidence.push({ source: 'lease', code: leaseMatch.code, severity: 'warn', message: leaseMatch.reason });
    }

    if (modelOwnedProposal
      && request.confirmed !== true
      && riskVector.effect !== 'none'
      && riskVector.effect !== 'read'
      && !hasCompatibleModelActionIntent(request.originatingUserText || '', capability.id)
      && !ownerOverrideActive
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
        decision: makeDecision('confirm', intentEvidence.message, requiresSecurityReview),
      };
    }

    const scopedPermissions = new MonarchPermissionGate(profile);
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
        decision: makeDecision(permission.mode, permission.reason, permission.mode === 'confirm' && requiresSecurityReview),
      };
    }

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
      decision: makeDecision('allow', permission.reason, requiresSecurityReview),
    };
  }

  finalize(preflight: MonarchPolicyPreflight, request: MonarchExecutionRequest, security?: MonarchSecurityPolicyFact): MonarchPolicyDecision {
    if (!preflight.decision.requiresSecurityReview || !security) {
      return preflight.decision;
    }
    const codes = security.evidenceCodes?.length ? security.evidenceCodes : [`security.${security.status}`];
    const hard = security.disposition === 'hard-deny';
    const securityEvidence = codes.map((code): MonarchPolicyEvidence => ({
      source: 'security',
      code,
      severity: security.ok ? 'info' : security.status === 'approval_required' ? 'warn' : 'block',
      message: security.report,
      ...(hard ? { hard: true } : {}),
    }));
    const evidence = [...preflight.decision.evidence, ...securityEvidence];
    const authorityTier = this.authorityTierForRequest(request);
    const finalized = (
      outcome: MonarchPolicyDecision['outcome'],
      reason: string,
      securityOverride = false,
    ): MonarchPolicyDecision => ({
      ...decision(
        outcome,
        preflight.decision.risk,
        preflight.decision.riskVector,
        evidence,
        reason,
        false,
        request,
        authorityTier,
        security,
        preflight.decision.dangerAssessment && preflight.decision.dangerResponse
          ? { assessment: preflight.decision.dangerAssessment, response: preflight.decision.dangerResponse }
          : undefined,
        preflight.decision.ownerUnrestrictedOverride === true,
      ),
      ...(preflight.decision.leaseId ? { leaseId: preflight.decision.leaseId } : {}),
      ...(securityOverride ? { securityOverride: true } : {}),
    });

    if (hard) {
      return finalized('deny', security.report || 'Security reported a hard boundary.');
    }
    if (security.ok || security.status === 'allowed') {
      return finalized(preflight.decision.outcome, preflight.decision.outcome === 'allow'
        ? security.report
        : preflight.decision.reason);
    }
    if (security.status === 'approval_required') {
      if (request.confirmed) {
        return finalized('allow', 'Exact action confirmation satisfies the Security approval fact.');
      }
      return finalized('confirm', security.report);
    }
    if (security.status === 'blocked') {
      if (security.disposition === 'owner-confirmable' && authorityTier === 'owner') {
        if (request.confirmed && request.securityOverrideConfirmed) {
          return finalized('allow', 'Owner confirmed a non-hard Security advisory for the exact action.', true);
        }
        return finalized('confirm', security.report, true);
      }
      return finalized('deny', security.report);
    }
    return finalized('deny', security.report || 'Security evidence is unavailable.');
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
  if (autonomyMode === 'full-local'
    && request.executionMode === 'agent-runtime'
    && riskVector.privilege !== 'security-control'
    && !(riskVector.data === 'secret' && riskVector.externality !== 'local')) return true;
  if ((autonomyMode === 'workspace-autonomous' || autonomyMode === 'full-local')
    && SAFE_WORKSPACE_MUTATIONS.has(capability.id)
    && (riskVector.reversibility === 'reversible' || (autonomyMode === 'full-local' && riskVector.reversibility === 'compensatable'))
    && riskVector.externality === 'local'
    && riskVector.privilege === 'user'
    && riskVector.data !== 'secret') return true;
  if ((autonomyMode === 'workspace-autonomous' || autonomyMode === 'full-local')
    && request.executionMode === 'agent-runtime'
    && capability.id === 'device.app.open'
    && riskVector.reversibility !== 'irreversible'
    && riskVector.externality === 'local') return true;
  if (autonomyMode === 'full-local'
    && ACTION_GUARDED_FULL_LOCAL_COMPUTER_ACTIONS.has(capability.id)
    && request.executionMode === 'agent-runtime'
    && riskVector.reversibility !== 'irreversible'
    && riskVector.externality === 'local'
    && hasExactComputerUseBinding(request.input)) return true;
  return autonomyMode === 'full-local'
    && SAFE_FULL_LOCAL_DEVICE_ACTIONS.has(capability.id)
    && riskVector.reversibility !== 'irreversible'
    && riskVector.privilege === 'user';
}

function hasExactComputerUseBinding(value: unknown): boolean {
  const input = asRecord(value);
  return typeof input.windowRef === 'string'
    && /^hwnd:[0-9a-f]{8,16}$/iu.test(input.windowRef)
    && typeof input.observationId === 'string'
    && /^computer-observation-[0-9a-z-]{8,160}$/iu.test(input.observationId);
}

function shouldRequestSecurityReview(
  request: MonarchExecutionRequest,
  capability: MonarchCapability,
  riskVector: MonarchRiskVector,
  profile: MonarchPermissionProfile,
): boolean {
  if (request.moduleId === 'security') return false;
  if (riskVector.effect === 'none' || riskVector.effect === 'read') return false;
  // Every model-owned effect crosses the Action Guard. Autonomy determines
  // whether an ordinary action needs confirmation; it never disables exact
  // action observation or deterministic hard-boundary checks.
  // Coder project lifecycle calls (create/import/activate) are direct,
  // controller-owned Kernel requests. Model-selected Coder actions always
  // carry a proposal id and still cross Action Guard below.
  if (request.proposalId || request.executionMode === 'agent-runtime') {
    return true;
  }
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

function deterministicHardBoundary(
  request: MonarchExecutionRequest,
  risk: MonarchRiskVector,
  filesystem: {
    profile: MonarchPermissionProfile;
    ownerOverrideActive: boolean;
    workspaceRoot: string;
  },
): MonarchPolicyEvidence | null {
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
  const filesystemBoundary = deterministicFilesystemBoundary(request, risk, filesystem);
  if (filesystemBoundary) return filesystemBoundary;
  return null;
}

function deterministicFilesystemBoundary(
  request: MonarchExecutionRequest,
  risk: MonarchRiskVector,
  options: {
    profile: MonarchPermissionProfile;
    ownerOverrideActive: boolean;
    workspaceRoot: string;
  },
): MonarchPolicyEvidence | null {
  if (request.executionMode !== 'agent-runtime') return null;
  if (request.moduleId !== 'workspace' && !request.capabilityId.startsWith('workspace.files.')) return null;
  const paths = extractActionPaths(asRecord(request.input));
  if (paths.length === 0) return null;
  const operation = filesystemOperationForCapability(request.capabilityId, risk.effect);
  for (const candidate of paths) {
    const access = evaluateFilesystemAccess(candidate, operation, {
      workspaceRoot: options.workspaceRoot,
      sandboxRoot: options.workspaceRoot,
      fallbackRoot: options.workspaceRoot,
      ...(request.actionScope?.roots?.length ? { allowedRoots: request.actionScope.roots } : {}),
      // This Kernel layer owns immutable red zones. The concrete Workspace
      // provider remains authoritative for its richer user-root/read-only
      // profile and reports its established filesystem-policy error contract.
      allowFullDiskAccess: true,
      includeDefaultRedZones: !options.ownerOverrideActive,
      protectWorkspaceInternals: !options.ownerOverrideActive,
      allowRoot: operation === 'read' || operation === 'list' || operation === 'search',
    });
    if (access.allowed) continue;
    return {
      source: 'runtime',
      code: `filesystem.${access.reason}`,
      severity: 'block',
      hard: true,
      message: access.message,
    };
  }
  return null;
}

function filesystemOperationForCapability(
  capabilityId: string,
  effect: MonarchRiskVector['effect'],
): MonarchFilesystemOperation {
  if (/\.(?:delete|trash)$/u.test(capabilityId) || effect === 'delete') return 'delete';
  if (/\.move$/u.test(capabilityId)) return 'move';
  if (/\.rename$/u.test(capabilityId)) return 'rename';
  if (/\.append$/u.test(capabilityId)) return 'append';
  if (/\.mkdir$/u.test(capabilityId)) return 'mkdir';
  if (/\.copy$/u.test(capabilityId)) return 'write';
  if (effect === 'none' || effect === 'read') return 'read';
  return 'write';
}

function decision(
  outcome: MonarchPolicyDecision['outcome'],
  risk: MonarchRisk,
  riskVector: MonarchRiskVector,
  evidence: MonarchPolicyEvidence[],
  reason: string,
  requiresSecurityReview: boolean,
  request: MonarchExecutionRequest,
  authorityTier: MonarchAuthorityTier,
  security?: MonarchSecurityPolicyFact,
  danger?: { assessment: AgentDangerAssessmentV1; response: MonarchAgentDangerResponse },
  ownerUnrestrictedOverride = false,
): MonarchPolicyDecision {
  const policyId = 'monarch.single-policy.v2';
  const policyDecisionHash = createHash('sha256').update(stableJson({
    policyId,
    capabilityId: request.capabilityId,
    source: request.source || 'unknown',
    canonicalProposalHash: request.proposalHash || null,
    riskVector,
    authorityTier,
    security: security && security.disposition !== 'informational'
      ? {
        disposition: security.disposition,
        status: security.status,
        evidenceCodes: [...(security.evidenceCodes || [])].sort(),
      }
      : null,
    danger: danger ? {
      probability: danger.assessment.dangerProbability,
      confidence: danger.assessment.assessmentConfidence,
      response: danger.response,
    } : null,
    ownerUnrestrictedOverride,
  }), 'utf8').digest('hex');
  return {
    outcome,
    policyId,
    reason,
    risk,
    riskVector,
    ...(request.proposalHash ? { canonicalProposalHash: request.proposalHash } : {}),
    evidence,
    requiresSecurityReview,
    ...(danger ? { dangerAssessment: danger.assessment, dangerResponse: danger.response } : {}),
    ...(ownerUnrestrictedOverride ? { ownerUnrestrictedOverride: true } : {}),
    authorityTier,
    policyDecisionHash,
  };
}

function containsProtectedSettingsKey(value: unknown, depth = 0): boolean {
  if (depth > 12 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => containsProtectedSettingsKey(entry, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) => (
    PROTECTED_SETTINGS_KEYS.has(key.replace(/[^a-z]/gi, '').toLowerCase())
    || containsProtectedSettingsKey(entry, depth + 1)
  ));
}

function stablePolicyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stablePolicyJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stablePolicyJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function denyPermission(risk: MonarchRisk, reason: string): MonarchPermissionDecision {
  return { mode: 'deny', reason, risk, requiresUserConfirmation: false };
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
  if (capabilityId === 'computer.window.click') {
    return /(?:\b(?:click|press|select|choose)\b|нажм|клик|выбер)/i.test(text);
  }
  if (capabilityId === 'computer.window.close') {
    return /(?:\b(?:close|quit|exit)\b|закрой|закрыть|выключ)/i.test(text);
  }
  if (capabilityId === 'computer.window.type') {
    return /(?:\b(?:type|enter|write|input)\b|введ|напечат|набери|запиш)/i.test(text);
  }
  if (capabilityId === 'computer.window.key') {
    return /(?:\b(?:press|shortcut|key)\b|нажм|клавиш|сочетан)/i.test(text);
  }
  if (capabilityId === 'computer.window.scroll') {
    return /(?:\b(?:scroll|wheel)\b|прокрут|листай|колес)/i.test(text);
  }
  if (capabilityId === 'workspace.files.delete' || capabilityId === 'workspace.files.trash') {
    return /(?:\b(?:delete|remove|trash)\b|удал|сотр|убер|корзин)/i.test(text);
  }
  if (capabilityId === 'device.app.open' || capabilityId === 'device.browser.open') {
    return /(?:\b(?:open|launch|start|browse)\b|открой|открыть|запуст|перейд|зайди|покажи)/i.test(text);
  }
  if (capabilityId === 'device.volume.set') {
    return /(?:\b(?:set|change|raise|lower|mute|unmute)\b|постав|установ|измен|прибав|убав|выключ|включ).{0,80}(?:volume|sound|громк|звук)/i.test(text);
  }
  if (capabilityId === 'device.brightness.set') {
    return /(?:\b(?:set|change|raise|lower)\b|постав|установ|измен|прибав|убав).{0,80}(?:brightness|яркост)/i.test(text);
  }
  if (capabilityId === 'device.browser.close-active') {
    return /(?:\b(?:close|quit|exit)\b|закрой|закрыть|выключ).{0,80}(?:browser|браузер)/i.test(text);
  }
  if (capabilityId === 'device.recycle-bin.empty') {
    return /(?:\b(?:empty|clear)\b|очист|опустош).{0,80}(?:recycle|корзин)/i.test(text);
  }
  const mutationIntent = /(?:\b(?:add|append|apply|build|change|copy|create|edit|fix|implement|make|modify|move|rename|replace|save|scaffold|update|write)\b|добав|допиш|запиш|замен|измен|исправ|обнов|реализ|созд|сдела|собер|скопир|перемест|переимен|сохран)/i;
  if (!mutationIntent.test(text)) return false;
  return true;
}

function runtimeActionGuardReaction(facts: MonarchPolicyRuntimeFacts): MonarchActionGuardReaction {
  if (facts.actionGuardReaction === 'observe'
    || facts.actionGuardReaction === 'guard'
    || facts.actionGuardReaction === 'confirm-all') {
    return facts.actionGuardReaction;
  }
  return facts.modelConfirmationMode === 'always' ? 'confirm-all' : 'guard';
}

function runtimeAgentSecurityMode(
  facts: MonarchPolicyRuntimeFacts,
  profile: MonarchPermissionProfile,
): MonarchAgentSecurityMode {
  if (facts.agentSecurityMode === 'off'
    || facts.agentSecurityMode === 'observe'
    || facts.agentSecurityMode === 'guard'
    || facts.agentSecurityMode === 'strict') return facts.agentSecurityMode;
  if (facts.actionGuardReaction === 'observe') return 'observe';
  if (facts.actionGuardReaction === 'confirm-all') return 'strict';
  if (facts.actionGuardReaction === 'guard') return 'guard';
  return (profile.autonomyMode || normalizeAutonomyModeFromSandbox(profile.sandboxMode)) === 'full-local'
    ? 'observe'
    : 'guard';
}

function isOwnerOverrideActive(
  override: MonarchOwnerUnrestrictedOverride | undefined,
  request: MonarchExecutionRequest,
  authorityTier: MonarchAuthorityTier,
): boolean {
  if (!override?.enabled || authorityTier !== 'owner') return false;
  if (request.source !== 'desktop' && request.source !== 'coder') return false;
  if (override.lifetime !== 'task') return true;
  const taskId = request.requestedBy.startsWith('agent:') ? request.requestedBy.slice('agent:'.length) : '';
  return Boolean(taskId && override.taskId === taskId);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
