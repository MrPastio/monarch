import { describe, expect, it } from 'vitest';
import {
  MonarchKernel,
  type MonarchExecutionRequest,
  type MonarchExecutionResult,
  type MonarchModule,
} from '../../src/core';
import { SecurityModule } from '../../src/modules/security';

describe('Monarch Access and Monarch Security confirmation', () => {
  it('enforces explicit capability supportedSources again at Kernel dispatch', async () => {
    const kernel = new MonarchKernel();
    let executions = 0;
    kernel.registerModule({
      manifest: {
        id: 'source-boundary',
        name: 'Source Boundary Fixture',
        version: '0.1.0',
        kind: 'runtime',
        description: 'Test-only source boundary fixture.',
        owns: ['source boundary'],
        permissions: ['read'],
        capabilities: [{
          id: 'source-boundary.desktop-only',
          moduleId: 'source-boundary',
          title: 'Desktop-only observation',
          risk: 'read',
          agent: {
            supportedSources: ['desktop'],
            cancellation: 'supported',
          },
        }],
      },
      async activate(): Promise<void> {},
      async executeCapability(): Promise<MonarchExecutionResult> {
        executions += 1;
        return { ok: true, summary: 'Desktop-only fixture executed.' };
      },
    });
    await kernel.start();

    try {
      const blocked = await kernel.execute({
        id: 'exec_source_boundary_api',
        intentId: 'intent_source_boundary_api',
        moduleId: 'source-boundary',
        capabilityId: 'source-boundary.desktop-only',
        input: {},
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
        source: 'api',
      });
      expect(blocked).toMatchObject({
        ok: false,
        error: 'permission-denied',
        metadata: {
          sourceBoundary: {
            source: 'api',
            supportedSources: ['desktop'],
          },
        },
      });
      expect(executions).toBe(0);

      const allowed = await kernel.execute({
        id: 'exec_source_boundary_desktop',
        intentId: 'intent_source_boundary_desktop',
        moduleId: 'source-boundary',
        capabilityId: 'source-boundary.desktop-only',
        input: {},
        createdAt: new Date(0).toISOString(),
        requestedBy: 'desktop',
        source: 'desktop',
      });
      expect(allowed).toMatchObject({ ok: true, summary: 'Desktop-only fixture executed.' });
      expect(executions).toBe(1);
    } finally {
      await kernel.stop();
    }
  });

  it('uses one verified confirmation for the exact request', async () => {
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(createSecurityApprovalModule());
    kernel.registerModule(createDeleteModule());
    await kernel.start();

    try {
      const result = await kernel.execute(createDeleteRequest(true));
      expect(result).toMatchObject({ ok: true, summary: 'Deleted smoke fixture.' });
    } finally {
      await kernel.stop();
    }
  });

  it('allows only an exact policy-bound Owner override for a non-hard Security block', async () => {
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
      authorityContext: {
        tier: 'owner',
        source: 'signed-device-entitlement',
        entitlementId: 'entitlement-test',
        keyId: 'owner-root-test',
        verifiedAt: new Date(0).toISOString(),
        deviceIdPrefix: '0123456789ab',
        diagnostic: null,
      },
    });
    kernel.registerModule(createSecurityApprovalModule('blocked'));
    kernel.registerModule(createDeleteModule());
    await kernel.start();

    try {
      const blocked = await kernel.execute({ ...createDeleteRequest(true), source: 'desktop' });
      expect(blocked).toMatchObject({
        ok: false,
        error: 'confirmation-required',
        metadata: { securityOverride: true },
      });
      const unbound = await kernel.execute({
        ...createDeleteRequest(true),
        source: 'desktop',
        securityOverrideConfirmed: true,
      });
      expect(unbound).toMatchObject({ ok: false, error: 'confirmation-required' });
      const policy = blocked.metadata?.policy as { policyDecisionHash: string; authorityTier: 'owner' };
      const result = await kernel.execute({
        ...createDeleteRequest(true),
        source: 'desktop',
        securityOverrideConfirmed: true,
        approvalPurpose: 'owner-security-override',
        approvalPolicyDecisionHash: policy.policyDecisionHash,
        authorityTierAtApproval: policy.authorityTier,
      });
      expect(result).toMatchObject({ ok: true, summary: 'Deleted smoke fixture.' });
      expect(kernel.getSnapshot().audit.some((entry) => entry.message.includes('User overrode a Security block'))).toBe(true);
    } finally {
      await kernel.stop();
    }
  });

  it('does not expose the Security controller check as an unconfirmed read capability', async () => {
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new SecurityModule());
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_direct_security_controller_check',
        intentId: 'intent_direct_security_controller_check',
        moduleId: 'security',
        capabilityId: 'security.controller.check',
        input: {
          intentText: 'удали runtime/a.txt',
          actionModule: 'workspace',
          actionCapability: 'workspace.files.delete',
          actionInput: '{"path":"runtime/a.txt"}',
          actionRisk: 'delete',
          requestedBy: 'api',
          monarchConfirmed: true,
          noLlm: true,
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
      });

      expect(result).toMatchObject({
        ok: false,
        error: 'confirmation-required',
      });
    } finally {
      await kernel.stop();
    }
  });

  it('treats Security report generation as a writing action in read-only sandbox', async () => {
    const calls: string[] = [];
    const fakeSecurityClient = {
      config: {
        projectRoot: 'E:\\Monarch\\security',
        configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
        pythonPath: 'python',
        timeoutMs: 30000,
      },
      available: true,
      generateReport: async () => {
        calls.push('generateReport');
        return {
          ok: true,
          exitCode: 0,
          args: ['report'],
          stdout: '',
          stderr: '',
          jsonLines: [{ ok: true, id: 'report-test' }],
        };
      },
    };
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new SecurityModule(fakeSecurityClient as any));
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_security_report_unconfirmed',
        intentId: 'intent_security_report_unconfirmed',
        moduleId: 'security',
        capabilityId: 'security.report.generate',
        input: { noLlm: true, summaryOnly: true },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
      });

      expect(result).toMatchObject({
        ok: false,
        error: 'confirmation-required',
      });
      expect(calls).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });

  it('requires confirmation for Security deep scan with Defender custom scan', async () => {
    const calls: string[] = [];
    const fakeSecurityClient = {
      config: {
        projectRoot: 'E:\\Monarch\\security',
        configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
        pythonPath: 'python',
        timeoutMs: 30000,
      },
      available: true,
      deepScanFile: async () => {
        calls.push('deepScanFile');
        return {
          ok: true,
          exitCode: 0,
          args: ['deep-scan-file', 'sample.exe', '--defender'],
          stdout: '',
          stderr: '',
          jsonLines: [{ ok: true }],
        };
      },
    };
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new SecurityModule(fakeSecurityClient as any));
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_security_deep_scan_defender_unconfirmed',
        intentId: 'intent_security_deep_scan_defender_unconfirmed',
        moduleId: 'security',
        capabilityId: 'security.deep_scan.file',
        input: { path: 'E:\\Downloads\\sample.exe', defender: true, noLlm: true },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
      });

      expect(result).toMatchObject({
        ok: false,
        error: 'confirmation-required',
      });
      expect(calls).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });

  it('rejects empty Security controller block requests before calling the client', async () => {
    const calls: string[] = [];
    const fakeSecurityClient = {
      config: {
        projectRoot: 'E:\\Monarch\\security',
        configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
        pythonPath: 'python',
        timeoutMs: 30000,
      },
      available: true,
      blockAction: async () => {
        calls.push('blockAction');
        return {
          ok: true,
          exitCode: 0,
          args: ['block-action'],
          stdout: '',
          stderr: '',
          jsonLines: [{ ok: true }],
        };
      },
    };
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new SecurityModule(fakeSecurityClient as any));
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_security_block_empty_capability',
        intentId: 'intent_security_block_empty_capability',
        moduleId: 'security',
        capabilityId: 'security.controller.block',
        input: { capabilityId: '   ' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
        confirmed: true,
      });

      expect(result).toMatchObject({
        ok: false,
        error: 'missing-capability',
      });
      expect(calls).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });

  it('rejects invalid Security baseline scope before widening to full baseline', async () => {
    const calls: string[] = [];
    const fakeSecurityClient = {
      config: {
        projectRoot: 'E:\\Monarch\\security',
        configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
        pythonPath: 'python',
        timeoutMs: 30000,
      },
      available: true,
      baseline: async (scope: string) => {
        calls.push(scope);
        return {
          ok: true,
          exitCode: 0,
          args: ['baseline'],
          stdout: '',
          stderr: '',
          jsonLines: [{ state_path: 'state.json' }],
        };
      },
    };
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new SecurityModule(fakeSecurityClient as any));
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_security_baseline_invalid_scope',
        intentId: 'intent_security_baseline_invalid_scope',
        moduleId: 'security',
        capabilityId: 'security.baseline.write',
        input: { scope: 'devices-and-network' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
        confirmed: true,
      });

      expect(result).toMatchObject({
        ok: false,
        error: 'invalid-scope',
      });
      expect(calls).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });

  it('surfaces Security protection startup timeout instead of reporting an already-running state', async () => {
    const fakeSecurityClient = {
      config: {
        projectRoot: 'E:\\Monarch\\security',
        configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
        pythonPath: 'python',
        timeoutMs: 30000,
      },
      available: true,
      start: async () => ({
        ok: false,
        exitCode: 1,
        args: ['start', '--no-llm'],
        stdout: '',
        stderr: '',
        jsonLines: [{
          started: false,
          reason: 'startup_timeout',
          running: false,
          launch_pid: 4242,
          log_path: 'E:\\Monarch\\security\\logs\\protector.out.log',
        }],
      }),
    };
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
    });
    kernel.registerModule(new SecurityModule(fakeSecurityClient as any));
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_security_start_timeout',
        intentId: 'intent_security_start_timeout',
        moduleId: 'security',
        capabilityId: 'security.protection.start',
        input: { noLlm: true },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('security-command-failed');
      expect(result.summary).toContain('timed out before reporting running status');
      expect(result.summary).toContain('launch PID 4242');
      expect(result.summary).toContain('protector.out.log');
      expect(result.summary).not.toContain('already running');
    } finally {
      await kernel.stop();
    }
  });

  it('keeps the internal Security controller check available under approvalPolicy never', async () => {
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
    });
    kernel.registerModule(createSecurityApprovalModule('allowed'));
    kernel.registerModule(createWriteModule());
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_write_internal_security_check',
        intentId: 'intent_write_internal_security_check',
        moduleId: 'smoke-write',
        capabilityId: 'smoke.write',
        input: { path: 'runtime/smoke.txt', content: 'ok' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'unit',
      });
      expect(result).toMatchObject({ ok: true, summary: 'Wrote smoke fixture.' });
      expect(result.metadata).toMatchObject({
        runtimeTelemetry: {
          toolLatencyMs: expect.any(Number),
          verificationLatencyMs: expect.any(Number),
        },
      });
    } finally {
      await kernel.stop();
    }
  });

  it('keeps pure local voice transcription off the Security controller roundtrip', async () => {
    const capturedActionInputs: string[] = [];
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(createSecurityCaptureModule(capturedActionInputs));
    kernel.registerModule(createVoiceTranscribeSmokeModule());
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_voice_audio_fast_path',
        intentId: 'intent_voice_audio_fast_path',
        moduleId: 'voice',
        capabilityId: 'voice.transcribe.audio',
        input: { audioBase64: 'dm9pY2U=', mimeType: 'audio/wav', language: 'ru-RU' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'ui:voice',
      });

      expect(result).toMatchObject({ ok: true, summary: 'Voice smoke transcribed.' });
      expect(capturedActionInputs).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });

  it('keeps every local read, including opaque voice inspection, off the Security controller hot path', async () => {
    const capturedActionInputs: string[] = [];
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(createSecurityCaptureModule(capturedActionInputs));
    kernel.registerModule(createVoiceTranscribeSmokeModule());
    await kernel.start();

    try {
      const audioBase64 = Buffer.alloc(24_000, 7).toString('base64');
      const result = await kernel.execute({
        id: 'exec_voice_audio_redaction',
        intentId: 'intent_voice_audio_redaction',
        moduleId: 'voice',
        capabilityId: 'voice.bridge.inspect',
        input: {
          audioBase64,
          mimeType: 'audio/wav',
          language: 'ru-RU',
          durationMs: 2200,
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'ui:voice',
      });

      expect(result).toMatchObject({ ok: true, summary: 'Voice smoke transcribed.' });
      expect(capturedActionInputs).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });

  it('never forwards Security PIN fields to the internal controller audit check', async () => {
    const capturedActionInputs: string[] = [];
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(createSecurityCaptureModule(capturedActionInputs));
    kernel.registerModule(createWriteModule());
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_pin_redaction',
        intentId: 'intent_pin_redaction',
        moduleId: 'smoke-write',
        capabilityId: 'smoke.write',
        input: {
          path: 'runtime/pin-test.txt',
          pin: '483920',
          newPin: '483920',
          currentPin: '112233',
          confirmation: '483920',
          recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE',
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'ui:security',
      });

      expect(result.ok).toBe(true);
      expect(capturedActionInputs).toHaveLength(1);
      expect(capturedActionInputs[0]).not.toContain('483920');
      expect(capturedActionInputs[0]).not.toContain('112233');
      expect(capturedActionInputs[0]).not.toContain('AAAA-BBBB');
      expect(JSON.parse(capturedActionInputs[0] || '{}')).toEqual({ path: 'runtime/pin-test.txt' });
    } finally {
      await kernel.stop();
    }
  });

  it('does not forward untrusted monarchConfirmed input to the Python controller', async () => {
    const forwarded: Array<{ monarchConfirmed?: boolean }> = [];
    const fakeSecurityClient = {
      config: {
        projectRoot: 'E:\\Monarch\\security',
        configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
        pythonPath: 'python',
        timeoutMs: 30000,
      },
      available: true,
      checkAction: async (input: { monarchConfirmed?: boolean }) => {
        forwarded.push(input);
        return {
          ok: true,
          exitCode: 0,
          args: ['check-action', '--request-file', '<test>'],
          stdout: '',
          stderr: '',
          jsonLines: [{
            ok: false,
            status: 'approval_required',
            report: 'Legacy passkey required.',
            reasons: [],
          }],
        };
      },
    };
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new SecurityModule(fakeSecurityClient as any));
    kernel.registerModule(createDeleteModule());
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_direct_security_controller_confirmed',
        intentId: 'intent_direct_security_controller_confirmed',
        moduleId: 'security',
        capabilityId: 'security.controller.check',
        input: {
          intentText: 'удали runtime/a.txt',
          actionModule: 'smoke-delete',
          actionCapability: 'smoke.delete',
          actionInput: '{"path":"runtime/smoke.txt"}',
          actionRisk: 'delete',
          requestedBy: 'api',
          monarchConfirmed: true,
          noLlm: true,
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
        confirmed: true,
      });

      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]?.monarchConfirmed).toBe(false);
    } finally {
      await kernel.stop();
    }
  });

  it('blocks an unregistered action capability before the Python controller', async () => {
    const forwarded: string[] = [];
    const fakeSecurityClient = {
      config: {
        projectRoot: 'E:\\Monarch\\security',
        configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
        pythonPath: 'python',
        timeoutMs: 30000,
      },
      available: true,
      checkAction: async (input: { actionCapability?: string }) => {
        forwarded.push(input.actionCapability || '');
        return {
          ok: true,
          exitCode: 0,
          args: ['check-action', '--request-file', '<test>'],
          stdout: '',
          stderr: '',
          jsonLines: [{ ok: true, status: 'allowed', report: 'Unexpected allow.' }],
        };
      },
    };
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new SecurityModule(fakeSecurityClient as any));
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_unregistered_security_controller_action',
        intentId: 'intent_unregistered_security_controller_action',
        moduleId: 'security',
        capabilityId: 'security.controller.check',
        input: {
          intentText: 'show device status',
          actionModule: 'device',
          actionCapability: 'device.invented.root',
          actionInput: '{}',
          actionRisk: 'read',
          requestedBy: 'api',
          monarchConfirmed: false,
          noLlm: true,
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
        confirmed: true,
      });

      expect(result.ok).toBe(true);
      expect(result.output).toMatchObject({
        payload: {
          ok: false,
          status: 'blocked',
          disposition: 'hard-deny',
          evidenceCodes: expect.arrayContaining(['capability.unregistered', 'action-guard.hard-boundary']),
          decision: { action: 'block' },
        },
      });
      expect(forwarded).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });

  it('keeps exact Computer Use atoms on the target-aware local Guard instead of the generic Python device rule', async () => {
    const forwarded: string[] = [];
    const fakeSecurityClient = {
      config: {
        projectRoot: 'E:\\Monarch\\security',
        configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
        pythonPath: 'python',
        timeoutMs: 30000,
      },
      available: true,
      checkAction: async (input: { actionCapability?: string }) => {
        forwarded.push(input.actionCapability || '');
        return {
          ok: true,
          exitCode: 0,
          args: ['check-action', '--request-file', '<test>'],
          stdout: '',
          stderr: '',
          jsonLines: [{ ok: false, status: 'approval_required', report: 'Generic device rule.' }],
        };
      },
    };
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
    });
    kernel.registerModule(new SecurityModule(fakeSecurityClient as any));
    kernel.registerModule(createComputerRegistryModule());
    await kernel.start();

    try {
      await kernel.emitRuntimeEvent('security.model_policy.changed', 'security', {
        enabled: true,
        agentSecurityMode: 'guard',
        actionGuardReaction: 'guard',
      });
      const result = await kernel.execute({
        id: 'exec_exact_computer_controller_action',
        intentId: 'intent_exact_computer_controller_action',
        moduleId: 'security',
        capabilityId: 'security.controller.check',
        input: {
          intentText: 'введи текст в тестовое поле',
          actionModule: 'computer',
          actionCapability: 'computer.window.type',
          actionInput: '{"text":"Готово"}',
          actionRisk: 'device-control',
          requestedBy: 'agent:oscar',
          monarchConfirmed: false,
          modelProposed: true,
          actionGuardReaction: 'guard',
          noLlm: true,
          trustedActionContext: {
            schemaVersion: 1,
            sourceModuleId: 'computer',
            target: {
              window: { processName: 'notepad.exe', title: 'QA note' },
              subject: { kind: 'semantic', name: 'Editor', controlType: 'Edit' },
            },
          },
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'system',
        confirmed: true,
      });

      expect(result).toMatchObject({
        ok: true,
        output: { payload: { ok: true, status: 'allowed', disposition: 'informational' } },
      });
      expect(forwarded).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });

  it('keeps ordinary typed Device control on the local Action Guard in Full Access', async () => {
    const forwarded: string[] = [];
    const fakeSecurityClient = {
      config: {
        projectRoot: 'E:\\Monarch\\security',
        configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
        pythonPath: 'python',
        timeoutMs: 30000,
      },
      available: true,
      checkAction: async (input: { actionCapability?: string }) => {
        forwarded.push(input.actionCapability || '');
        return {
          ok: true,
          exitCode: 0,
          args: ['check-action', '--request-file', '<test>'],
          stdout: '',
          stderr: '',
          jsonLines: [{ ok: false, status: 'approval_required', report: 'Legacy blanket device rule.' }],
        };
      },
    };
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
    });
    kernel.registerModule(new SecurityModule(fakeSecurityClient as any));
    kernel.registerModule(createDeviceRegistryModule());
    await kernel.start();

    try {
      const explicit = await kernel.execute({
        id: 'exec_typed_device_controller_action',
        intentId: 'intent_typed_device_controller_action',
        moduleId: 'security',
        capabilityId: 'security.controller.check',
        input: {
          intentText: 'открой Photos',
          actionModule: 'device',
          actionCapability: 'device.app.open',
          actionInput: '{"app":"Photos"}',
          actionRisk: 'device-control',
          requestedBy: 'agent:oscar',
          monarchConfirmed: false,
          modelProposed: true,
          actionGuardReaction: 'guard',
          noLlm: true,
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'system',
        confirmed: true,
      });
      const unrelated = await kernel.execute({
        id: 'exec_unrelated_device_controller_action',
        intentId: 'intent_unrelated_device_controller_action',
        moduleId: 'security',
        capabilityId: 'security.controller.check',
        input: {
          intentText: 'расскажи о Photos',
          actionModule: 'device',
          actionCapability: 'device.app.open',
          actionInput: '{"app":"Photos"}',
          actionRisk: 'device-control',
          requestedBy: 'agent:oscar',
          monarchConfirmed: false,
          modelProposed: true,
          actionGuardReaction: 'guard',
          noLlm: true,
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'system',
        confirmed: true,
      });

      expect(explicit).toMatchObject({
        ok: true,
        output: { payload: { ok: true, status: 'allowed', disposition: 'informational' } },
      });
      expect(unrelated).toMatchObject({
        ok: true,
        output: { payload: { ok: false, status: 'approval_required', disposition: 'owner-confirmable' } },
      });
      expect(forwarded).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });

  it('passes module-resolved live target context to Security outside the model action input', async () => {
    const capturedActionInputs: string[] = [];
    const capturedControllerInputs: Array<Record<string, unknown>> = [];
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
    });
    kernel.registerModule(createSecurityCaptureModule(capturedActionInputs, capturedControllerInputs));
    kernel.registerModule(createTrustedContextWriteModule());
    await kernel.start();

    try {
      await kernel.emitRuntimeEvent('security.model_policy.changed', 'security', {
        enabled: true,
        agentSecurityMode: 'guard',
        actionGuardReaction: 'guard',
      });
      const result = await kernel.execute({
        id: 'exec_trusted_action_context',
        intentId: 'intent_trusted_action_context',
        moduleId: 'trusted-context',
        capabilityId: 'trusted-context.write',
        input: { value: 'model-visible-input' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'agent:oscar',
        proposalId: 'proposal_trusted_context',
        originatingUserText: 'измени тестовое значение',
        executionMode: 'agent-runtime',
        riskVector: {
          effect: 'write',
          scope: 'workspace',
          reversibility: 'compensatable',
          externality: 'trusted-origin',
          privilege: 'elevated',
          data: 'personal',
          novelty: 'new-args',
        },
      });

      expect(result).toMatchObject({ ok: true, summary: 'Trusted context fixture executed.' });
      expect(capturedActionInputs).toEqual(['{"value":"model-visible-input"}']);
      expect(capturedControllerInputs).toHaveLength(1);
      expect(capturedControllerInputs[0]).toMatchObject({
        trustedActionContext: {
          schemaVersion: 1,
          sourceModuleId: 'trusted-context',
          target: { kind: 'live-fixture', label: 'Kernel-owned target' },
        },
      });
      expect(capturedActionInputs[0]).not.toContain('Kernel-owned target');
    } finally {
      await kernel.stop();
    }
  });

  it('keeps exact Action Guard observation active when background Security monitoring is off', async () => {
    const controllerCalls: string[] = [];
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
    });
    kernel.registerModule(createDisabledSecurityModule(controllerCalls));
    kernel.registerModule(createWriteModule());
    await kernel.start();

    try {
      const result = await kernel.execute({
        id: 'exec_write_security_off',
        intentId: 'intent_write_security_off',
        moduleId: 'smoke-write',
        capabilityId: 'smoke.write',
        input: { path: 'runtime/security-off.txt', content: 'ok' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'unit',
      });

      expect(result).toMatchObject({ ok: true, summary: 'Wrote smoke fixture.' });
      expect(controllerCalls).toEqual(['security.controller.check']);
    } finally {
      await kernel.stop();
    }
  });
});

function createDeleteRequest(confirmed: boolean): MonarchExecutionRequest {
  return {
    id: 'exec_delete_confirmed',
    intentId: 'intent_delete_confirmed',
    moduleId: 'smoke-delete',
    capabilityId: 'smoke.delete',
    input: { path: 'runtime/smoke.txt' },
    createdAt: new Date(0).toISOString(),
    requestedBy: 'unit',
    confirmed,
  };
}

function createDeleteModule(): MonarchModule {
  return {
    manifest: {
      id: 'smoke-delete',
      name: 'Smoke Delete',
      version: '0.1.0',
      kind: 'tooling',
      description: 'Test-only destructive module.',
      owns: ['smoke delete'],
      permissions: ['delete'],
      capabilities: [{
        id: 'smoke.delete',
        moduleId: 'smoke-delete',
        title: 'Delete smoke fixture',
        risk: 'delete',
      }],
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'Deleted smoke fixture.' };
    },
  };
}

function createWriteModule(): MonarchModule {
  return {
    manifest: {
      id: 'smoke-write',
      name: 'Smoke Write',
      version: '0.1.0',
      kind: 'tooling',
      description: 'Test-only write module.',
      owns: ['smoke write'],
      permissions: ['write'],
      capabilities: [{
        id: 'smoke.write',
        moduleId: 'smoke-write',
        title: 'Write smoke fixture',
        risk: 'write',
      }],
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'Wrote smoke fixture.' };
    },
  };
}

function createVoiceTranscribeSmokeModule(): MonarchModule {
  return {
    manifest: {
      id: 'voice',
      name: 'Voice Smoke',
      version: '0.1.0',
      kind: 'runtime',
      description: 'Test-only voice transcription module.',
      owns: ['voice'],
      permissions: ['read'],
      capabilities: [
        {
          id: 'voice.transcribe.audio',
          moduleId: 'voice',
          title: 'Transcribe recorded audio',
          risk: 'read',
        },
        {
          id: 'voice.bridge.inspect',
          moduleId: 'voice',
          title: 'Inspect a voice bridge payload',
          risk: 'read',
        },
      ],
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'Voice smoke transcribed.' };
    },
  };
}

function createSecurityApprovalModule(status = 'approval_required'): MonarchModule {
  return {
    manifest: {
      id: 'security',
      name: 'Monarch Security',
      version: '0.1.0',
      kind: 'runtime',
      description: 'Test-only security approval module.',
      owns: ['security'],
      permissions: ['execute'],
      capabilities: [{
        id: 'security.controller.check',
        moduleId: 'security',
        title: 'Review action',
        risk: 'execute',
      }],
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return {
        ok: true,
        summary: 'Security review completed.',
        output: {
          payload: {
            ok: status === 'allowed',
            status,
            disposition: status === 'allowed' ? 'informational' : 'owner-confirmable',
            report: status === 'allowed' ? 'Allowed by security.'
              : status === 'blocked' ? 'Hard boundary violation.'
                : 'Legacy passkey required.',
            ...(status === 'blocked' || status === 'allowed' ? {} : { passkey: 'legacy-passkey' }),
          },
        },
      };
    },
  };
}

function createSecurityCaptureModule(
  capturedActionInputs: string[],
  capturedControllerInputs: Array<Record<string, unknown>> = [],
): MonarchModule {
  return {
    manifest: {
      id: 'security',
      name: 'Monarch Security',
      version: '0.1.0',
      kind: 'runtime',
      description: 'Test-only security capture module.',
      owns: ['security'],
      permissions: ['execute'],
      capabilities: [{
        id: 'security.controller.check',
        moduleId: 'security',
        title: 'Review action',
        risk: 'execute',
      }],
    },
    async activate(): Promise<void> {},
    async executeCapability(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
      const controllerInput = request.input && typeof request.input === 'object'
        ? request.input as Record<string, unknown>
        : {};
      const actionInput = typeof controllerInput.actionInput === 'string'
        ? controllerInput.actionInput
        : '';
      capturedActionInputs.push(actionInput);
      capturedControllerInputs.push(controllerInput);
      return {
        ok: true,
        summary: 'Security capture completed.',
        output: {
          payload: {
            ok: true,
            status: 'allowed',
            disposition: 'informational',
            report: 'Allowed by security capture.',
          },
        },
      };
    },
  };
}

function createTrustedContextWriteModule(): MonarchModule {
  return {
    manifest: {
      id: 'trusted-context',
      name: 'Trusted Context Fixture',
      version: '0.1.0',
      kind: 'tooling',
      description: 'Test-only trusted Security context resolver.',
      owns: ['trusted context'],
      permissions: ['write'],
      capabilities: [{
        id: 'trusted-context.write',
        moduleId: 'trusted-context',
        title: 'Write with trusted target context',
        risk: 'write',
      }],
    },
    async activate(): Promise<void> {},
    resolveSecurityActionContext() {
      return {
        schemaVersion: 1 as const,
        sourceModuleId: 'trusted-context',
        target: { kind: 'live-fixture', label: 'Kernel-owned target' },
      };
    },
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'Trusted context fixture executed.' };
    },
  };
}

function createComputerRegistryModule(): MonarchModule {
  return {
    manifest: {
      id: 'computer',
      name: 'Computer Registry Fixture',
      version: '0.1.0',
      kind: 'domain',
      description: 'Test-only Computer Use registry entry.',
      owns: ['computer'],
      permissions: ['device-control'],
      capabilities: [{
        id: 'computer.window.type',
        moduleId: 'computer',
        title: 'Type in observed window',
        risk: 'device-control',
      }],
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'Computer registry fixture executed.' };
    },
  };
}

function createDeviceRegistryModule(): MonarchModule {
  return {
    manifest: {
      id: 'device',
      name: 'Device Registry Fixture',
      version: '0.1.0',
      kind: 'runtime',
      description: 'Registers ordinary typed Device control for Security tests.',
      owns: ['device registry fixture'],
      permissions: ['device-control'],
      capabilities: [{
        id: 'device.app.open',
        moduleId: 'device',
        title: 'Open application fixture',
        risk: 'device-control',
      }],
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'Device registry fixture.' };
    },
  };
}

function createDisabledSecurityModule(controllerCalls: string[]): MonarchModule {
  return {
    manifest: {
      id: 'security',
      name: 'Monarch Security',
      version: '0.1.0',
      kind: 'runtime',
      description: 'Disabled test Security module.',
      owns: ['security'],
      permissions: ['execute'],
      capabilities: [{
        id: 'security.controller.check',
        moduleId: 'security',
        title: 'Review action',
        risk: 'execute',
      }],
    },
    async activate(context): Promise<void> {
      await context.emit('security.activated', 'security', {
        securityLevel: 'off',
        actionGuardReaction: 'observe',
      });
    },
    async executeCapability(): Promise<MonarchExecutionResult> {
      controllerCalls.push('security.controller.check');
      return {
        ok: true,
        summary: 'Unexpected controller call.',
        output: { payload: { ok: true, status: 'allowed', disposition: 'informational', report: 'Allowed.' } },
      };
    },
  };
}
