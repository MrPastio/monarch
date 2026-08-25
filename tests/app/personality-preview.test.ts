import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app/application';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Personality V2 runtime preview', () => {
  it('does not present a runtime recovery response as a personality sample', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-personality-preview-'));
    roots.push(root);
    const app = new MonarchApplication({ workspaceRoot: root });
    const internal = app as any;
    internal.started = true;
    internal.readPersonalityContext = async () => ({
      scope: { type: 'chat' },
      settingsRevision: 7,
      context: personalityContext(),
    });
    internal.contextClient.chat = async () => ({
      answer: 'Technical recovery text that must not become a preview.',
      usage: { runtime_recovery: true },
    });

    await expect(app.previewPersonality({ type: 'chat' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'personality-preview-runtime-unavailable',
    });
  });

  it('returns a real answer-runtime result when generation completed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-personality-preview-'));
    roots.push(root);
    const app = new MonarchApplication({ workspaceRoot: root });
    const internal = app as any;
    internal.started = true;
    internal.readPersonalityContext = async () => ({
      scope: { type: 'chat' },
      settingsRevision: 8,
      context: personalityContext(),
    });
    internal.contextClient.chat = async () => ({
      answer: 'Короткий проверенный пример.',
      usage: { runtime_recovery: false },
    });

    await expect(app.previewPersonality({ type: 'chat' })).resolves.toMatchObject({
      settingsRevision: 8,
      answer: 'Короткий проверенный пример.',
    });
  });
});

function personalityContext() {
  return {
    schemaVersion: 2 as const,
    profileId: 'profile-direct',
    profileRevision: 3,
    profileHash: 'a'.repeat(64),
    variant: 'direct' as const,
    name: 'Прямой',
    dimensions: {
      brevity: 70,
      warmth: 55,
      directness: 88,
      initiative: 62,
      humor: 25,
      skepticism: 70,
      technicalDepth: 75,
      structure: 72,
    },
    addressForm: 'ты' as const,
    language: 'ru' as const,
    customRules: [],
  };
}
