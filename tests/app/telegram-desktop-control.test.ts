import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MonarchApplication, type TelegramDesktopControlAction } from '../../src/app/application';
import { TelegramModule } from '../../src/modules/telegram';
import { InMemoryOscarTurnStore, OscarTurnCoordinator } from '../../src/oscar-turn';

describe('Telegram Desktop Control', () => {
  it('transcribes a Telegram voice note ephemerally before durable Turn admission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-telegram-voice-application-'));
    const runtimeDir = path.join(root, 'runtime');
    const statePath = path.join(root, 'data', 'local', 'telegram-state.json');
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(path.join(runtimeDir, 'telegram-voice-stt.cjs'), [
      "const { readFileSync } = require('node:fs');",
      "const audio = readFileSync(process.argv[2]);",
      "if (audio.subarray(0, 4).toString('ascii') !== 'OggS') process.exit(2);",
      "console.log(JSON.stringify({ text: 'создай локальный файл voice-result.txt' }));",
    ].join('\n'), 'utf8');
    await writeFile(statePath, JSON.stringify({
      offset: 0,
      pairings: [{ chatId: 55, userId: 9, pairedAt: new Date(0).toISOString() }],
      reminders: [], pendingTaskDeliveries: [], remotePaused: false, pairingAttempts: {},
    }), 'utf8');
    const previousCommand = process.env.MONARCH_STT_TRANSCRIBE_COMMAND;
    const previousDisable = process.env.MONARCH_DISABLE_DEFAULT_STT;
    process.env.MONARCH_STT_TRANSCRIBE_COMMAND = 'node runtime/telegram-voice-stt.cjs {audio} {language}';
    process.env.MONARCH_DISABLE_DEFAULT_STT = '1';
    const coordinator = new OscarTurnCoordinator({
      persistentStore: new InMemoryOscarTurnStore(),
      volatileStore: new InMemoryOscarTurnStore(),
      dispositionProvider: { classify: async () => ({ lane: 'agent', kind: 'operation', confidence: 1, reason: 'fixture' }) },
      answerExecutor: async () => { throw new Error('answer-execution-forbidden'); },
      persistMessage: async () => undefined,
    });
    const app = new MonarchApplication({ workspaceRoot: root,
      enabledModules: ['security', 'voice', 'telegram'], oscarTurnCoordinator: coordinator });
    const rawAudio = Buffer.concat([Buffer.from('OggS'), Buffer.from('ephemeral-telegram-voice')]);
    try {
      await app.start();
      const telegram = app.runtime.kernel.getModule('telegram') as TelegramModule;
      const internals = telegram as unknown as {
        callApi(method: string, parameters: Record<string, unknown>): Promise<unknown>;
        downloadTelegramFile(filePath: string, signal?: AbortSignal): Promise<Buffer>;
        handleUpdate(update: unknown): Promise<void>;
      };
      let messageId = 500;
      const apiCalls: Array<{ method: string; parameters: Record<string, unknown> }> = [];
      internals.callApi = async (method, parameters) => {
        apiCalls.push({ method, parameters });
        if (method === 'getFile') return { file_path: 'voice/fixture.ogg', file_size: rawAudio.byteLength };
        return { message_id: messageId++, chat: { id: Number(parameters.chat_id || 55), type: 'private' } };
      };
      internals.downloadTelegramFile = async () => rawAudio;

      await internals.handleUpdate({ update_id: 1,
        message: { message_id: 101, chat: { id: 55, type: 'private' }, from: { id: 9 },
          voice: { file_id: 'voice_fixture', file_unique_id: 'voice_unique', duration: 8,
            mime_type: 'audio/ogg', file_size: rawAudio.byteLength } } });

      const checkpoint = await app.oscarTurnCoordinator.findTurnByClientRequestId({
        clientRequestId: 'telegram:55:101', source: 'telegram', privacyMode: 'persistent',
      });
      expect(checkpoint?.turn.request.text, JSON.stringify(apiCalls, null, 2))
        .toBe('создай локальный файл voice-result.txt');
      const durableText = [
        await readTreeText(app.runtimePaths.dataRoot),
        await readTreeText(app.runtimePaths.stateRoot),
      ].join('\n');
      expect(durableText).not.toContain(rawAudio.toString('base64'));
      const temporaryVoiceRoot = path.join(app.runtimePaths.dataRoot, 'temporary', 'voice');
      await expect(readdir(temporaryVoiceRoot)).resolves.toEqual([]);
    } finally {
      await app.stop().catch(() => undefined);
      restoreEnv('MONARCH_STT_TRANSCRIBE_COMMAND', previousCommand);
      restoreEnv('MONARCH_DISABLE_DEFAULT_STT', previousDisable);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes one exact attested UI action through Kernel without Agent planning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-telegram-desktop-control-'));
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['security', 'telegram'],
    });
    await app.start();
    try {
      const paused = await app.executeTelegramDesktopControl('pause');
      expect(paused, JSON.stringify(paused, null, 2)).toMatchObject({
        ok: true,
        output: { remotePaused: true },
      });
      await expect(app.executeTelegramDesktopControl('resume')).resolves.toMatchObject({
        ok: true,
        output: { remotePaused: false },
      });
      await expect(app.executeTelegramDesktopControl('rotate-pairing')).resolves.toMatchObject({
        ok: true,
        output: { pairingCode: expect.stringMatching(/^\d{6}$/u) },
      });
      await expect(app.executeTelegramDesktopControl('telegram.api.call' as TelegramDesktopControlAction))
        .rejects.toMatchObject({ code: 'telegram-control-action-invalid' });
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies an attested zero-retention update to stored Telegram reminders immediately', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-telegram-zero-retention-control-'));
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['security', 'telegram'],
      authorityContext: {
        tier: 'owner', source: 'signed-device-entitlement', entitlementId: 'telegram_zero_retention_test',
        keyId: 'owner-root-test', verifiedAt: new Date(0).toISOString(), deviceIdPrefix: '0123456789ab',
        diagnostic: null,
      },
    });
    await app.start();
    const statePath = path.join(app.runtimePaths.dataRoot, 'telegram-state.json');
    const secret = 'remove this reminder through the application policy hook';
    try {
      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({
        offset: 0,
        pairings: [{ chatId: 1001, userId: 2002, pairedAt: new Date(0).toISOString() }],
        reminders: [{ id: 'app-policy', chatId: 1001, text: secret,
          dueAt: '2030-01-01T12:00:00Z', createdAt: new Date(0).toISOString() }],
        pendingTaskDeliveries: [], remotePaused: false, pairingAttempts: {},
      }), 'utf8');
      const current = await app.settingsCommandBus.read({
        schemaVersion: 1, kind: 'dev', scope: { type: 'chat' },
      }, 'desktop');
      await app.settingsCommandBus.execute({
        schemaVersion: 1,
        clientRequestId: 'telegram_zero_retention_update',
        command: 'dev.update',
        scope: { type: 'chat' },
        expectedRevision: current.revision,
        payload: { patch: { zeroRetentionEnabled: true } },
      }, 'desktop');

      const persisted = await readFile(statePath, 'utf8');
      expect(persisted).not.toContain(secret);
      expect(JSON.parse(persisted)).toMatchObject({
        pairings: [{ chatId: 1001, userId: 2002 }],
        reminders: [],
      });
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readTreeText(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    try {
      chunks.push(await readFile(path.join(root, String(entry)), 'utf8'));
    } catch {
      // Directories and non-text artifacts do not contribute durable payload text.
    }
  }
  return chunks.join('\n');
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
