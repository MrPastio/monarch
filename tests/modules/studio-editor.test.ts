import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonarchExecutionRequest, MonarchKernelContext } from '../../src/core';
import {
  StudioModule,
  applyStudioEdit,
  createStudioProject,
  stepStudioHistory,
  validateStudioProject,
  type StudioImageObject,
} from '../../src/modules/studio';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Monarch Studio editor core', () => {
  it('applies photo layer/filter edits and supports undo and redo', () => {
    const project = createStudioProject({ name: 'Photo Edit', mode: 'photo' });
    expect(project).not.toBeNull();
    if (!project) return;

    const added = applyStudioEdit(project, {
      scope: 'photo',
      label: 'Добавить фото',
      operation: {
        type: 'photo.object.add',
        object: {
          kind: 'image',
          name: 'Portrait',
          source: 'E:\\Media\\portrait.jpg',
          width: 1200,
          height: 800,
        },
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const image = added.project.photo.objects[0] as StudioImageObject;

    const filtered = applyStudioEdit(added.project, {
      scope: 'photo',
      label: 'Сделать ярче',
      operation: {
        type: 'photo.object.update',
        objectId: image.id,
        patch: { filters: { brightness: 0.35, contrast: 0.1 } },
      },
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect((filtered.project.photo.objects[0] as StudioImageObject).filters).toMatchObject({
      brightness: 0.35,
      contrast: 0.1,
    });
    expect(filtered.project.history).toMatchObject({ cursor: 1 });

    const selected = applyStudioEdit(filtered.project, {
      scope: 'photo',
      operation: { type: 'photo.selection.set', objectIds: [image.id] },
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.project.history).toMatchObject({ cursor: 1 });

    const undone = stepStudioHistory(selected.project, 'undo');
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect((undone.project.photo.objects[0] as StudioImageObject).filters.brightness).toBe(0);

    const redone = stepStudioHistory(undone.project, 'redo');
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect((redone.project.photo.objects[0] as StudioImageObject).filters.brightness).toBe(0.35);
  });

  it('builds a basic video timeline and splits a clip non-destructively', () => {
    const project = createStudioProject({
      name: 'Video Edit',
      mode: 'video',
      durationMs: 8_000,
      fps: 30,
    });
    expect(project).not.toBeNull();
    if (!project) return;

    const withTrack = applyStudioEdit(project, {
      scope: 'video',
      operation: {
        type: 'video.track.add',
        track: { id: 'video-main', kind: 'video', name: 'Основное видео' },
      },
    });
    expect(withTrack.ok).toBe(true);
    if (!withTrack.ok) return;

    const withClip = applyStudioEdit(withTrack.project, {
      scope: 'video',
      operation: {
        type: 'video.clip.add',
        trackId: 'video-main',
        clip: {
          id: 'clip-main',
          kind: 'video',
          name: 'Intro',
          source: 'E:\\Media\\intro.mp4',
          startMs: 0,
          durationMs: 5_000,
        },
      },
    });
    expect(withClip.ok).toBe(true);
    if (!withClip.ok) return;

    const split = applyStudioEdit(withClip.project, {
      scope: 'video',
      label: 'Разделить клип',
      operation: {
        type: 'video.clip.split',
        trackId: 'video-main',
        clipId: 'clip-main',
        atMs: 2_000,
      },
    });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.project.video.tracks[0]?.clips).toHaveLength(2);
    expect(split.project.video.tracks[0]?.clips[1]).toMatchObject({
      startMs: 2_000,
      durationMs: 3_000,
      sourceOffsetMs: 2_000,
    });

    const undone = stepStudioHistory(split.project, 'undo');
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.project.video.tracks[0]?.clips).toHaveLength(1);
  });

  it('saves only validated projects inside the Studio project root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-studio-editor-'));
    temporaryRoots.push(root);
    const projectsRoot = path.join(root, 'artifacts', 'studio', 'projects');
    const module = new StudioModule({ workspaceRoot: root, projectsRoot });
    const project = createStudioProject({ name: 'Saved Photo', mode: 'photo' });
    expect(project).not.toBeNull();
    if (!project) return;

    const target = path.join(projectsRoot, 'saved.monarch-studio.json');
    const saved = await module.executeCapability(
      createRequest('studio.project.save', { project, path: target }),
      createTestContext()
    );
    expect(saved.ok).toBe(true);
    const stored = JSON.parse(await readFile(target, 'utf8')) as { id: string; history: { cursor: number } };
    expect(stored).toMatchObject({ id: project.id, history: { cursor: -1 } });

    const renamed = applyStudioEdit(project, {
      scope: 'project',
      operation: { type: 'project.rename', name: 'Saved Photo v2' },
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    const overwritten = await module.executeCapability(
      createRequest('studio.project.save', { project: renamed.project, path: target }),
      createTestContext()
    );
    expect(overwritten.ok).toBe(true);
    const updated = JSON.parse(await readFile(target, 'utf8')) as { name: string };
    expect(updated.name).toBe('Saved Photo v2');

    const opened = await module.executeCapability(
      createRequest('studio.project.open', { path: target }),
      createTestContext()
    );
    expect(opened.ok).toBe(true);
    expect((opened.output as { project: { name: string } }).project.name).toBe('Saved Photo v2');

    const blocked = await module.executeCapability(
      createRequest('studio.project.save', {
        project,
        path: path.join(root, 'outside.monarch-studio.json'),
      }),
      createTestContext()
    );
    expect(blocked).toMatchObject({ ok: false, error: 'studio-project-path-blocked' });
  });

  it('rejects malformed object ids instead of normalizing a damaged project', () => {
    const project = createStudioProject({ name: 'Damaged', mode: 'photo' });
    expect(project).not.toBeNull();
    if (!project) return;
    project.photo.objects.push({
      kind: 'text',
      id: '',
      name: 'Broken',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      blendMode: 'normal',
      text: 'Broken',
      color: '#ffffff',
      fontFamily: 'Inter',
      fontSize: 24,
      fontWeight: 400,
      align: 'left',
    });

    const validation = validateStudioProject(project);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('photo objects contain an invalid object');
  });

  it('bounds history and drops only the redo branch after a new edit', () => {
    let project = createStudioProject({ name: 'History', mode: 'photo' });
    expect(project).not.toBeNull();
    if (!project) return;

    for (let index = 1; index <= 55; index += 1) {
      const result = applyStudioEdit(project, {
        scope: 'project',
        operation: { type: 'project.rename', name: `History ${index}` },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      project = result.project;
    }
    expect(project.history.entries).toHaveLength(50);
    expect(project.history.cursor).toBe(49);

    const undone = stepStudioHistory(project, 'undo');
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    const branched = applyStudioEdit(undone.project, {
      scope: 'project',
      operation: { type: 'project.rename', name: 'Branched History' },
    });
    expect(branched.ok).toBe(true);
    if (!branched.ok) return;
    expect(branched.project.history.entries).toHaveLength(50);
    expect(branched.project.name).toBe('Branched History');
    expect(stepStudioHistory(branched.project, 'redo')).toMatchObject({
      ok: false,
      error: 'studio-history-end',
    });
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
