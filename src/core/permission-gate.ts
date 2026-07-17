import type {
  MonarchCapability,
  MonarchExecutionRequest,
  MonarchPermissionDecision,
  MonarchPermissionMode,
  MonarchPermissionProfile,
  MonarchSandboxMode,
  MonarchApprovalPolicy,
  MonarchAutonomyMode,
  MonarchRisk,
} from './contracts';

export interface MonarchPermissionRule {
  risk: MonarchRisk;
  mode: MonarchPermissionMode;
  reason: string;
}

export const DEFAULT_PERMISSION_PROFILE: MonarchPermissionProfile = {
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  autonomyMode: 'workspace-autonomous',
};

export class MonarchPermissionGate {
  private profile: MonarchPermissionProfile;

  constructor(profile: MonarchPermissionProfile = DEFAULT_PERMISSION_PROFILE) {
    this.profile = normalizePermissionProfile(profile);
  }

  getProfile(): MonarchPermissionProfile {
    return { ...this.profile };
  }

  setProfile(profile: MonarchPermissionProfile): MonarchPermissionProfile {
    this.profile = normalizePermissionProfile(profile);
    return this.getProfile();
  }

  evaluate(
    request: MonarchExecutionRequest,
    capability: MonarchCapability | undefined
  ): MonarchPermissionDecision {
    const risk = capability?.risk || 'security-sensitive';
    if (isInternalSecurityControllerCheck(request, capability)) {
      return {
        mode: 'allow',
        reason: 'Internal Security controller review requested by the execution engine.',
        risk,
        requiresUserConfirmation: false,
      };
    }
    const rule = permissionRuleFor(this.profile.sandboxMode, risk);

    if (request.confirmed && rule.mode === 'confirm') {
      if (this.profile.approvalPolicy === 'never') {
        return {
          mode: 'deny',
          reason: `Approval policy is never; escalation was not granted. ${rule.reason}`,
          risk,
          requiresUserConfirmation: false,
        };
      }
      return {
        mode: 'allow',
        reason: `Confirmed by requester. Original policy: ${rule.reason}`,
        risk,
        requiresUserConfirmation: false,
      };
    }

    if (rule.mode === 'confirm' && this.profile.approvalPolicy === 'never') {
      return {
        mode: 'deny',
        reason: `Approval policy is never; Monarch cannot request escalation. ${rule.reason}`,
        risk,
        requiresUserConfirmation: false,
      };
    }

    return {
      mode: rule.mode,
      reason: rule.reason,
      risk,
      requiresUserConfirmation: rule.mode === 'confirm',
    };
  }
}

function isInternalSecurityControllerCheck(
  request: MonarchExecutionRequest,
  capability: MonarchCapability | undefined
): boolean {
  return request.moduleId === 'security'
    && request.capabilityId === 'security.controller.check'
    && capability?.moduleId === 'security'
    && capability.id === 'security.controller.check'
    && request.requestedBy === 'system'
    && request.confirmed === true;
}

function permissionRuleFor(
  sandboxMode: MonarchSandboxMode,
  risk: MonarchRisk
): MonarchPermissionRule {
  if (risk === 'none') return { risk, mode: 'allow', reason: 'No real-world effect.' };
  if (risk === 'read') return { risk, mode: 'allow', reason: 'Read-only action.' };
  if (risk === 'money') return { risk, mode: 'deny', reason: 'Money movement is blocked until a dedicated policy exists.' };
  if (risk === 'security-sensitive') return { risk, mode: 'deny', reason: 'Security-sensitive action is blocked by default.' };

  if (sandboxMode === 'read-only') {
    return {
      risk,
      mode: 'confirm',
      reason: `${risk} is outside the read-only sandbox and needs one-time approval.`,
    };
  }

  if (sandboxMode === 'workspace-write') {
    if (risk === 'write') {
      return { risk, mode: 'allow', reason: 'Workspace writes are allowed in Auto mode.' };
    }
    if (risk === 'execute') {
      return { risk, mode: 'confirm', reason: 'Executable or dynamic tool actions need approval.' };
    }
    if (risk === 'network') {
      return { risk, mode: 'confirm', reason: 'Network access is outside the default local sandbox.' };
    }
    return { risk, mode: 'confirm', reason: `${risk} requires explicit approval in Auto mode.` };
  }

  if (risk === 'delete' || risk === 'device-control' || risk === 'identity') {
    return { risk, mode: 'confirm', reason: `Destructive or sensitive ${risk} actions always require approval.` };
  }
  return { risk, mode: 'allow', reason: `${risk} is allowed by Full Access mode.` };
}

function normalizePermissionProfile(profile: MonarchPermissionProfile): MonarchPermissionProfile {
  const sandboxModes: MonarchSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
  const approvalPolicies: MonarchApprovalPolicy[] = ['on-request', 'never'];
  const autonomyModes: MonarchAutonomyMode[] = ['guided', 'workspace-autonomous', 'full-local'];
  const autonomyMode = autonomyModes.includes(profile.autonomyMode as MonarchAutonomyMode)
    ? profile.autonomyMode as MonarchAutonomyMode
    : profile.sandboxMode === 'read-only'
      ? 'guided'
      : profile.sandboxMode === 'danger-full-access'
        ? 'full-local'
        : 'workspace-autonomous';
  const sandboxMode = profile.autonomyMode
    ? autonomyMode === 'guided'
      ? 'read-only'
      : autonomyMode === 'full-local'
        ? 'danger-full-access'
        : 'workspace-write'
    : sandboxModes.includes(profile.sandboxMode)
      ? profile.sandboxMode
      : DEFAULT_PERMISSION_PROFILE.sandboxMode;
  return {
    sandboxMode,
    approvalPolicy: approvalPolicies.includes(profile.approvalPolicy)
      ? profile.approvalPolicy
      : DEFAULT_PERMISSION_PROFILE.approvalPolicy,
    autonomyMode,
  };
}
