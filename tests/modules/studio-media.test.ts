import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonarchExecutionRequest, MonarchKernelContext } from '../../src/core';
import {
  StudioModule,
  applyStudioEdit,
  createStudioProject,
} from '../../src/modules/studio';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Monarch Studio media adapters', () => {
  it('renders a photo project to a real PNG with Fabric.js', async () => {
    const root = await createTemporaryRoot();
    const exportsRoot = path.join(root, 'artifacts', 'studio', 'exports');
    const module = new StudioModule({ workspaceRoot: root, exportsRoot });
    const project = createStudioProject({
      name: 'Orange Card',
      mode: 'photo',
      width: 320,
      height: 180,
      background: '#101010',
    });
    expect(project).not.toBeNull();
    if (!project) return;

    const withShape = applyStudioEdit(project, {
      scope: 'photo',
      operation: {
        type: 'photo.object.add',
        object: {
          id: 'orange-card',
          kind: 'shape',
          name: 'Orange card',
          shape: 'rectangle',
          x: 32,
          y: 28,
          width: 256,
          height: 124,
          fill: '#ff9d2e',
          stroke: '#ffffff',
          strokeWidth: 2,
        },
      },
    });
    expect(withShape.ok).toBe(true);
    if (!withShape.ok) return;

    const result = await module.executeCapability(createRequest('studio.photo.export', {
      project: withShape.project,
      format: 'png',
      filename: 'orange-card.png',
    }), createTestContext());
    expect(result.ok).toBe(true);
    const output = result.output as { path: string; width: number; height: number; sizeBytes: number };
    expect(output).toMatchObject({ width: 320, height: 180 });
    expect(output.sizeBytes).toBeGreaterThan(100);

    const image = await readFile(output.path);
    expect(image.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(image.readUInt32BE(16)).toBe(320);
    expect(image.readUInt32BE(20)).toBe(180);

    const duplicate = await module.executeCapability(createRequest('studio.photo.export', {
      project: withShape.project,
      format: 'png',
      filename: 'orange-card.png',
    }), createTestContext());
    expect(duplicate).toMatchObject({ ok: false, error: 'studio-photo-export-failed' });
  }, 45_000);

  it('applies the project crop during JPEG export', async () => {
    const root = await createTemporaryRoot();
    const module = new StudioModule({
      workspaceRoot: root,
      exportsRoot: path.join(root, 'artifacts', 'studio', 'exports'),
    });
    const project = createStudioProject({ name: 'Crop', mode: 'photo', width: 200, height: 120 });
    expect(project).not.toBeNull();
    if (!project) return;
    const cropped = applyStudioEdit(project, {
      scope: 'photo',
      operation: { type: 'photo.crop.set', crop: { x: 20, y: 10, width: 80, height: 60 } },
    });
    expect(cropped.ok).toBe(true);
    if (!cropped.ok) return;

    const result = await module.executeCapability(createRequest('studio.photo.export', {
      project: cropped.project,
      format: 'jpeg',
      filename: 'crop.jpg',
      quality: 0.8,
    }), createTestContext());
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ width: 80, height: 60, mimeType: 'image/jpeg' });
    const output = result.output as { path: string };
    const image = await readFile(output.path);
    expect([...image.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('probes local audio metadata with Mediabunny without loading the whole file', async () => {
    const root = await createTemporaryRoot();
    const mediaPath = path.join(root, 'tone.wav');
    await writeFile(mediaPath, createSilentWav(8_000, 800));
    const module = new StudioModule({ workspaceRoot: root });

    const result = await module.executeCapability(createRequest('studio.media.probe', {
      path: mediaPath,
    }), createTestContext());
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      mimeType: 'audio/wav',
      durationMs: 100,
      video: null,
      audio: {
        codec: 'pcm-s16',
        sampleRate: 8_000,
        channels: 1,
      },
    });
  });

  it('blocks media paths outside the Monarch workspace', async () => {
    const root = await createTemporaryRoot();
    const outsideRoot = await createTemporaryRoot();
    const mediaPath = path.join(outsideRoot, 'tone.wav');
    await writeFile(mediaPath, createSilentWav(8_000, 80));
    const module = new StudioModule({ workspaceRoot: root });

    const result = await module.executeCapability(createRequest('studio.media.probe', {
      path: mediaPath,
    }), createTestContext());
    expect(result).toMatchObject({ ok: false, error: 'studio-media-probe-failed' });
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'monarch-studio-media-'));
  temporaryRoots.push(root);
  return root;
}

function createSilentWav(sampleRate: number, sampleCount: number): Buffer {
  const bitsPerSample = 16;
  const channels = 1;
  const dataBytes = sampleCount * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function createRequest(capabilityId: string, input: unknown): MonarchExecutionRequest {
  return {
    id: 'test-request',
    intentId: 'test-intent',
    moduleId: 'studio',
    capabilityId,
    input,
    createdAt: new Date().toISOString(),
    requestedBy: 'test',
    confirmed: true,
  };
}

function createTestContext(): MonarchKernelContext {
  return {
    emit: async (type, source, payload) => ({
      id: 'test-event',
      type,
      source,
      createdAt: new Date().toISOString(),
      payload,
    }),
  } as MonarchKernelContext;
}
