import type {
  MonarchCapability,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRisk,
  MonarchRouteDecision,
} from '../../core';
import path from 'node:path';
import {
  firstJson,
  lastJson,
  SecurityClient,
  type SecurityCommandResult,
} from './client';
import { securityManifest } from './manifest';
import {
  AgentActionGuard,
  type AgentGuardDecision,
  type AgentGuardSnapshot,
} from './agent-guard';

type SensorId = 'network' | 'devices' | 'persistence' | 'posture';
type SecurityLevel = 'off' | 'minimal' | 'balanced' | 'strict' | 'maximum';
type ModelConfirmationMode = 'adaptive' | 'always';

export class SecurityModule implements MonarchModule {
  readonly manifest = securityManifest;
  private readonly client: SecurityClient;
  private readonly agentGuard: AgentActionGuard;
  private securityLevel: SecurityLevel = 'balanced';
  private modelCommandsEnabled = true;
  private modelConfirmationMode: ModelConfirmationMode = 'adaptive';

  constructor(
    client = new SecurityClient(),
    agentGuard = new AgentActionGuard(path.dirname(client.config.projectRoot)),
  ) {
    this.client = client;
    this.agentGuard = agentGuard;
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    if (this.client.available) {
      try {
        const profile = firstJson(await this.client.profile());
        this.securityLevel = readSecurityLevel(profile) || 'balanced';
      } catch {
        this.securityLevel = 'balanced';
      }
      try {
        const policy = firstJson(await this.client.modelPolicy());
        const parsed = readModelCommandPolicy(policy);
        this.modelCommandsEnabled = parsed.enabled;
        this.modelConfirmationMode = parsed.confirmationMode;
      } catch {
        this.modelCommandsEnabled = true;
        this.modelConfirmationMode = 'adaptive';
      }
    }
    await context.emit('security.activated', this.manifest.id, {
      projectRoot: this.client.config.projectRoot,
      configPath: this.client.config.configPath,
      pythonPath: this.client.config.pythonPath,
      available: this.client.available,
      securityLevel: this.securityLevel,
      modelCommandsEnabled: this.modelCommandsEnabled,
      modelConfirmationMode: this.modelConfirmationMode,
    });
  }

  async health(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    if (!this.client.available) {
      return {
        ok: false,
        summary: 'Monarch Security runtime is not available.',
        error: 'security-runtime-missing',
        output: this.client.config,
      };
    }

    try {
      const status = await this.client.status();
      const payload = withAgentGuard(firstJson(status), this.agentGuard.snapshot());
      await context.emit('security.status.checked', this.manifest.id, {
        running: readNestedBoolean(payload, 'running'),
      });
      return commandResult(
        status,
        'Monarch Security protector status checked.',
        payload,
        { projectRoot: this.client.config.projectRoot }
      );
    } catch (error) {
      return securityRuntimeError(error);
    }
  }

  async deactivate(context: MonarchKernelContext): Promise<void> {
    const running = this.client.backgroundBenchmarkStatus();
    this.client.dispose();
    if (running?.status === 'running') {
      await context.emit('security.benchmark.cancelled', this.manifest.id, {
        jobId: running.jobId,
        reason: 'module-deactivated',
      });
    }
  }

  resolveCapabilityRisk(
    request: MonarchExecutionRequest,
    capability: MonarchCapability
  ): MonarchRisk | undefined {
    if (capability.id === 'security.deep_scan.file' && readBooleanInput(request.input, 'defender', false)) {
      return 'execute';
    }
    return capability.risk;
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.trim();
    const lower = text.toLowerCase();
    if (!mentionsSecurity(lower)) {
      return null;
    }

    if (/(oscar|llm|модел).*(command|команд)|(?:command|команд).*(oscar|llm|модел)/i.test(lower)) {
      const requestsChange = /(set|change|enable|disable|always|adaptive|установ|измен|включ|отключ|всегда|адаптив)/i.test(lower);
      if (requestsChange) {
        return {
          intentId: intent.id,
          targetModuleId: this.manifest.id,
          capabilityId: 'security.model_policy.set',
          confidence: 0.98,
          reason: 'User asks to change Oscar command security policy.',
          permissionMode: 'confirm',
          input: {
            enabled: !/(disable|off|отключ|выключ)/i.test(lower),
            confirmationMode: /(always|всегда|кажд)/i.test(lower) ? 'always' : 'adaptive',
          },
        };
      }
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.model_policy.get',
        confidence: 0.96,
        reason: 'User asks to read Oscar command security policy.',
        permissionMode: 'allow',
        input: {},
      };
    }

    if (/(profile|level|strictness|режим|уров|строгост)/i.test(lower)) {
      const level = extractSecurityLevel(lower);
      if (level && /(set|change|switch|установ|постав|измен|переключ)/i.test(lower)) {
        return {
          intentId: intent.id,
          targetModuleId: this.manifest.id,
          capabilityId: 'security.profile.set',
          confidence: 0.98,
          reason: 'User asks to change Monarch Security strictness.',
          permissionMode: 'confirm',
          input: { level },
        };
      }
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.profile.get',
        confidence: 0.96,
        reason: 'User asks to read Monarch Security strictness.',
        permissionMode: 'allow',
        input: {},
      };
    }

    if (/(start|enable|turn on|запусти|включи|активируй).*(protect|security|защит|безопас)/i.test(lower)
      || /(protect|security|защит|безопас).*(start|enable|запусти|включи|активируй)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.protection.start',
        confidence: 0.94,
        reason: 'User asks to start Monarch Security background protection.',
        permissionMode: 'confirm',
        input: { noLlm: true },
      };
    }

    if (/(stop|disable|turn off|останови|выключи).*(protect|security|защит|безопас)/i.test(lower)
      || /(protect|security|защит|безопас).*(stop|disable|останови|выключи)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.protection.stop',
        confidence: 0.94,
        reason: 'User asks to stop Monarch Security background protection.',
        permissionMode: 'confirm',
        input: { waitSeconds: 10 },
      };
    }

    if (/(live|realistic|реалист|как реальн|реальн.*угроз)/i.test(lower)
      && /(simulation|simulate|имитац|симуляц|сымитир)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.threat.simulation.live',
        confidence: 0.97,
        reason: 'User explicitly asks for a safe realistic threat simulation through the production incident pipeline.',
        permissionMode: 'confirm',
        input: {},
      };
    }

    if (/(attack|evasion|симуляц|атак)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.attack.simulation',
        confidence: 0.92,
        reason: 'User asks to run the inert security attack simulation.',
        permissionMode: 'confirm',
        input: { withLlm: false },
      };
    }

    if (/(verify protection|self.?test|самопровер|провер.*защит)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.verify.protection',
        confidence: 0.9,
        reason: 'User asks to run the protection verification lab.',
        permissionMode: 'confirm',
        input: { withLlm: false },
      };
    }

    if (/(baseline|норм|базов)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.baseline.preview',
        confidence: 0.88,
        reason: 'User asks about a security baseline; preview is required before digest-bound approval.',
        permissionMode: 'allow',
        input: { scope: extractBaselineScope(lower) },
      };
    }

    if (/(integrity|hmac|целост)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.integrity.verify',
        confidence: 0.9,
        reason: 'User asks to verify security audit/state integrity.',
        permissionMode: 'allow',
        input: {},
      };
    }

    if (/(incident|threat|alert|инцидент|угроз|предупрежден)/i.test(lower)
      && /(list|show|status|read|покаж|список|статус|прочит|какие)/i.test(lower)) {
      return {
        intentId: intent.id, targetModuleId: this.manifest.id,
        capabilityId: 'security.incidents.list', confidence: 0.94,
        reason: 'User asks Oscar to inspect durable Security incidents.',
        permissionMode: 'allow', input: { limit: 20 },
      };
    }

    if (/(quarantine|карантин)/i.test(lower) && /(list|show|status|read|покаж|список|статус|прочит|что)/i.test(lower)) {
      return {
        intentId: intent.id, targetModuleId: this.manifest.id,
        capabilityId: 'security.quarantine.list', confidence: 0.94,
        reason: 'User asks Oscar to inspect Security quarantine.',
        permissionMode: 'allow', input: {},
      };
    }

    if (/(network center|network security|сетев.*центр|сетев.*безопас|подключен|соединен)/i.test(lower)
      && /(show|status|inspect|покаж|статус|проверь|какие)/i.test(lower)) {
      return {
        intentId: intent.id, targetModuleId: this.manifest.id,
        capabilityId: 'security.network.center', confidence: 0.93,
        reason: 'User asks Oscar to inspect the Security Network Center.',
        permissionMode: 'allow', input: { limit: 100 },
      };
    }

    if (/(emergency|lockdown|экстрен|аварийн|блокиров)/i.test(lower) && /(status|show|покаж|статус|состояни)/i.test(lower)) {
      return {
        intentId: intent.id, targetModuleId: this.manifest.id,
        capabilityId: 'security.emergency.status', confidence: 0.93,
        reason: 'User asks Oscar to inspect emergency Security state.',
        permissionMode: 'allow', input: {},
      };
    }

    if (/(pin|парол|код.*безопас)/i.test(lower) && /(status|configured|настро|статус|состояни|установлен)/i.test(lower)) {
      return {
        intentId: intent.id, targetModuleId: this.manifest.id,
        capabilityId: 'security.pin.status', confidence: 0.93,
        reason: 'User asks Oscar to inspect Security PIN state without exposing the secret.',
        permissionMode: 'allow', input: {},
      };
    }

    if (/(benchmark|бенчмарк|нагрузк.*защит|ресурс.*защит)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.benchmark.start',
        confidence: 0.9,
        reason: 'User asks to measure background protection resource usage.',
        permissionMode: 'confirm',
        input: { durationSeconds: 300, intervalSeconds: 0.5 },
      };
    }

    if (/(report|отчет|отчёт|summary|сводк)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.report.generate',
        confidence: 0.9,
        reason: 'User asks to generate a Monarch Security report.',
        permissionMode: 'allow',
        input: { noLlm: true, summaryOnly: true, includeFiles: false, includeInstalls: false, fileLimit: 100 },
      };
    }

    if (/(process|processes|процесс)/i.test(lower)
      && /(audit|check|scan|security|аудит|проверь|провер|скан|безопас)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.scan.system',
        confidence: 0.99,
        reason: 'User asks Oscar for a real safety audit of current processes through Monarch Security.',
        permissionMode: 'allow',
        input: {
          summaryOnly: false,
          includeFiles: false,
          includeInstalls: false,
          fileLimit: 100,
          noLlm: true,
        },
      };
    }

    if (/(audit|logs?|лог|аудит)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.audit.tail',
        confidence: 0.88,
        reason: 'User asks to read recent Monarch Security audit records.',
        permissionMode: 'allow',
        input: { lines: 20 },
      };
    }

    if (/(diagnose|diagnostic|settings|runtime|диагност|настрой)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.diagnose',
        confidence: 0.9,
        reason: 'User asks to diagnose Monarch Security runtime.',
        permissionMode: 'allow',
        input: {},
      };
    }

    if (/(deep|глубок)/i.test(lower) && /(file|path|файл|путь)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.deep_scan.file',
        confidence: 0.88,
        reason: 'User asks for a deep security scan of a file.',
        permissionMode: 'allow',
        input: {
          path: extractPath(text),
          defender: /(defender|защитник)/i.test(lower),
          noLlm: true,
        },
      };
    }

    if (/(file|folder|path|файл|папк|путь)/i.test(lower) && /(scan|check|проверь|скан)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.scan.path',
        confidence: 0.86,
        reason: 'User asks to scan a file or folder path.',
        permissionMode: 'allow',
        input: {
          path: extractPath(text),
          recursive: /(recursive|рекурс)/i.test(lower),
          limit: 250,
          noLlm: true,
        },
      };
    }

    const sensor = extractSensor(lower);
    if (sensor) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: `security.scan.${sensor}`,
        confidence: 0.86,
        reason: `User asks to scan security ${sensor}.`,
        permissionMode: 'allow',
        input: { noLlm: true },
      };
    }

    if (/(scan|check|проверь|скан)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'security.scan.system',
        confidence: 0.86,
        reason: 'User asks to run a Monarch Security system scan.',
        permissionMode: 'allow',
        input: {
          summaryOnly: true,
          includeFiles: false,
          includeInstalls: false,
          fileLimit: 100,
          noLlm: true,
        },
      };
    }

    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'security.status',
      confidence: 0.84,
      reason: 'User asks about Monarch Security or protection status.',
      permissionMode: 'allow',
      input: {},
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    try {
      switch (request.capabilityId) {
      case 'security.status':
        return this.status(context);
      case 'security.profile.get':
        return this.getSecurityProfile(context);
      case 'security.profile.set':
        return this.setSecurityProfile(request.input, context);
      case 'security.model_policy.get':
        return this.getModelCommandPolicy(context);
      case 'security.model_policy.set':
        return this.setModelCommandPolicy(request.input, context);
      case 'security.incidents.list':
        return this.listIncidents(request.input, context);
      case 'security.incident.status':
        return this.updateIncident(request.input, context);
      case 'security.quarantine.list':
        return this.listQuarantine(context);
      case 'security.quarantine.isolate':
        return this.isolateFile(request.input, context);
      case 'security.quarantine.restore':
        return this.restoreQuarantine(request.input, context);
      case 'security.responses.list':
        return this.listResponses(request.input, context);
      case 'security.response.propose':
        return this.proposeResponse(request.input, context);
      case 'security.response.evaluate':
        return this.evaluateResponse(request.input, context);
      case 'security.response.approve':
        return this.approveResponse(request.input, context);
      case 'security.response.actions':
        return this.listResponseActions(context);
      case 'security.response.service.status':
        return this.responseServiceStatus(context);
      case 'security.emergency.status':
        return this.emergencyStatus(context);
      case 'security.emergency.resolve':
        return this.resolveEmergency(request.input, context);
      case 'security.pin.status':
        return this.pinStatus(context);
      case 'security.pin.set':
        return this.setPin(request.input, context);
      case 'security.pin.verify':
        return this.verifyPin(request.input, context);
      case 'security.pin.recover':
        return this.recoverPin(request.input, context);
      case 'security.diagnose':
        return this.diagnose();
      case 'security.audit.tail':
        return this.tailAudit(request.input, context);
      case 'security.integrity.verify':
        return this.verifyIntegrity(context);
      case 'security.scan.system':
        return this.scanSystem(request.input, context);
      case 'security.report.generate':
        return this.generateReport(request.input, context);
      case 'security.scan.network':
        return this.scanSensor('network', request.input, context);
      case 'security.network.center':
        return this.networkCenter(request.input, context);
      case 'security.network.profile.trust':
        return this.setNetworkProfileTrust(request.input, context);
      case 'security.scan.devices':
        return this.scanSensor('devices', request.input, context);
      case 'security.scan.persistence':
        return this.scanSensor('persistence', request.input, context);
      case 'security.scan.posture':
        return this.scanSensor('posture', request.input, context);
      case 'security.scan.path':
        return this.scanPath(request.input, context);
      case 'security.deep_scan.file':
        return this.deepScanFile(request.input, context);
      case 'security.protection.start':
        return this.startProtection(request.input, context);
      case 'security.protection.stop':
        return this.stopProtection(request.input, context);
      case 'security.baseline.write':
        return this.writeBaseline(request.input, context);
      case 'security.baseline.preview':
        return this.previewBaseline(context);
      case 'security.verify.protection':
        return this.verifyProtection(request.input, context);
      case 'security.attack.simulation':
        return this.attackSimulation(request.input, context);
      case 'security.threat.simulation.live':
        return this.liveThreatSimulation(context);
      case 'security.benchmark.start':
        return this.startBenchmark(request.input, context);
      case 'security.benchmark.status':
        return this.benchmarkStatus(context);
      case 'security.benchmark.cancel':
        return this.cancelBenchmark(request.input, context);
      case 'security.notification.test':
        return this.testNotification(context);
      case 'security.controller.check':
        return this.checkControllerAction(request.input, context);
      case 'security.controller.block':
        return this.blockControllerAction(request.input, context);
      default:
        return {
          ok: false,
          summary: `Unsupported security capability: ${request.capabilityId}`,
          error: 'unsupported-capability',
        };
      }
    } catch (error) {
      return securityRuntimeError(error);
    }
  }

  private async status(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.status();
    const payload = withAgentGuard(firstJson(result), this.agentGuard.snapshot());
    await context.emit('security.status.checked', this.manifest.id, {
      running: readNestedBoolean(payload, 'running'),
    });
    return commandResult(result, securityStatusSummary(payload), payload, this.runtimeMetadata());
  }

  private async getSecurityProfile(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.profile();
    const payload = firstJson(result);
    this.securityLevel = readSecurityLevel(payload) || 'balanced';
    await context.emit('security.profile.changed', this.manifest.id, { level: this.securityLevel, readOnly: true });
    return commandResult(result, 'Security strictness profile loaded.', payload, this.runtimeMetadata());
  }

  private async setSecurityProfile(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const level = readStringInput(input, 'level') as SecurityLevel;
    if (!['off', 'minimal', 'balanced', 'strict', 'maximum'].includes(level)) {
      return { ok: false, summary: 'Unsupported Security strictness level.', error: 'invalid-security-level' };
    }
    const result = await this.client.setProfile(level);
    if (!result.ok) return commandResult(result, 'Security profile update failed.', firstJson(result), this.runtimeMetadata());
    this.securityLevel = level;
    const payload = firstJson(result);
    const restarted = readNestedBoolean(payload, 'restarted');
    await context.emit('security.profile.changed', this.manifest.id, { level, restarted });
    await context.audit('security', 'Security strictness profile changed by user.', { level, restarted }, 'warn');
    return commandResult(result, `Security strictness changed to ${level}.`, payload, this.runtimeMetadata());
  }

  private async getModelCommandPolicy(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.modelPolicy();
    const payload = firstJson(result);
    const policy = readModelCommandPolicy(payload);
    this.modelCommandsEnabled = policy.enabled;
    this.modelConfirmationMode = policy.confirmationMode;
    await context.emit('security.model_policy.changed', this.manifest.id, { ...policy, readOnly: true });
    return commandResult(result, 'Oscar command security policy loaded.', payload, this.runtimeMetadata());
  }

  private async setModelCommandPolicy(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const enabled = readBooleanInput(input, 'enabled', true);
    const confirmationMode = readStringInput(input, 'confirmationMode') as ModelConfirmationMode;
    if (!['adaptive', 'always'].includes(confirmationMode)) {
      return { ok: false, summary: 'Unsupported model command confirmation mode.', error: 'invalid-model-policy' };
    }
    const result = await this.client.setModelPolicy({ enabled, confirmationMode });
    const payload = firstJson(result);
    if (!result.ok) return commandResult(result, 'Oscar command security policy update failed.', payload, this.runtimeMetadata());
    this.modelCommandsEnabled = enabled;
    this.modelConfirmationMode = confirmationMode;
    await context.emit('security.model_policy.changed', this.manifest.id, { enabled, confirmationMode });
    await context.audit('security', 'Oscar command security policy changed by user.', { enabled, confirmationMode }, 'warn');
    return commandResult(result, 'Oscar command security policy changed.', payload, this.runtimeMetadata());
  }

  private async listIncidents(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const limit = readNumberInput(input, 'limit', 50, 1, 1000);
    const result = await this.client.incidents(limit);
    const payload = firstJson(result);
    const incidentCount = Array.isArray(
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>).incidents
        : undefined
    )
      ? ((payload as Record<string, unknown>).incidents as unknown[]).length
      : 0;
    await context.emit('security.incidents.read', this.manifest.id, {
      requestedLimit: limit,
      incidents: incidentCount,
    });
    return commandResult(
      result,
      incidentCount === 1
        ? 'Loaded 1 Monarch Security incident.'
        : `Loaded ${incidentCount} Monarch Security incidents.`,
      payload,
      this.runtimeMetadata()
    );
  }

  private async updateIncident(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const incidentId = readStringInput(input, 'incidentId');
    const status = readStringInput(input, 'status');
    if (!incidentId || !['acknowledged', 'resolved', 'dismissed'].includes(status)) {
      return { ok: false, summary: 'Incident update requires id and a supported status.', error: 'invalid-incident-update' };
    }
    const result = await this.client.updateIncident({
      incidentId,
      status: status as 'acknowledged' | 'resolved' | 'dismissed',
      reason: readStringInput(input, 'reason') || 'User updated incident status',
    });
    const payload = firstJson(result);
    await context.emit('security.incident.changed', this.manifest.id, { incidentId, status });
    return commandResult(result, `Security incident marked ${status}.`, payload, this.runtimeMetadata());
  }

  private async listQuarantine(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.listQuarantine();
    const payload = firstJson(result);
    const count = Array.isArray(
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>).records
        : undefined
    )
      ? ((payload as Record<string, unknown>).records as unknown[]).length
      : 0;
    await context.emit('security.quarantine.read', this.manifest.id, { records: count });
    return commandResult(result, `Loaded ${count} active quarantine record${count === 1 ? '' : 's'}.`, payload, this.runtimeMetadata());
  }

  private async isolateFile(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const targetPath = readStringInput(input, 'path');
    if (!targetPath) {
      return { ok: false, summary: 'Quarantine isolation requires path.', error: 'missing-path' };
    }
    const incidentId = readStringInput(input, 'incidentId');
    const isolateInput: { targetPath: string; incidentId?: string } = { targetPath };
    if (incidentId) isolateInput.incidentId = incidentId;
    const result = await this.client.isolateFile(isolateInput);
    const payload = firstJson(result);
    await context.emit('security.quarantine.changed', this.manifest.id, { action: 'isolate', ok: result.ok });
    return commandResult(result, 'File moved into Monarch Security quarantine.', payload, this.runtimeMetadata());
  }

  private async restoreQuarantine(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const quarantineId = readStringInput(input, 'quarantineId');
    if (!quarantineId) {
      return { ok: false, summary: 'Quarantine restore requires record id.', error: 'missing-quarantine-id' };
    }
    const destination = readStringInput(input, 'destination');
    const restoreInput: { quarantineId: string; destination?: string } = { quarantineId };
    if (destination) restoreInput.destination = destination;
    const result = await this.client.restoreQuarantine(restoreInput);
    const payload = firstJson(result);
    await context.emit('security.quarantine.changed', this.manifest.id, { action: 'restore', ok: result.ok });
    return commandResult(result, 'File restored from Monarch Security quarantine.', payload, this.runtimeMetadata());
  }

  private async listResponses(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const limit = readNumberInput(input, 'limit', 50, 1, 1000);
    const result = await this.client.listResponses(limit);
    const payload = firstJson(result);
    await context.emit('security.responses.read', this.manifest.id, { mode: 'shadow' });
    return commandResult(result, 'Loaded shadow response proposals.', payload, this.runtimeMetadata());
  }

  private async proposeResponse(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const incidentId = readStringInput(input, 'incidentId');
    const action = readStringInput(input, 'action');
    const scope = readObjectInput(input, 'scope');
    if (!incidentId || !action || !scope) {
      return { ok: false, summary: 'Response proposal requires incidentId, action, and bounded scope.', error: 'invalid-response-proposal' };
    }
    const result = await this.client.proposeResponse({
      incidentId,
      action,
      scope,
      rationale: readStringArrayInput(input, 'rationale'),
      proposedBy: readResponseProposalSource(input),
      ttlSeconds: readNumberInput(input, 'ttlSeconds', 300, 30, 3600),
    });
    const payload = firstJson(result);
    await context.emit('security.response.proposed', this.manifest.id, { incidentId, action, mode: 'shadow' });
    return commandResult(result, 'Response proposal validated in shadow mode; no system action executed.', payload, this.runtimeMetadata());
  }

  private async evaluateResponse(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const proposalId = readStringInput(input, 'proposalId');
    if (!proposalId) {
      return { ok: false, summary: 'Response evaluation requires proposalId.', error: 'missing-proposal-id' };
    }
    const result = await this.client.evaluateResponse(proposalId);
    const payload = firstJson(result);
    await context.emit('security.response.evaluated', this.manifest.id, { proposalId, mode: 'shadow' });
    return commandResult(result, 'Response proposal evaluated in shadow mode.', payload, this.runtimeMetadata());
  }

  private async approveResponse(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const proposalId = readStringInput(input, 'proposalId');
    const pin = readStringInput(input, 'pin');
    if (!proposalId || !/^\d{6}$/.test(pin)) {
      return { ok: false, summary: 'Response approval requires proposalId and a 6-digit Security PIN.', error: 'invalid-response-approval' };
    }
    const result = await this.client.approveResponse(proposalId, pin);
    const payload = firstJson(result);
    await context.emit('security.response.approved', this.manifest.id, {
      proposalId,
      grantId: readNestedString(payload && typeof payload === 'object' ? (payload as Record<string, unknown>).grant : null, 'grant_id'),
      executed: false,
    });
    return commandResult(result, 'Elevated response executor applied the bounded expiring action.', payload, this.runtimeMetadata());
  }

  private async listResponseActions(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.listResponseActions();
    const payload = firstJson(result);
    await context.emit('security.response.actions.read', this.manifest.id, {
      actions: readNestedArrayLength(payload, 'actions'),
    });
    return commandResult(result, 'Privileged response action lifecycle loaded.', payload, this.runtimeMetadata());
  }

  private async responseServiceStatus(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.responseServiceStatus();
    const payload = firstJson(result);
    await context.emit('security.response.service.status', this.manifest.id, {
      running: readNestedBoolean(payload, 'running'),
      integrityOk: readNestedBoolean(payload, 'integrity_ok'),
    });
    return commandResult(result, 'Response executor status loaded.', payload, this.runtimeMetadata());
  }

  private async emergencyStatus(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.emergencyStatus();
    const payload = firstJson(result);
    await context.emit('security.emergency.status', this.manifest.id, {
      active: readNestedBoolean(payload, 'active'),
      state: readNestedString(payload, 'state'),
      riskScore: readNestedNumber(payload, 'risk_score'),
    });
    return commandResult(result, 'Emergency response state loaded.', payload, this.runtimeMetadata());
  }

  private async resolveEmergency(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const decision = readStringInput(input, 'decision');
    const pin = readStringInput(input, 'pin');
    if (!['release', 'continue'].includes(decision) || !/^\d{6}$/.test(pin)) {
      return { ok: false, summary: 'Emergency decision requires release/continue and a 6-digit Security PIN.', error: 'invalid-emergency-decision' };
    }
    const result = await this.client.resolveEmergency({
      decision: decision as 'release' | 'continue',
      pin,
    });
    const payload = firstJson(result);
    await context.emit('security.emergency.resolved', this.manifest.id, {
      decision,
      state: readNestedString(payload && typeof payload === 'object' ? (payload as Record<string, unknown>).emergency : null, 'state'),
    });
    return commandResult(result, 'Emergency response decision applied.', payload, this.runtimeMetadata());
  }

  private async pinStatus(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.pinStatus();
    const payload = firstJson(result);
    await context.emit('security.pin.status', this.manifest.id, {
      configured: readNestedBoolean(payload, 'configured'),
      locked: readNestedBoolean(payload, 'locked'),
    });
    return commandResult(result, 'Security PIN status loaded.', payload, this.runtimeMetadata());
  }

  private async setPin(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const newPin = readStringInput(input, 'newPin');
    const confirmation = readStringInput(input, 'confirmation');
    if (!/^\d{6}$/.test(newPin) || newPin !== confirmation) {
      return { ok: false, summary: 'Security PIN must contain exactly 6 digits and match confirmation.', error: 'invalid-security-pin' };
    }
    const currentPin = readStringInput(input, 'currentPin');
    const pinInput: { newPin: string; confirmation: string; currentPin?: string } = { newPin, confirmation };
    if (currentPin) pinInput.currentPin = currentPin;
    const result = await this.client.setPin(pinInput);
    const payload = firstJson(result);
    await context.emit('security.pin.changed', this.manifest.id, { ok: result.ok });
    return commandResult(result, 'Security PIN updated.', payload, this.runtimeMetadata());
  }

  private async verifyPin(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const pin = readStringInput(input, 'pin');
    if (!/^\d{6}$/.test(pin)) {
      return { ok: false, summary: 'Security PIN must contain exactly 6 digits.', error: 'invalid-security-pin' };
    }
    const result = await this.client.verifyPin(pin);
    const payload = firstJson(result);
    await context.emit('security.pin.verified', this.manifest.id, { ok: result.ok });
    return commandResult(result, result.ok ? 'Security PIN verified.' : 'Security PIN rejected.', payload, this.runtimeMetadata());
  }

  private async recoverPin(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const recoveryCode = readStringInput(input, 'recoveryCode');
    const newPin = readStringInput(input, 'newPin');
    const confirmation = readStringInput(input, 'confirmation');
    if (!recoveryCode || recoveryCode.length > 64 || !/^\d{6}$/.test(newPin) || newPin !== confirmation) {
      return { ok: false, summary: 'Recovery requires a valid one-time code and matching 6-digit PIN.', error: 'invalid-security-pin-recovery' };
    }
    const result = await this.client.recoverPin({ recoveryCode, newPin, confirmation });
    const payload = firstJson(result);
    await context.emit('security.pin.recovered', this.manifest.id, { ok: result.ok });
    return commandResult(result, result.ok ? 'Security PIN recovered.' : 'Security PIN recovery rejected.', payload, this.runtimeMetadata());
  }

  private async diagnose(): Promise<MonarchExecutionResult> {
    const result = await this.client.diagnose();
    return commandResult(result, 'Monarch Security runtime diagnostics loaded.', firstJson(result), this.runtimeMetadata());
  }

  private async tailAudit(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const lines = readNumberInput(input, 'lines', 20, 1, 200);
    const result = await this.client.tailAudit(lines);
    await context.emit('security.audit.tail_read', this.manifest.id, {
      requestedLines: lines,
      records: result.jsonLines.length,
    });
    return commandResult(result, `Security audit tail read ${result.jsonLines.length} records.`, {
      records: result.jsonLines,
      requestedLines: lines,
    }, this.runtimeMetadata());
  }

  private async verifyIntegrity(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.verifyIntegrity();
    const payload = firstJson(result);
    await context.emit('security.integrity.checked', this.manifest.id, {
      ok: readNestedBoolean(payload, 'ok'),
    });
    return commandResult(result, integritySummary(payload), payload, this.runtimeMetadata());
  }

  private async scanSystem(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const result = await this.client.scanSystem({
      noLlm: readBooleanInput(input, 'noLlm', true),
      includeFiles: readBooleanInput(input, 'includeFiles', false),
      includeInstalls: readBooleanInput(input, 'includeInstalls', false),
      fileLimit: readNumberInput(input, 'fileLimit', 100, 1, 1000),
      summaryOnly: readBooleanInput(input, 'summaryOnly', true),
    });
    const payload = firstJson(result);
    await context.emit('security.scan.completed', this.manifest.id, {
      kind: 'system',
      summary: readSummaryCounts(payload),
    });
    return commandResult(result, scanSummary(payload, 'system security scan'), payload, this.runtimeMetadata());
  }

  private async generateReport(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const reportInput: {
      noLlm: boolean;
      includeFiles: boolean;
      includeInstalls: boolean;
      fileLimit: number;
      summaryOnly: boolean;
      outputDir?: string;
    } = {
      noLlm: readBooleanInput(input, 'noLlm', true),
      includeFiles: readBooleanInput(input, 'includeFiles', false),
      includeInstalls: readBooleanInput(input, 'includeInstalls', false),
      fileLimit: readNumberInput(input, 'fileLimit', 100, 1, 1000),
      summaryOnly: readBooleanInput(input, 'summaryOnly', true),
    };
    const outputDir = readStringInput(input, 'outputDir');
    if (outputDir) {
      reportInput.outputDir = outputDir;
    }
    const result = await this.client.generateReport(reportInput);
    const payload = withAgentGuard(firstJson(result), this.agentGuard.snapshot());
    await context.emit('security.report.generated', this.manifest.id, {
      ok: result.ok,
      id: payload && typeof payload === 'object' ? (payload as Record<string, unknown>).id : undefined,
    });
    return commandResult(result, 'Monarch Security report generated.', payload, this.runtimeMetadata());
  }

  private async scanSensor(
    sensor: SensorId,
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const result = await this.client.scanSensor(sensor, readBooleanInput(input, 'noLlm', true));
    const payload = firstJson(result);
    await context.emit('security.scan.completed', this.manifest.id, {
      kind: sensor,
      events: readNestedNumber(payload, 'events'),
    });
    return commandResult(result, scanSummary(payload, `${sensor} security scan`), payload, this.runtimeMetadata());
  }

  private async networkCenter(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const limit = readNumberInput(input, 'limit', 100, 1, 1000);
    const result = await this.client.networkCenter(limit);
    const payload = firstJson(result);
    await context.emit('security.network.center.read', this.manifest.id, {
      profiles: readNestedArrayLength(payload, 'profiles'),
      connections: readNestedArrayLength(payload, 'connections'),
      listeners: readNestedArrayLength(payload, 'listeners'),
    });
    return commandResult(result, 'Network Center state loaded.', payload, this.runtimeMetadata());
  }

  private async setNetworkProfileTrust(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const profileId = readStringInput(input, 'profileId');
    if (!/^[a-f0-9]{24}$/i.test(profileId)) {
      return { ok: false, summary: 'Network profile id is invalid.', error: 'invalid-network-profile-id' };
    }
    const trusted = readBooleanInput(input, 'trusted', true);
    const result = await this.client.setNetworkProfileTrust(profileId, trusted);
    const payload = firstJson(result);
    await context.emit('security.network.profile.changed', this.manifest.id, { profileId, trusted, ok: result.ok });
    return commandResult(
      result,
      trusted ? 'Network profile marked as trusted.' : 'Network profile trust removed.',
      payload,
      this.runtimeMetadata()
    );
  }

  private async scanPath(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const targetPath = readStringInput(input, 'path');
    if (!targetPath) {
      return {
        ok: false,
        summary: 'Security path scan requires path.',
        error: 'missing-path',
      };
    }

    const result = await this.client.scanPath({
      targetPath,
      recursive: readBooleanInput(input, 'recursive', false),
      limit: readNumberInput(input, 'limit', 250, 1, 2000),
      noLlm: readBooleanInput(input, 'noLlm', true),
    });
    const payload = firstJson(result);
    await context.emit('security.scan.completed', this.manifest.id, {
      kind: 'path',
      path: targetPath,
      scanned: readNestedNumber(payload, 'scanned'),
    });
    return commandResult(result, scanSummary(payload, 'path security scan'), payload, this.runtimeMetadata());
  }

  private async deepScanFile(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const targetPath = readStringInput(input, 'path');
    if (!targetPath) {
      return {
        ok: false,
        summary: 'Security deep scan requires path.',
        error: 'missing-path',
      };
    }

    const result = await this.client.deepScanFile({
      targetPath,
      defender: readBooleanInput(input, 'defender', false),
      noLlm: readBooleanInput(input, 'noLlm', true),
    });
    const payload = firstJson(result);
    await context.emit('security.scan.completed', this.manifest.id, {
      kind: 'deep-file',
      path: targetPath,
      score: readAssessmentScore(payload),
    });
    return commandResult(result, scanSummary(payload, 'deep file security scan'), payload, this.runtimeMetadata());
  }

  private async startProtection(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const result = await this.client.start(readBooleanInput(input, 'noLlm', true));
    const payload = firstJson(result);
    await context.emit('security.protection.changed', this.manifest.id, {
      action: 'start',
      started: readNestedBoolean(payload, 'started'),
      pid: readNestedNumber(payload, 'pid'),
      reason: readNestedString(payload, 'reason'),
    });
    await context.audit('security', 'Monarch Security protection start requested.', {
      started: readNestedBoolean(payload, 'started'),
      pid: readNestedNumber(payload, 'pid'),
      reason: readNestedString(payload, 'reason'),
    }, result.ok ? 'info' : 'warn');
    return commandResult(result, protectionStartSummary(payload), payload, this.runtimeMetadata());
  }

  private async stopProtection(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const result = await this.client.stop(readNumberInput(input, 'waitSeconds', 10, 0, 60));
    const payload = firstJson(result);
    await context.emit('security.protection.changed', this.manifest.id, {
      action: 'stop',
      running: readNestedBoolean(payload, 'running'),
    });
    await context.audit('security', 'Monarch Security protection stop requested.', {
      running: readNestedBoolean(payload, 'running'),
      authenticated: readNestedBoolean(payload, 'authenticated'),
    }, result.ok ? 'info' : 'warn');
    return commandResult(result, protectionStopSummary(payload), payload, this.runtimeMetadata());
  }

  private async writeBaseline(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const scopeInput = readStringInput(input, 'scope');
    const scope = readBaselineScopeInput(scopeInput);
    if (!scope) {
      return {
        ok: false,
        summary: 'Security baseline scope must be one of: all, devices, installs, files, network, persistence, posture.',
        error: 'invalid-scope',
      };
    }
    const expectedDigest = readStringInput(input, 'expectedDigest').toLowerCase();
    if (scope === 'persistence' && !/^[a-f0-9]{64}$/.test(expectedDigest)) {
      return {
        ok: false,
        summary: 'Persistence baseline requires a fresh preview digest.',
        error: 'baseline-preview-required',
      };
    }
    const result = await this.client.baseline(scope, expectedDigest || undefined);
    const payload = firstJson(result);
    await context.audit('security', 'Monarch Security baseline write requested.', {
      scope,
      ok: result.ok,
    }, result.ok ? 'info' : 'warn');
    return commandResult(result, 'Security baseline saved.', payload, this.runtimeMetadata());
  }

  private async previewBaseline(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.baselinePreview();
    const payload = firstJson(result);
    const counts = payload && typeof payload === 'object' && (payload as { counts?: unknown }).counts
      && typeof (payload as { counts?: unknown }).counts === 'object'
      ? (payload as { counts: Record<string, unknown> }).counts
      : {};
    await context.emit('security.baseline.previewed', this.manifest.id, {
      digest: readNestedString(payload, 'digest'),
      added: readNestedNumber(counts, 'added'),
      changed: readNestedNumber(counts, 'changed'),
      removed: readNestedNumber(counts, 'removed'),
    });
    return commandResult(result, 'Persistence baseline preview loaded.', payload, this.runtimeMetadata());
  }

  private async verifyProtection(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const result = await this.client.verifyProtection(readBooleanInput(input, 'withLlm', false));
    const payload = firstJson(result);
    await context.emit('security.scan.completed', this.manifest.id, {
      kind: 'verify-protection',
      passed: readNestedBoolean(payload, 'passed'),
    });
    return commandResult(result, labSummary(payload, 'Protection verification'), payload, this.runtimeMetadata());
  }

  private async attackSimulation(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const result = await this.client.attackSimulation(readBooleanInput(input, 'withLlm', false));
    const payload = firstJson(result);
    await context.emit('security.scan.completed', this.manifest.id, {
      kind: 'attack-simulation',
      passed: readNestedBoolean(payload, 'passed'),
    });
    return commandResult(result, labSummary(payload, 'Attack simulation'), payload, this.runtimeMetadata());
  }

  private async liveThreatSimulation(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.simulateLiveThreat();
    const payload = firstJson(result);
    await context.emit('security.simulation.created', this.manifest.id, {
      incidentId: readNestedString(payload, 'incident_id'),
      riskScore: readNestedNumber(payload, 'risk_score'),
      inert: readNestedBoolean(payload, 'inert'),
    });
    return commandResult(result, 'Inert live threat simulation passed through the durable incident and notification pipeline.', payload, this.runtimeMetadata());
  }

  private async startBenchmark(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const durationSeconds = readNumberInput(input, 'durationSeconds', 300, 30, 900);
    const intervalSeconds = readNumberInput(input, 'intervalSeconds', 0.5, 0.25, 5);
    const existing = this.client.backgroundBenchmarkStatus();
    const snapshot = this.client.startBackgroundBenchmark(durationSeconds, intervalSeconds);
    const reused = existing?.status === 'running' && existing.jobId === snapshot.jobId;
    await context.emit('security.benchmark.started', this.manifest.id, {
      jobId: snapshot.jobId,
      durationSeconds: snapshot.durationSeconds,
      intervalSeconds: snapshot.intervalSeconds,
      reused,
    });
    return {
      ok: true,
      summary: reused ? 'Background security benchmark is already running.' : 'Background security benchmark started.',
      output: { ...snapshot, reused },
    };
  }

  private async benchmarkStatus(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const snapshot = this.client.backgroundBenchmarkStatus();
    await context.emit('security.benchmark.status', this.manifest.id, {
      jobId: snapshot?.jobId || null,
      status: snapshot?.status || 'idle',
      progressPercent: snapshot?.progressPercent || 0,
    });
    return {
      ok: true,
      summary: snapshot ? `Background benchmark is ${snapshot.status}.` : 'Background benchmark has not been started.',
      output: snapshot || { status: 'idle', progressPercent: 0 },
    };
  }

  private async cancelBenchmark(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const jobId = readStringInput(input, 'jobId');
    if (!/^[a-f0-9-]{36}$/i.test(jobId)) {
      return { ok: false, summary: 'Background benchmark job id is invalid.', error: 'invalid-benchmark-job-id' };
    }
    const snapshot = this.client.cancelBackgroundBenchmark(jobId);
    if (!snapshot) {
      return { ok: false, summary: 'Background benchmark job was not found.', error: 'benchmark-job-not-found' };
    }
    await context.emit('security.benchmark.cancelled', this.manifest.id, { jobId, status: snapshot.status });
    return { ok: true, summary: 'Background security benchmark cancelled.', output: snapshot };
  }

  private async testNotification(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const result = await this.client.testNotification();
    const payload = firstJson(result) || lastJson(result);
    await context.emit('security.scan.completed', this.manifest.id, {
      kind: 'notification-test',
      ok: result.ok,
    });
    return commandResult(result, 'Security notification test completed.', payload, this.runtimeMetadata());
  }

  private async checkControllerAction(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const intentText = readStringInput(input, 'intentText');
    const actionModule = readStringInput(input, 'actionModule');
    const actionCapability = readStringInput(input, 'actionCapability');
    const actionInput = readStringInput(input, 'actionInput');
    const passkey = readStringInput(input, 'passkey');
    const noLlm = readBooleanInput(input, 'noLlm', false);
    const actionRisk = readRiskInput(input, 'actionRisk');
    const requestedBy = readStringInput(input, 'requestedBy') || 'unknown';
    const modelProposed = readBooleanInput(input, 'modelProposed', false);

    if (this.securityLevel === 'off') {
      return {
        ok: true,
        summary: 'Security controller is disabled by the user profile.',
        output: { payload: { ok: true, status: 'allowed', risk: 'low', report: 'Security profile is off; command control is observe-only.', reasons: [], evidenceCodes: ['profile.off'], decision: { action: 'allow', binding: 'user-profile' } } },
      };
    }
    if (modelProposed && !this.modelCommandsEnabled) {
      return {
        ok: true,
        summary: 'Oscar command proposal was blocked by the user model policy.',
        output: { payload: { ok: false, status: 'blocked', risk: 'blocked', report: 'Команды Oscar отключены в настройках Security.', reasons: ['Пользователь отключил LLM-команды.'], evidenceCodes: ['model-policy.disabled'], decision: { action: 'block', binding: 'user-model-policy' } } },
      };
    }

    const localDecision = this.agentGuard.assess({
      intentText,
      actionModule,
      actionCapability,
      actionInput,
      actionRisk,
      requestedBy,
    });
    if ((this.securityLevel === 'maximum' || this.modelConfirmationMode === 'always')
      && modelProposed && localDecision.status === 'allowed') {
      localDecision.ok = false;
      localDecision.status = 'approval_required';
      localDecision.risk = 'elevated';
      localDecision.report = 'Security требует подтверждение каждой команды, предложенной Oscar.';
      localDecision.reasons.push(this.securityLevel === 'maximum' ? 'Максимальная строгость активна.' : 'Включён режим «Всегда спрашивать».');
      localDecision.evidenceCodes.push(this.securityLevel === 'maximum' ? 'profile.maximum.model-command' : 'model-policy.always-confirm');
      localDecision.decision.action = 'require_confirmation';
    }
    await context.audit('security-agent-guard', 'Agent capability action reviewed.', {
      moduleId: actionModule,
      capabilityId: actionCapability,
      actionRisk,
      requestedBy,
      status: localDecision.status,
      evidenceCodes: localDecision.evidenceCodes,
      inputHash: localDecision.inputHash,
    }, localDecision.status === 'blocked' ? 'error' : localDecision.status === 'approval_required' ? 'warn' : 'info');

    if (localDecision.status === 'blocked' || !this.client.available) {
      return localControllerResult(localDecision, this.agentGuard.snapshot(), this.client.available);
    }

    const result = await this.client.checkAction({
      intentText,
      actionModule,
      actionCapability,
      actionInput,
      passkey,
      noLlm,
      // Do not trust confirmation facts embedded in controller input. The
      // execution engine satisfies Security approval_required responses from
      // the original confirmed Monarch request, not from this action payload.
      monarchConfirmed: false,
    });
    const payload = mergeControllerDecisions(localDecision, firstJson(result));
    return commandResult(
      result,
      'Monarch Security Agent Guard action check complete.',
      payload,
      { ...this.runtimeMetadata(), agentGuard: this.agentGuard.snapshot() }
    );
  }

  private async blockControllerAction(
    input: unknown,
    _context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const capabilityId = readStringInput(input, 'capabilityId');
    if (!capabilityId) {
      return {
        ok: false,
        summary: 'Security controller block requires capabilityId.',
        error: 'missing-capability',
      };
    }
    const result = await this.client.blockAction({ capabilityId });
    const payload = firstJson(result);
    return commandResult(
      result,
      'Monarch Security capability permanently blocked.',
      payload,
      this.runtimeMetadata()
    );
  }

  private runtimeMetadata(): Record<string, unknown> {
    return {
      adapter: 'monarch-security-cli',
      projectRoot: this.client.config.projectRoot,
      configPath: this.client.config.configPath,
      pythonPath: this.client.config.pythonPath,
    };
  }
}

function localControllerResult(
  decision: AgentGuardDecision,
  snapshot: AgentGuardSnapshot,
  pythonAvailable: boolean,
): MonarchExecutionResult {
  return {
    ok: true,
    summary: 'Monarch Security Agent Guard completed a local deterministic review.',
    output: {
      payload: {
        ...decision,
        controller: pythonAvailable ? 'local-hard-boundary' : 'local-degraded',
      },
    },
    metadata: {
      agentGuard: snapshot,
      pythonControllerAvailable: pythonAvailable,
    },
  };
}

function mergeControllerDecisions(local: AgentGuardDecision, remote: unknown): Record<string, unknown> {
  if (!remote || typeof remote !== 'object') {
    return {
      ok: false,
      status: 'controller_invalid_response',
      risk: 'blocked',
      report: 'Python controller returned an invalid response; the action is blocked.',
      reasons: ['Invalid Python controller response.'],
      evidenceCodes: local.evidenceCodes,
      inputHash: local.inputHash,
      decision: { action: 'block', binding: local.decision.binding },
      controller: 'hybrid',
    };
  }
  const payload = remote as Record<string, unknown>;
  const remoteStatus = String(payload.status || '');
  const remoteRank = /blocked|invalid|failed/i.test(remoteStatus) ? 3
    : remoteStatus === 'approval_required' ? 2
      : /allowed/i.test(remoteStatus) ? 1 : 3;
  const localRank = local.status === 'blocked' ? 3 : local.status === 'approval_required' ? 2 : 1;
  if (localRank >= remoteRank && local.status !== 'allowed') {
    return {
      ...payload,
      ...local,
      reasons: Array.from(new Set([
        ...local.reasons,
        ...readStringList(payload.reasons),
      ])),
      controller: 'hybrid',
    };
  }
  return {
    ...payload,
    evidenceCodes: local.evidenceCodes,
    inputHash: local.inputHash,
    controller: 'hybrid',
  };
}

function withAgentGuard(payload: unknown, snapshot: AgentGuardSnapshot): unknown {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), agentGuard: snapshot }
    : { runtime: payload, agentGuard: snapshot };
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function commandResult(
  result: SecurityCommandResult,
  summary: string,
  payload: unknown,
  metadata: Record<string, unknown>
): MonarchExecutionResult {
  const output: Record<string, unknown> = {
    payload,
    command: redactCommandArgs(result.args),
  };
  const stderr = redactSensitiveText(result.stderr.trim());
  const stdout = redactSensitiveText(result.stdout.trim());
  if (stderr) {
    output.stderr = stderr;
  }
  if (!payload && stdout) {
    output.stdout = stdout;
  }

  const executionResult: MonarchExecutionResult = {
    ok: result.ok,
    summary: result.ok ? summary : `${summary} Command exited with ${result.exitCode}.`,
    output,
    metadata: {
      ...metadata,
      exitCode: result.exitCode,
    },
  };

  if (!result.ok) {
    executionResult.error = 'security-command-failed';
  }

  return executionResult;
}

function redactCommandArgs(args: string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    redacted.push(arg);
    if (/^--(?:passkey|token|api-key|secret|pin|new-pin|current-pin|confirmation|recovery-code)$/i.test(arg) && index + 1 < args.length) {
      redacted.push('[redacted]');
      index += 1;
    }
  }
  return redacted;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(--(?:passkey|token|api-key|secret|pin|new-pin|current-pin|confirmation|recovery-code)\s+)([^\s]+)/gi, '$1[redacted]')
    .replace(/("(?:passkey|token|apiKey|api_key|secret|pin|newPin|new_pin|currentPin|current_pin|confirmation|recoveryCode|recovery_code)"\s*:\s*")([^"]+)(")/gi, '$1[redacted]$3')
    .replace(/\b(passkey|token|apiKey|api_key|secret|pin|newPin|new_pin|currentPin|current_pin|confirmation|recoveryCode|recovery_code)=([^\s]+)/gi, '$1=[redacted]');
}

function securityRuntimeError(error: unknown): MonarchExecutionResult {
  return {
    ok: false,
    summary: `Monarch Security runtime failed: ${error instanceof Error ? error.message : String(error)}`,
    error: 'security-runtime-failed',
  };
}

function mentionsSecurity(text: string): boolean {
  const strongTechnicalCue = /\b(?:security|monarch security|protector|defender|firewall|antivirus|malware|trojan|ransomware|quarantine|autorun|persistence|agent guard|usb)\b|монарх\s+security|модул[а-яё]*\s+безопасност|антивирус|троян|карантин|автозапуск|фаервол|защитник\s+windows/i;
  if (strongTechnicalCue.test(text)) return true;
  if (/^(?:security|безопасность|проверь безопасность|статус защиты)[.!? ]*$/i.test(text)) return true;
  const weakSecurityCue = /\b(?:security|protect|virus|threat|incident|emergency|audit|integrity|scan)\b|безопас|защит|вирус|угроз|инцидент|экстрен|скан|аудит|целост/i;
  const technicalTarget = /\b(?:monarch|oscar|windows|computer|host|system|file|process|network|port|device|code|repo(?:sitory)?)\b|монарх|оскар|windows|компьютер|хост|систем|файл|процесс|сеть|порт|устройств|код|репозитор/i;
  return weakSecurityCue.test(text) && technicalTarget.test(text);
}

function extractSensor(text: string): SensorId | '' {
  if (/(network|internet|connection|listener|сеть|сетев)/i.test(text)) {
    return 'network';
  }
  if (/(device|devices|usb|hid|устройств|usb)/i.test(text)) {
    return 'devices';
  }
  if (/(persistence|autorun|startup|scheduled|автозапуск|планировщик)/i.test(text)) {
    return 'persistence';
  }
  if (/(posture|defender|firewall|защитник|фаервол|firewall)/i.test(text)) {
    return 'posture';
  }
  return '';
}

function extractPath(text: string): string {
  const quoted = text.match(/["'`](.+?)["'`]/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const drivePath = text.match(/[A-Za-z]:\\[^\r\n]+/);
  if (drivePath?.[0]) {
    return drivePath[0].trim().replace(/[.。]+$/, '');
  }

  return '';
}

function extractBaselineScope(text: string): string {
  if (/(device|usb|устройств)/i.test(text)) {
    return 'devices';
  }
  if (/(install|software|софт|установ)/i.test(text)) {
    return 'installs';
  }
  if (/(file|folder|файл|папк)/i.test(text)) {
    return 'files';
  }
  if (/(network|сеть)/i.test(text)) {
    return 'network';
  }
  if (/(persistence|autorun|автозапуск)/i.test(text)) {
    return 'persistence';
  }
  if (/(posture|defender|firewall|защитник)/i.test(text)) {
    return 'posture';
  }
  if (/(self.?protection|tamper|самозащит|подмен)/i.test(text)) {
    return 'self-protection';
  }
  return 'all';
}

function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readNumberInput(
  input: unknown,
  key: string,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY
): number {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function readBooleanInput(input: unknown, key: string, fallback: boolean): boolean {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readObjectInput(input: unknown, key: string): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  const value = (input as Record<string, unknown>)[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : null;
}

function readStringArrayInput(input: unknown, key: string): string[] {
  if (!input || typeof input !== 'object') return [];
  const value = (input as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 8)
    : [];
}

function readResponseProposalSource(input: unknown): 'rules' | 'llm' | 'user' {
  const value = readStringInput(input, 'proposedBy');
  return value === 'llm' || value === 'user' ? value : 'rules';
}

function readRiskInput(input: unknown, key: string): MonarchRisk {
  const value = readStringInput(input, key);
  return [
    'none', 'read', 'write', 'delete', 'execute', 'network',
    'device-control', 'money', 'identity', 'security-sensitive',
  ].includes(value) ? value as MonarchRisk : 'security-sensitive';
}

function readBaselineScopeInput(value: string): string | null {
  const scope = value || 'all';
  return [
    'all',
    'devices',
    'installs',
    'files',
    'network',
    'persistence',
    'posture',
    'self-protection',
  ].includes(scope) ? scope : null;
}

function readNestedBoolean(payload: unknown, key: string): boolean {
  return Boolean(payload && typeof payload === 'object' && (payload as Record<string, unknown>)[key]);
}

function readSecurityLevel(payload: unknown): SecurityLevel | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const profile = record.profile && typeof record.profile === 'object'
    ? record.profile as Record<string, unknown>
    : record;
  const level = typeof profile.level === 'string' ? profile.level : '';
  return ['off', 'minimal', 'balanced', 'strict', 'maximum'].includes(level)
    ? level as SecurityLevel
    : null;
}

function readModelCommandPolicy(payload: unknown): { enabled: boolean; confirmationMode: ModelConfirmationMode } {
  if (!payload || typeof payload !== 'object') return { enabled: true, confirmationMode: 'adaptive' };
  const record = payload as Record<string, unknown>;
  const policy = record.model_policy && typeof record.model_policy === 'object'
    ? record.model_policy as Record<string, unknown>
    : record;
  return {
    enabled: policy.enabled !== false,
    confirmationMode: policy.confirmation_mode === 'always' ? 'always' : 'adaptive',
  };
}

function extractSecurityLevel(text: string): SecurityLevel | null {
  if (/(maximum|maximal|максимальн)/i.test(text)) return 'maximum';
  if (/(strict|строг)/i.test(text)) return 'strict';
  if (/(balanced|medium|средн|спокойн)/i.test(text)) return 'balanced';
  if (/(minimal|minimal|минимальн)/i.test(text)) return 'minimal';
  if (/(off|disabled|отключ[её]н|выключен)/i.test(text)) return 'off';
  return null;
}

function readNestedString(payload: unknown, key: string): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readNestedNumber(payload: unknown, key: string): number {
  if (!payload || typeof payload !== 'object') {
    return 0;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readSummaryCounts(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  const summary = (payload as { summary?: unknown }).summary;
  return summary && typeof summary === 'object' ? summary as Record<string, unknown> : {};
}

function readAssessmentScore(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    return 0;
  }
  const assessment = (payload as { assessment?: unknown }).assessment;
  if (!assessment || typeof assessment !== 'object') {
    return 0;
  }
  const score = (assessment as { score?: unknown }).score;
  return typeof score === 'number' && Number.isFinite(score) ? score : 0;
}

function securityStatusSummary(payload: unknown): string {
  return readNestedBoolean(payload, 'running')
    ? 'Monarch Security background protection is running.'
    : 'Monarch Security background protection is stopped.';
}

function integritySummary(payload: unknown): string {
  return readNestedBoolean(payload, 'ok')
    ? 'Security audit/state integrity verified.'
    : 'Security audit/state integrity check reported an issue.';
}

function scanSummary(payload: unknown, label: string): string {
  if (!payload || typeof payload !== 'object') {
    return `${label} completed.`;
  }
  const summary = (payload as { summary?: unknown }).summary;
  if (summary && typeof summary === 'object') {
    const events = (summary as { events?: unknown }).events;
    const high = (summary as { high_or_higher?: unknown }).high_or_higher;
    return `${label} completed: ${Number(events || 0)} events, ${Number(high || 0)} high-or-higher findings.`;
  }
  const scanned = readNestedNumber(payload, 'scanned');
  const events = readNestedNumber(payload, 'events');
  if (scanned) {
    return `${label} completed: ${scanned} items scanned.`;
  }
  if (events) {
    return `${label} completed: ${events} events assessed.`;
  }
  return `${label} completed.`;
}

function protectionStartSummary(payload: unknown): string {
  if (readNestedBoolean(payload, 'started')) {
    return `Security protection started with PID ${readNestedNumber(payload, 'pid') || 'unknown'}.`;
  }
  const reason = readNestedString(payload, 'reason');
  if (reason === 'already_running') {
    return 'Security protection was not started because it is already running.';
  }
  if (reason === 'startup_timeout') {
    return protectionStartupFailureSummary(payload, 'timed out before reporting running status');
  }
  if (reason === 'startup_failed') {
    return protectionStartupFailureSummary(payload, 'exited before reporting running status');
  }
  if (reason) {
    return `Security protection was not started: ${reason}.`;
  }
  return 'Security protection was not started, likely because it is already running.';
}

function readNestedArrayLength(payload: unknown, key: string): number {
  if (!payload || typeof payload !== 'object') return 0;
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : 0;
}

function protectionStartupFailureSummary(payload: unknown, reason: string): string {
  const launchPid = readNestedNumber(payload, 'launch_pid');
  const exitCode = readNestedNumber(payload, 'exit_code');
  const logPath = readNestedString(payload, 'log_path');
  return [
    `Security protection startup ${reason}`,
    launchPid ? `launch PID ${launchPid}` : '',
    exitCode ? `exit code ${exitCode}` : '',
    logPath ? `log ${logPath}` : '',
  ].filter(Boolean).join('; ') + '.';
}

function protectionStopSummary(payload: unknown): string {
  return readNestedBoolean(payload, 'running')
    ? 'Security protection stop was requested, but the protector is still running.'
    : 'Security protection stopped.';
}

function labSummary(payload: unknown, label: string): string {
  const passed = readNestedBoolean(payload, 'passed');
  const cases = readNestedNumber(payload, 'case_count');
  return `${label} ${passed ? 'passed' : 'reported failures'}${cases ? ` across ${cases} cases` : ''}.`;
}

export function createSecurityModule(): MonarchModule {
  return new SecurityModule();
}

export const securityModulePackage: MonarchModulePackage = {
  id: securityManifest.id,
  moduleId: securityManifest.id,
  version: securityManifest.version,
  description: securityManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createSecurityModule,
};
