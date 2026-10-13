import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import { DeviceModule, deviceModulePackage } from '../../src/modules/device';
import { createDeterministicSecurityModule } from '../fixtures/agent/deterministic-security-module';
import {
  VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION,
  VoiceInformationProviderService,
} from '../../src/modules/voice';
import type { SettingsCommandBus } from '../../src/settings';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Simplified Voice application execution', () => {
  it('opens an adaptively resolved installed application without an approval round trip', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-simplified-voice-'));
    roots.push(root);
    const runner = vi.fn(async (script: string) => JSON.stringify(
      script.includes('$entries = New-Object')
        ? {
            entries: [{
              name: 'YouTube Music',
              launchId: 'https://music.youtube.com/',
              source: 'web-shortcut',
            }],
          }
        : {
            opened: true,
            verified: true,
            displayName: 'YouTube Music',
            processId: 42,
            launcher: 'web-shortcut',
          },
    ));
    const app = new MonarchApplication({
      workspaceRoot: root,
      packages: [{ ...deviceModulePackage, factory: () => new DeviceModule(runner) }],
      enableLocalSystemRouter: false,
      permissionProfile: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        autonomyMode: 'workspace-autonomous',
      },
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      const result = await app.executeSimplifiedVoiceCommand('Оскар, открой музыку');
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        mode: 'simplified',
        status: 'completed',
        performed: true,
        verified: true,
        capabilityId: 'device.app.open',
        output: {
          resolvedName: 'YouTube Music',
          semanticRole: 'media.music',
          authoritative: true,
        },
      });
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      await app.stop();
    }
  });

  it('never executes a destructive command through the convenience allowlist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-simplified-voice-'));
    roots.push(root);
    const runner = vi.fn(async () => '{}');
    const app = new MonarchApplication({
      workspaceRoot: root,
      packages: [{ ...deviceModulePackage, factory: () => new DeviceModule(runner) }],
      enableLocalSystemRouter: false,
    });
    app.runtime.kernel.registerModule(createDeterministicSecurityModule());
    await app.start();
    try {
      await expect(app.executeSimplifiedVoiceCommand('очисти корзину')).resolves.toMatchObject({
        ok: false,
        status: 'unsupported',
        reason: 'destructive-command-not-simplified',
        performed: false,
      });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      await app.stop();
    }
  });

  it('fails closed before any provider request when current consent is absent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-simplified-voice-'));
    roots.push(root);
    const fetcher = vi.fn();
    const app = new MonarchApplication({
      workspaceRoot: root,
      enableLocalSystemRouter: false,
      settingsCommandBus: voiceSettingsBus({ informationProvidersEnabled: false }),
      voiceInformationProviderService: new VoiceInformationProviderService(fetcher as typeof fetch),
    });
    await app.start();
    try {
      await expect(app.executeSimplifiedVoiceCommand('погода завтра')).resolves.toMatchObject({
        ok: false,
        status: 'consent-required',
        reason: 'provider-consent-required',
      });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await app.stop();
    }
  });

  it('returns an attributed verified card after exact versioned consent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-simplified-voice-'));
    roots.push(root);
    const fetcher = vi.fn(async () => new Response(JSON.stringify([
      { cc: 'USD', rate: 41.25, exchangedate: '29.08.2026' },
    ])));
    const app = new MonarchApplication({
      workspaceRoot: root,
      enableLocalSystemRouter: false,
      settingsCommandBus: voiceSettingsBus({
        informationProvidersEnabled: true,
        informationProviderAgreementVersion: VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION,
        informationProviderConsentedAt: '2026-08-29T12:00:00.000Z',
      }),
      voiceInformationProviderService: new VoiceInformationProviderService(fetcher as typeof fetch),
    });
    await app.start();
    try {
      await expect(app.executeSimplifiedVoiceCommand('курс доллара')).resolves.toMatchObject({
        ok: true,
        status: 'completed',
        performed: false,
        verified: true,
        provider: 'НБУ',
        card: { kind: 'exchange-rate', provider: { name: 'НБУ' } },
      });
    } finally {
      await app.stop();
    }
  });
});

function voiceSettingsBus(input: Record<string, unknown>): SettingsCommandBus {
  return {
    read: vi.fn(async () => ({
      schemaVersion: 1,
      kind: 'voice',
      scope: { type: 'chat' },
      revision: 1,
      contentHash: 'a'.repeat(64),
      value: { input },
    })),
    execute: vi.fn(),
  } as unknown as SettingsCommandBus;
}
