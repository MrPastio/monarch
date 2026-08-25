import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MonarchSettingsCommandError,
  SettingsCommandBus,
  type MonarchSettingsBackend,
} from '../../src/settings';

const HASH = 'a'.repeat(64);

describe('SettingsCommandBus', () => {
  it('allows only attested Desktop calls and verifies the durable receipt', async () => {
    const backend: MonarchSettingsBackend = {
      read: vi.fn(async (request) => ({
        ...request,
        revision: 1,
        contentHash: HASH,
        value: { records: [] },
      })),
      execute: vi.fn(async (request) => ({
        schemaVersion: 1,
        receiptId: 'settings_receipt_test',
        clientRequestId: request.clientRequestId,
        command: request.command,
        scope: request.scope,
        revision: 1,
        contentHash: HASH,
        readBackHash: HASH,
        policyDecisionHash: request.policyDecisionHash,
        committedAt: new Date(0).toISOString(),
        replayed: false,
        result: { record: { id: 'memory_1' } },
      })),
    };
    const bus = new SettingsCommandBus(backend, {
      evaluateLocalSettingsCommand: () => ({
        outcome: 'allow',
        reason: 'data-only',
        policyDecisionHash: HASH,
      }),
    });

    await expect(bus.execute({
      schemaVersion: 1,
      clientRequestId: 'settings_request_1',
      command: 'memory.create',
      scope: { type: 'chat' },
      expectedRevision: 0,
      payload: { text: 'remember me' },
    }, 'api')).rejects.toMatchObject({ code: 'settings-desktop-required' });

    await expect(bus.execute({
      schemaVersion: 1,
      clientRequestId: 'settings_request_1',
      command: 'memory.create',
      scope: { type: 'chat' },
      expectedRevision: 0,
      payload: { text: 'remember me' },
    }, 'desktop')).resolves.toMatchObject({
      contentHash: HASH,
      readBackHash: HASH,
      policyDecisionHash: HASH,
    });
  });

  it('rejects a receipt whose committed and read-back hashes differ', async () => {
    const backend: MonarchSettingsBackend = {
      read: vi.fn(),
      execute: vi.fn(async (request) => ({
        schemaVersion: 1,
        receiptId: 'settings_receipt_bad',
        clientRequestId: request.clientRequestId,
        command: request.command,
        scope: request.scope,
        revision: 1,
        contentHash: HASH,
        readBackHash: 'b'.repeat(64),
        policyDecisionHash: request.policyDecisionHash,
        committedAt: new Date(0).toISOString(),
        replayed: false,
        result: {},
      })),
    };
    const bus = new SettingsCommandBus(backend, {
      evaluateLocalSettingsCommand: () => ({ outcome: 'allow', reason: 'ok', policyDecisionHash: HASH }),
    });

    await expect(bus.execute({
      schemaVersion: 1,
      clientRequestId: 'settings_request_bad',
      command: 'profile.update',
      scope: { type: 'chat' },
      expectedRevision: 0,
      payload: { adaptiveSummary: 'x' },
    }, 'desktop')).rejects.toBeInstanceOf(MonarchSettingsCommandError);
  });

  it('exposes prompts and DEV settings only to a verified signed owner', async () => {
    const backend: MonarchSettingsBackend = {
      read: vi.fn(async (request) => ({
        ...request,
        revision: 0,
        contentHash: HASH,
        value: {},
      })),
      execute: vi.fn(async (request) => ({
        schemaVersion: 1,
        receiptId: 'settings_receipt_owner_override',
        clientRequestId: request.clientRequestId,
        command: request.command,
        scope: request.scope,
        revision: request.expectedRevision + 1,
        contentHash: HASH,
        readBackHash: HASH,
        policyDecisionHash: request.policyDecisionHash,
        committedAt: new Date(0).toISOString(),
        replayed: false,
        result: { enabled: true },
      })),
    };
    const policy = {
      evaluateLocalSettingsCommand: () => ({ outcome: 'allow' as const, reason: 'owner', policyDecisionHash: HASH }),
    };
    const publicBus = new SettingsCommandBus(backend, policy);
    const ownerBus = new SettingsCommandBus(backend, policy, {
      tier: 'owner',
      source: 'signed-device-entitlement',
    });
    const request = { schemaVersion: 1 as const, kind: 'prompts' as const, scope: { type: 'chat' as const } };

    await expect(publicBus.read(request, 'desktop')).rejects.toMatchObject({ code: 'settings-owner-required' });
    await expect(ownerBus.read(request, 'desktop')).resolves.toMatchObject({ kind: 'prompts' });
    await expect(publicBus.read({ ...request, kind: 'owner-override' }, 'desktop'))
      .rejects.toMatchObject({ code: 'settings-owner-required' });
    await expect(ownerBus.read({ ...request, kind: 'owner-override' }, 'api'))
      .rejects.toMatchObject({ code: 'settings-desktop-required' });
    await expect(ownerBus.read({ ...request, kind: 'owner-override' }, 'desktop'))
      .resolves.toMatchObject({ kind: 'owner-override' });

    const ownerOverrideWrite = {
      schemaVersion: 1 as const,
      clientRequestId: 'owner_override_desktop_only',
      command: 'owner-override.update' as const,
      scope: { type: 'chat' as const },
      expectedRevision: 0,
      payload: { enabled: true, lifetime: 'session', shellApprovalPolicy: 'risk-based' },
    };
    await expect(publicBus.execute(ownerOverrideWrite, 'desktop'))
      .rejects.toMatchObject({ code: 'settings-owner-required' });
    await expect(ownerBus.execute(ownerOverrideWrite, 'api'))
      .rejects.toMatchObject({ code: 'settings-desktop-required' });
    await expect(ownerBus.execute(ownerOverrideWrite, 'desktop'))
      .resolves.toMatchObject({
        command: 'owner-override.update',
        policyDecisionHash: HASH,
        contentHash: HASH,
        readBackHash: HASH,
      });
  });

  it('keeps Personality and Memory UI writes out of the legacy Agent adapter', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'src', 'ui', 'public', 'modules', 'settings-pane.js'),
      'utf8',
    );
    expect(source).toContain("writeLocalSettings('personality.profile.create'");
    expect(source).toContain("writeLocalSettings('personality.profile.update'");
    expect(source).toContain("writeLocalSettings('personality.profile.select'");
    expect(source).toContain("writeLocalSettings('personality.personalization.set'");
    expect(source).toContain("writeLocalSettings('memory.create'");
    expect(source).not.toContain("runCapability('personality'");
    expect(source).not.toContain("runCapability('memory'");
  });
});
