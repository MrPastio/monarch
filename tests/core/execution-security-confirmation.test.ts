import { describe, expect, it } from 'vitest';
import {
  MonarchKernel,
  type MonarchExecutionRequest,
  type MonarchExecutionResult,
  type MonarchModule,
} from '../../src/core';
import { SecurityModule } from '../../src/modules/security';

describe('Monarch Access and Monarch Security confirmation', () => {
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

  it('lets the user override a Security block for the exact confirmed request', async () => {
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(createSecurityApprovalModule('blocked'));
    kernel.registerModule(createDeleteModule());
    await kernel.start();

    try {
      const blocked = await kernel.execute(createDeleteRequest(true));
      expect(blocked).toMatchObject({
        ok: false,
        error: 'confirmation-required',
        metadata: { status: 'blocked', securityOverride: true },
      });
      const result = await kernel.execute({
        ...createDeleteRequest(true),
        securityOverrideConfirmed: true,
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

  it('keeps the exact deterministic UI volume action off the Security LLM roundtrip', async () => {
    const capturedActionInputs: string[] = [];
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
    });
    kernel.registerModule(createSecurityCaptureModule(capturedActionInputs));
    kernel.registerModule(createVoiceVolumeSmokeModule());
    await kernel.start();

    try {
      const directVoice = await kernel.execute({
        id: 'exec_voice_volume_fast_path',
        intentId: 'intent_voice_volume_fast_path',
        moduleId: 'voice',
        capabilityId: 'voice.mode.execute-scripted',
        input: { text: 'Поставь громкость на максимум' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'ui:voice-mode',
      });
      const nonUiCaller = await kernel.execute({
        id: 'exec_voice_volume_api',
        intentId: 'intent_voice_volume_api',
        moduleId: 'voice',
        capabilityId: 'voice.mode.execute-scripted',
        input: { text: 'Поставь громкость на максимум' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'api',
      });

      expect(directVoice).toMatchObject({ ok: true, summary: 'Verified volume action.' });
      expect(nonUiCaller).toMatchObject({ ok: true, summary: 'Verified volume action.' });
      expect(capturedActionInputs).toHaveLength(1);
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
    await kernel.start();

    try {
      await kernel.execute({
        id: 'exec_direct_security_controller_confirmed',
        intentId: 'intent_direct_security_controller_confirmed',
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
        confirmed: true,
      });

      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]?.monarchConfirmed).toBe(false);
    } finally {
      await kernel.stop();
    }
  });

  it('does not run controller checks after the user explicitly disables Security', async () => {
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
      expect(controllerCalls).toEqual([]);
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

function createVoiceVolumeSmokeModule(): MonarchModule {
  return {
    manifest: {
      id: 'voice',
      name: 'Voice Volume Smoke',
      version: '0.1.0',
      kind: 'runtime',
      description: 'Test-only deterministic volume module.',
      owns: ['voice'],
      permissions: ['read', 'execute'],
      capabilities: [{
        id: 'voice.mode.execute-scripted',
        moduleId: 'voice',
        title: 'Execute scripted voice command',
        risk: 'read',
      }],
    },
    resolveCapabilityRisk(): 'execute' {
      return 'execute';
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'Verified volume action.' };
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

function createSecurityCaptureModule(capturedActionInputs: string[]): MonarchModule {
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
      const actionInput = typeof (request.input as { actionInput?: unknown })?.actionInput === 'string'
        ? (request.input as { actionInput: string }).actionInput
        : '';
      capturedActionInputs.push(actionInput);
      return {
        ok: true,
        summary: 'Security capture completed.',
        output: {
          payload: {
            ok: true,
            status: 'allowed',
            report: 'Allowed by security capture.',
          },
        },
      };
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
      await context.emit('security.activated', 'security', { securityLevel: 'off' });
    },
    async executeCapability(): Promise<MonarchExecutionResult> {
      controllerCalls.push('security.controller.check');
      return {
        ok: true,
        summary: 'Unexpected controller call.',
        output: { payload: { ok: true, status: 'allowed', report: 'Allowed.' } },
      };
    },
  };
}
