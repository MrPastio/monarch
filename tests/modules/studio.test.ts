import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonarchExecutionRequest, MonarchKernelContext } from '../../src/core';
import { StudioModule, createStudioProject } from '../../src/modules/studio';
import { studioManifest } from '../../src/modules/studio/manifest';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Monarch Studio', () => {
  it('publishes Monarch Studio as an alpha module', () => {
    expect(studioManifest.stage).toBe('alpha');
    expect(studioManifest.parentSuiteId).toBe('monarch-modules');
  });

  it('creates and validates a versioned local project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-studio-'));
    temporaryRoots.push(root);
    const projectsRoot = path.join(root, 'artifacts', 'studio', 'projects');
    const module = new StudioModule({ workspaceRoot: root, projectsRoot });

    const result = await module.executeCapability(createRequest('studio.project.create', {
      name: 'Summer Poster',
      mode: 'photo',
      width: 2048,
      height: 2048,
    }), createTestContext());

    expect(result.ok).toBe(true);
    const output = result.output as { path: string; project: { version: number; mode: string } };
    expect(output.project).toMatchObject({ version: 1, mode: 'photo' });
    const stored = JSON.parse(await readFile(output.path, 'utf8')) as Record<string, unknown>;
    expect(stored.format).toBe('monarch-studio');
  });

  it('keeps Remotion optional in a template export plan', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-studio-'));
    temporaryRoots.push(root);
    const module = new StudioModule({ workspaceRoot: root });

    const result = await module.executeCapability(createRequest('studio.export.plan', {
      mode: 'video',
      format: 'mp4',
      templateDriven: true,
    }), createTestContext());

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      compatibilityFallback: 'user-provided-ffmpeg',
      templateAdapter: 'remotion-optional-license-required',
      licenseReviewRequired: true,
    });
  });

  it('exposes edit and history capabilities through the module contract', async () => {
    const project = createStudioProject({ name: 'Capability Edit', mode: 'photo' });
    expect(project).not.toBeNull();
    if (!project) return;
    const module = new StudioModule();

    const edited = await module.executeCapability(createRequest('studio.edit.apply', {
      project,
      edit: {
        scope: 'photo',
        operation: { type: 'photo.canvas.background', background: '#ff9d2e' },
      },
    }), createTestContext());
    expect(edited.ok).toBe(true);
    const editedProject = (edited.output as { project: typeof project }).project;
    expect(editedProject.canvas.background).toBe('#ff9d2e');

    const undone = await module.executeCapability(createRequest('studio.history.step', {
      project: editedProject,
      direction: 'undo',
    }), createTestContext());
    expect(undone.ok).toBe(true);
    expect((undone.output as { project: typeof project }).project.canvas.background).toBe('#101010');
  });
});

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
