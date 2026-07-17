import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchPlan,
  MonarchPlanExecutionResult,
  MonarchPlanStep,
  MonarchRisk,
} from './contracts';
import { createHash } from 'node:crypto';
import { MonarchCapabilityRegistry } from './capability-registry';
import { MonarchModuleRegistry } from './module-registry';
import { validateAgainstSchema } from './schema-validator';
import { createMonarchId, nowIso } from './utils';
import {
  MonarchPolicyKernel,
  type MonarchPolicyRuntimeFacts,
  type MonarchSecurityPolicyFact,
} from './policy-kernel';
import { MonarchActionLedger } from './action-ledger';
import { verifyActionPredicates } from './action-verifier';
import { MonarchMutationJournal } from './mutation-journal';

export class MonarchExecutionEngine {
  constructor(
    private readonly modules: MonarchModuleRegistry,
    private readonly capabilities: MonarchCapabilityRegistry,
    private readonly policy: MonarchPolicyKernel,
    private readonly actionLedger: MonarchActionLedger,
    private readonly mutationJournal: MonarchMutationJournal,
    private readonly workspaceRoot = process.cwd(),
  ) {}

  async executePlan(
    plan: MonarchPlan,
    context: MonarchKernelContext,
    options: { requestedBy: string; confirmed?: boolean; securityOverrideConfirmed?: boolean } = { requestedBy: 'system' }
  ): Promise<MonarchPlanExecutionResult> {
    const runningPlan: MonarchPlan = {
      ...plan,
      status: 'running',
    };

    const stepResults: MonarchPlanExecutionResult['stepResults'] = [];
    await context.emit('plan.execution.started', 'execution-engine', {
      planId: runningPlan.id,
      intentId: runningPlan.intentId,
      steps: runningPlan.steps.length,
    });

    for (const step of runningPlan.steps) {
      const request = createRequestFromStep(
        runningPlan,
        step,
        options.requestedBy,
        Boolean(options.confirmed),
        Boolean(options.securityOverrideConfirmed),
      );
      const result = await this.execute(request, context);
      stepResults.push({ stepId: step.id, request, result });

      if (!result.ok) {
        const status = result.error === 'confirmation-required' ? 'blocked' : 'failed';
        const failedPlan: MonarchPlan = {
          ...runningPlan,
          status,
        };

        await context.emit(`plan.execution.${status}`, 'execution-engine', {
          planId: failedPlan.id,
          stepId: step.id,
          error: result.error,
          summary: result.summary,
        });

        const planResult: MonarchPlanExecutionResult = {
          ok: false,
          plan: failedPlan,
          stepResults,
          summary: result.summary,
        };
        if (result.error) {
          planResult.error = result.error;
        }
        return planResult;
      }
    }

    const completedPlan: MonarchPlan = {
      ...runningPlan,
      status: 'completed',
    };

    await context.emit('plan.execution.finished', 'execution-engine', {
      planId: completedPlan.id,
      steps: completedPlan.steps.length,
    });

    return {
      ok: true,
      plan: completedPlan,
      stepResults,
      summary: stepResults.at(-1)?.result.summary || completedPlan.summary,
    };
  }

  async execute(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const module = this.modules.getModule(request.moduleId);
    if (!module) {
      return {
        ok: false,
        summary: `Module is not registered: ${request.moduleId}`,
        error: 'module-not-found',
      };
    }

    const capability = this.capabilities.get(request.capabilityId);
    if (!capability || capability.moduleId !== request.moduleId) {
      return {
        ok: false,
        summary: `Capability is not registered for module ${request.moduleId}: ${request.capabilityId}`,
        error: 'capability-not-found',
      };
    }

    const validation = validateAgainstSchema(request.input, capability.inputSchema);
    if (!validation.ok) {
      await context.audit('schema', 'Capability input validation failed.', {
        requestId: request.id,
        capabilityId: request.capabilityId,
        errors: validation.errors,
      }, 'warn');

      return {
        ok: false,
        summary: `Invalid input for ${request.capabilityId}: ${validation.errors.join(' ')}`,
        error: 'invalid-input',
        metadata: { validation },
      };
    }

    const effectiveRisk = await this.resolveEffectiveRisk(module, request, capability, context);
    const preflight = this.policy.preflight(request, capability, effectiveRisk, readPolicyRuntimeFacts(context));
    const permission = preflight.permission;
    await context.emit('permission.evaluated', 'permission-gate', {
      requestId: request.id,
      intentId: request.intentId,
      moduleId: request.moduleId,
      capabilityId: request.capabilityId,
      permission,
    });
    let policyDecision = preflight.decision;
    await context.emit('policy.evaluated', 'policy-kernel', {
      requestId: request.id,
      intentId: request.intentId,
      moduleId: request.moduleId,
      capabilityId: request.capabilityId,
      decision: policyDecision,
    });

    if (policyDecision.outcome === 'deny') {
      await context.audit('permission', 'Capability execution denied.', {
        requestId: request.id,
        moduleId: request.moduleId,
        capabilityId: request.capabilityId,
        permission,
        policy: policyDecision,
      }, 'warn');

      return {
        ok: false,
        summary: `Permission denied: ${policyDecision.reason}`,
        error: 'permission-denied',
        metadata: { permission, policy: policyDecision },
      };
    }

    if (policyDecision.outcome === 'confirm') {
      await context.audit('permission', 'Capability execution requires confirmation.', {
        requestId: request.id,
        moduleId: request.moduleId,
        capabilityId: request.capabilityId,
        permission,
        policy: policyDecision,
      }, 'info');

      return {
        ok: false,
        summary: `Confirmation required: ${policyDecision.reason}`,
        error: 'confirmation-required',
        metadata: {
          permission,
          policy: policyDecision,
          ...(policyDecision.securityOverride ? { securityOverride: true } : {}),
        },
      };
    }

    if (policyDecision.requiresSecurityReview && request.moduleId !== 'security') {
      const secCheck = await this.runSecurityControllerCheck(request, context, effectiveRisk);
      policyDecision = this.policy.finalize(preflight, request, secCheck);
      if (policyDecision.securityOverride === true && policyDecision.outcome === 'allow') {
        await context.audit('security', 'User overrode a Security block for the exact confirmed request.', {
          requestId: request.id,
          moduleId: request.moduleId,
          capabilityId: request.capabilityId,
          evidenceCodes: secCheck.evidenceCodes || [],
        }, 'warn');
      }
      await context.emit('policy.evaluated', 'policy-kernel', {
        requestId: request.id,
        intentId: request.intentId,
        moduleId: request.moduleId,
        capabilityId: request.capabilityId,
        decision: policyDecision,
        final: true,
      });
      if (policyDecision.outcome !== 'allow') {
        const confirmationRequired = policyDecision.outcome === 'confirm';
        return {
          ok: false,
          summary: policyDecision.reason,
          error: confirmationRequired ? 'confirmation-required' : 'permission-denied',
          metadata: {
            permission,
            policy: policyDecision,
            securityCheck: true,
            securityOverride: policyDecision.securityOverride === true,
            passkey: secCheck.passkey,
            report: secCheck.report,
            status: secCheck.status,
          },
        };
      }
    }

    if (!module.executeCapability) {
      return {
        ok: false,
        summary: `Module ${request.moduleId} does not implement capability execution.`,
        error: 'executor-not-implemented',
      };
    }

    const preconditionObservations = await verifyActionPredicates(request.preconditions, {
      phase: 'precondition',
      workspaceRoot: this.workspaceRoot,
      ...(request.actionScope?.roots ? { allowedRoots: request.actionScope.roots } : {}),
    });
    if (preconditionObservations.length > 0) {
      await context.emit('action.preconditions.checked', 'execution-engine', {
        requestId: request.id,
        proposalId: request.proposalId,
        observations: preconditionObservations,
      });
      const failed = preconditionObservations.filter((entry) => !entry.ok);
      if (failed.length > 0) {
        return {
          ok: false,
          summary: `Action precondition failed: ${failed[0]!.message}`,
          error: 'precondition-failed',
          metadata: { permission, policy: policyDecision, observations: preconditionObservations },
        };
      }
    }

    const ledger = this.actionLedger.begin(request);
    if (ledger.status === 'replay') {
      await context.audit('execution', 'Idempotent action replay returned the recorded result.', {
        requestId: request.id,
        ledgerId: ledger.record.ledgerId,
        idempotencyKey: ledger.record.idempotencyKey,
      }, 'info');
      return {
        ...ledger.result,
        metadata: {
          ...(ledger.result.metadata || {}),
          permission,
          policy: policyDecision,
          ledger: { ledgerId: ledger.record.ledgerId, idempotentReplay: true },
        },
      };
    }
    if (ledger.status === 'conflict' || ledger.status === 'running') {
      return {
        ok: false,
        summary: ledger.status === 'conflict'
          ? 'Idempotency key belongs to a different canonical action.'
          : 'The same idempotent action is already running.',
        error: ledger.status === 'conflict' ? 'idempotency-conflict' : 'action-already-running',
        metadata: { permission, policy: policyDecision, ledger: ledger.record },
      };
    }

    const journalCapture = await this.mutationJournal.capture(ledger.record.ledgerId, request);
    if (journalCapture.supported && !journalCapture.ok) {
      const blocked: MonarchExecutionResult = {
        ok: false,
        summary: `Action was not executed because a safe rollback snapshot could not be created: ${journalCapture.error || 'unknown journal error'}`,
        error: 'rollback-snapshot-failed',
        metadata: { permission, policy: policyDecision, ledger: ledger.record },
      };
      this.actionLedger.complete(ledger.record.idempotencyKey, blocked);
      return blocked;
    }

    await context.emit('capability.execution.started', 'execution-engine', {
      requestId: request.id,
      intentId: request.intentId,
      planId: request.planId,
      moduleId: request.moduleId,
      capabilityId: request.capabilityId,
    });

    await context.audit('execution', 'Capability execution started.', {
      requestId: request.id,
      moduleId: request.moduleId,
      capabilityId: request.capabilityId,
    });

    let result: MonarchExecutionResult;
    try {
      result = await module.executeCapability(request, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        summary: `Capability execution failed for ${request.capabilityId}: ${message}`,
        error: 'capability-execution-failed',
        metadata: { thrownError: message },
      };
    }

    const rollback = await this.mutationJournal.finalize(ledger.record.ledgerId, request, result);
    if (rollback) this.actionLedger.setRollback(ledger.record.idempotencyKey, rollback);

    const verificationObservations = await verifyActionPredicates(request.verification, {
      phase: 'verification',
      workspaceRoot: this.workspaceRoot,
      ...(request.actionScope?.roots ? { allowedRoots: request.actionScope.roots } : {}),
      result,
    });
    if (verificationObservations.length > 0) {
      await context.emit('action.verification.checked', 'execution-engine', {
        requestId: request.id,
        proposalId: request.proposalId,
        observations: verificationObservations,
      });
    }
    const failedVerification = verificationObservations.filter((entry) => !entry.ok);
    const verifiedResult: MonarchExecutionResult = result.ok && failedVerification.length > 0
      ? {
        ...result,
        ok: false,
        summary: `Action completed but verification failed: ${failedVerification[0]!.message}`,
        error: 'verification-failed',
      }
      : result;
    const resultWithPolicy: MonarchExecutionResult = {
      ...verifiedResult,
      metadata: {
        ...(verifiedResult.metadata || {}),
        permission,
        policy: policyDecision,
        ledger: {
          ledgerId: ledger.record.ledgerId,
          idempotencyKey: ledger.record.idempotencyKey,
          ...(rollback ? { rollback } : {}),
        },
        ...(policyDecision.leaseId ? { leaseId: policyDecision.leaseId } : {}),
        ...(preconditionObservations.length || verificationObservations.length
          ? { observations: [...preconditionObservations, ...verificationObservations] }
          : {}),
      },
    };
    this.actionLedger.complete(ledger.record.idempotencyKey, resultWithPolicy);
    this.policy.recordLeaseUse(policyDecision, request);

    await context.emit('capability.execution.finished', 'execution-engine', {
      requestId: request.id,
      intentId: request.intentId,
      planId: request.planId,
      moduleId: request.moduleId,
      capabilityId: request.capabilityId,
      ok: resultWithPolicy.ok,
      summary: resultWithPolicy.summary,
      error: resultWithPolicy.error,
    });

    await context.audit('execution', 'Capability execution finished.', {
      requestId: request.id,
      moduleId: request.moduleId,
      capabilityId: request.capabilityId,
      ok: resultWithPolicy.ok,
      summary: resultWithPolicy.summary,
      error: resultWithPolicy.error,
      policy: policyDecision,
      ledgerId: ledger.record.ledgerId,
    }, resultWithPolicy.error === 'capability-execution-failed' ? 'error' : resultWithPolicy.ok ? 'info' : 'warn');

    return resultWithPolicy;
  }

  private async resolveEffectiveRisk(
    module: NonNullable<ReturnType<MonarchModuleRegistry['getModule']>>,
    request: MonarchExecutionRequest,
    capability: NonNullable<ReturnType<MonarchCapabilityRegistry['get']>>,
    context: MonarchKernelContext
  ): Promise<MonarchRisk> {
    if (!module.resolveCapabilityRisk) {
      return capability.risk;
    }

    try {
      const resolved = await module.resolveCapabilityRisk(request, capability, context);
      if (isMonarchRisk(resolved)) {
        return resolved;
      }
    } catch (error) {
      await context.audit('permission', 'Capability dynamic risk resolver failed.', {
        requestId: request.id,
        moduleId: request.moduleId,
        capabilityId: request.capabilityId,
        fallbackRisk: 'security-sensitive',
        error: error instanceof Error ? error.message : String(error),
      }, 'error');
      return 'security-sensitive';
    }

    return capability.risk;
  }

  private async runSecurityControllerCheck(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    actionRisk: MonarchRisk
  ): Promise<MonarchSecurityPolicyFact & { passkey?: string }> {
    if (isLowRiskConversationOrStatus(request, actionRisk)) {
      return {
        ok: true,
        status: 'fast_path_read',
        report: 'Read-only chat/status action allowed without LLM activity-controller roundtrip.',
      };
    }

    if (isSecurityControllerDisabledByProfile(context)) {
      return {
        ok: true,
        status: 'profile_off',
        report: 'Security controller is disabled by the explicit user profile.',
      };
    }

    const modules = context.listModules();
    const hasSecurity = modules.some((m) => m.manifest.id === 'security' && m.status === 'active');
    if (!hasSecurity) {
      if (request.requestedBy === 'system' || request.requestedBy === 'smoke' || process.env.MONARCH_SMOKE_TEST === '1' || (request.capabilityId === 'workspace.module.load' && (request.input as any)?.id === 'security')) {
        return { ok: true, status: 'skipped', report: 'Security module not active. Allowing system/boot/smoke operations.' };
      }
      if (canProceedWithoutSecurityController(actionRisk)) {
        await context.audit('security', 'Security controller unavailable; low-risk action allowed in degraded mode.', {
          requestId: request.id,
          moduleId: request.moduleId,
          capabilityId: request.capabilityId,
          actionRisk,
        }, 'warn');
        return {
          ok: true,
          status: 'degraded_allow',
          report: 'Security module is not active; low-risk action allowed in degraded mode.',
        };
      }
      return { 
        ok: false, 
        status: 'blocked', 
        report: 'КРИТИЧЕСКАЯ ОШИБКА: Модуль безопасности (Monarch Security) отключен или не отвечает. В целях безопасности выполнение любых действий заблокировано.' 
      };
    }

    let intentText = request.originatingUserText || '';
    const events = context.listEvents();
    const intentEvent = events.find((e) => e.type === 'intent.received' && (e.payload as any)?.intentId === request.intentId)
      || events.slice().reverse().find((e) => e.type === 'intent.received');
    if (!intentText && intentEvent) {
      intentText = (intentEvent.payload as any).originatingUserText
        || (intentEvent.payload as any).text
        || '';
    }
    const modelProposed = Boolean(request.proposalId || (intentEvent && (intentEvent.payload as any).modelProposed === true));

    try {
      const checkResult = await context.execute({
        id: createMonarchId('exec_sec_check'),
        intentId: request.intentId,
        moduleId: 'security',
        capabilityId: 'security.controller.check',
        input: {
          intentText,
          actionModule: request.moduleId,
          actionCapability: request.capabilityId,
          actionInput: JSON.stringify(actionInputForSecurityCheck(request.input)),
          actionRisk,
          requestedBy: request.requestedBy,
          monarchConfirmed: request.confirmed === true,
          modelProposed,
          passkey: (request.input as any)?.passkey || '',
          noLlm: !shouldUseSecurityLlmReview(request, actionRisk),
        },
        createdAt: nowIso(),
        requestedBy: 'system',
        confirmed: true,
      });

      if (checkResult.ok && checkResult.output) {
        const payload = (checkResult.output as { payload?: unknown }).payload;
        if (isSecurityControllerPayload(payload)) {
          const evidenceCodes = payload.evidenceCodes || [];
          const hard = evidenceCodes.some(isHardSecurityEvidenceCode);
          const ret: MonarchSecurityPolicyFact & { passkey?: string } = {
            ok: payload.ok,
            status: payload.status,
            report: payload.report,
            evidenceCodes,
            hard,
            overrideable: payload.status === 'blocked' && !hard,
          };
          if (payload.passkey) {
            ret.passkey = payload.passkey;
          }
          return ret;
        }
      }
      return this.securityControllerFailureResult(
        request,
        context,
        actionRisk,
        'Monarch Security controller returned an invalid response.'
      );
    } catch (error) {
      return this.securityControllerFailureResult(
        request,
        context,
        actionRisk,
        `Monarch Security controller check failed: ${error}`
      );
    }
  }

  private async securityControllerFailureResult(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    actionRisk: MonarchRisk,
    report: string
  ): Promise<MonarchSecurityPolicyFact> {
    if (canProceedWithoutSecurityController(actionRisk)) {
      await context.audit('security', 'Security controller failed; low-risk action allowed in degraded mode.', {
        requestId: request.id,
        moduleId: request.moduleId,
        capabilityId: request.capabilityId,
        actionRisk,
        report,
      }, 'warn');
      return {
        ok: true,
        status: 'degraded_allow',
        report: `${report} Low-risk action allowed in degraded mode.`,
      };
    }

    return {
      ok: false,
      status: 'security_check_failed',
      report: `${report} Action blocked.`,
    };
  }
}

interface SecurityControllerPayload {
  ok: boolean;
  status: string;
  report: string;
  passkey?: string;
  evidenceCodes?: string[];
}

function isSecurityControllerPayload(value: unknown): value is SecurityControllerPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.ok !== 'boolean') {
    return false;
  }
  if (typeof payload.status !== 'string' || !payload.status.trim()) {
    return false;
  }
  if (typeof payload.report !== 'string') {
    return false;
  }
  if (payload.passkey !== undefined && typeof payload.passkey !== 'string') return false;
  return payload.evidenceCodes === undefined
    || (Array.isArray(payload.evidenceCodes) && payload.evidenceCodes.every((entry) => typeof entry === 'string'));
}

function shouldUseSecurityLlmReview(request: MonarchExecutionRequest, risk: MonarchRisk): boolean {
  if (process.env.MONARCH_SECURITY_LLM_REVIEW !== '1') return false;
  return risk === 'security-sensitive'
    || risk === 'identity'
    || risk === 'money'
    || request.riskVector?.externality === 'new-origin'
    || request.riskVector?.novelty === 'arbitrary-code';
}

function isHardSecurityEvidenceCode(code: string): boolean {
  return /(?:catastrophic|red-zone|drive-root|workspace-root|secret|credential|security-tamper|root-escape|symlink)/i.test(code);
}

function actionInputForSecurityCheck(input: unknown): unknown {
  return redactActionInputForSecurityCheck(input);
}

function redactActionInputForSecurityCheck(input: unknown, key = '', depth = 0): unknown {
  if (depth > 8) {
    return '[depth-limit]';
  }
  if (typeof input === 'string') {
    if (isOpaquePayloadKey(key) || looksLikeLargeBase64(input)) {
      return opaquePayloadSummary(key, input);
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 100).map((entry) => redactActionInputForSecurityCheck(entry, key, depth + 1));
  }
  if (!input || typeof input !== 'object') {
    return input ?? {};
  }

  const copy: Record<string, unknown> = {};
  for (const [entryKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (/^(passkey|pin|newPin|currentPin|confirmation|recoveryCode|recovery_code)$/i.test(entryKey)) {
      continue;
    }
    copy[entryKey] = redactActionInputForSecurityCheck(value, entryKey, depth + 1);
  }
  return copy;
}

function isOpaquePayloadKey(key: string): boolean {
  return /^(audio|image|video|file)?base64$/i.test(key)
    || /(?:audio|image|video|blob|data)Base64$/i.test(key);
}

function looksLikeLargeBase64(value: string): boolean {
  const text = value.trim();
  return text.length > 16_000
    && text.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function opaquePayloadSummary(key: string, value: string): Record<string, unknown> {
  const text = value.trim();
  return {
    redacted: true,
    kind: key || 'opaque-base64-payload',
    chars: text.length,
    approxBytes: estimateBase64Bytes(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function canProceedWithoutSecurityController(risk: MonarchRisk): boolean {
  return risk === 'none' || risk === 'read';
}

function isSecurityControllerDisabledByProfile(context: MonarchKernelContext): boolean {
  const events = context.listEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.source !== 'security'
      || (event.type !== 'security.activated' && event.type !== 'security.profile.changed')) {
      continue;
    }
    const payload = event.payload && typeof event.payload === 'object'
      ? event.payload as Record<string, unknown>
      : {};
    const level = typeof payload.level === 'string'
      ? payload.level
      : typeof payload.securityLevel === 'string'
        ? payload.securityLevel
        : '';
    if (level) {
      return level === 'off';
    }
  }
  return false;
}

function readPolicyRuntimeFacts(context: MonarchKernelContext): MonarchPolicyRuntimeFacts {
  const events = context.listEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.source !== 'security'
      || (event.type !== 'security.activated' && event.type !== 'security.model_policy.changed')) {
      continue;
    }
    const payload = event.payload && typeof event.payload === 'object'
      ? event.payload as Record<string, unknown>
      : {};
    const facts: MonarchPolicyRuntimeFacts = {};
    if (typeof payload.modelCommandsEnabled === 'boolean') facts.modelCommandsEnabled = payload.modelCommandsEnabled;
    if (typeof payload.enabled === 'boolean') facts.modelCommandsEnabled = payload.enabled;
    if (payload.modelConfirmationMode === 'adaptive' || payload.modelConfirmationMode === 'always') {
      facts.modelConfirmationMode = payload.modelConfirmationMode;
    }
    if (payload.confirmationMode === 'adaptive' || payload.confirmationMode === 'always') {
      facts.modelConfirmationMode = payload.confirmationMode;
    }
    return facts;
  }
  return {};
}

function isLowRiskConversationOrStatus(
  request: MonarchExecutionRequest,
  risk: MonarchRisk
): boolean {
  if (isTrustedDeterministicVoiceControl(request, risk)) {
    return true;
  }
  if (risk !== 'none' && risk !== 'read') {
    return false;
  }

  if (request.moduleId === 'assistant') {
    return true;
  }
  if (request.moduleId === 'oscar') {
    return /^(oscar\.chat\.|oscar\.voice\.fast$|oscar\.status$|oscar\.memory\.search$)/.test(request.capabilityId);
  }
  if (request.moduleId === 'voice') {
    return /^(voice\.status|voice\.transcribe\.(?:audio|stream\.(?:start|push|finish|cancel))|voice\.mode\.(?:classify|prepare|respond|execute-scripted|session\.(?:start|complete|close)))$/.test(request.capabilityId);
  }
  if (request.moduleId === 'models') {
    return /status|list|catalog|runtime/i.test(request.capabilityId);
  }
  return false;
}

function isTrustedDeterministicVoiceControl(
  request: MonarchExecutionRequest,
  risk: MonarchRisk,
): boolean {
  if (risk !== 'execute'
    || request.moduleId !== 'voice'
    || request.capabilityId !== 'voice.mode.execute-scripted'
    || request.requestedBy !== 'ui:voice-mode') {
    return false;
  }
  const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
    ? request.input as Record<string, unknown>
    : {};
  const keys = Object.keys(input);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  return keys.length === 1
    && keys[0] === 'text'
    && text.length > 0
    && text.length <= 1200;
}

function isMonarchRisk(value: unknown): value is MonarchRisk {
  return typeof value === 'string' && [
    'none',
    'read',
    'write',
    'delete',
    'execute',
    'network',
    'device-control',
    'money',
    'identity',
    'security-sensitive',
  ].includes(value);
}

function createRequestFromStep(
  plan: MonarchPlan,
  step: MonarchPlanStep,
  requestedBy: string,
  confirmed: boolean,
  securityOverrideConfirmed: boolean,
): MonarchExecutionRequest {
  return {
    id: createMonarchId('exec'),
    intentId: plan.intentId,
    planId: plan.id,
    stepId: step.id,
    moduleId: step.moduleId,
    capabilityId: step.capabilityId,
    input: step.input,
    createdAt: nowIso(),
    requestedBy,
    confirmed,
    securityOverrideConfirmed,
  };
}
