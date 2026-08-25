import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentSkillRegistry } from '../../src/modules/astra/agent-skills';
import {
  AgentSkillAuthoringError,
  AgentSkillAuthoringService,
} from '../../src/modules/astra/skill-authoring';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentSkillAuthoringService', () => {
  it('builds a deterministic review-required auto draft without writing files', async () => {
    const { root, service } = await createService();
    const purpose = 'Проверяй релиз Monarch перед публикацией и подтверждай результат тестами.';
    const first = service.createAutoDraft(purpose, 'project');
    const second = service.createAutoDraft(purpose, 'project');
    const validation = await service.validate(first, {
      availableCapabilities: ['workspace.files.read'],
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      source: 'auto',
      scope: 'project',
      allowImplicitInvocation: false,
    });
    expect(first.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(first.instructions).toContain('Не выдавай намерение или текст модели за выполненное действие.');
    expect(validation.valid).toBe(true);
    expect(validation.draftHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(stat(path.join(root, '.monarch', 'skills', first.name))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes one atomic package and verifies it through the registry', async () => {
    const { root, service } = await createService();
    const draft = service.createAutoDraft(
      'Проверяй уникальный тестовый релиз Orion и возвращай подтверждённый итог.',
      'project',
    );
    draft.requiredCapabilities = ['workspace.files.read'];
    const validation = await service.validate(draft, {
      availableCapabilities: ['workspace.files.read'],
    });
    const result = await service.publish(validation.draft, validation.draftHash, {
      availableCapabilities: ['workspace.files.read'],
    });

    const directory = path.join(root, '.monarch', 'skills', draft.name);
    const skillMarkdown = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
    const openAiYaml = await readFile(path.join(directory, 'agents', 'openai.yaml'), 'utf8');
    expect(result.receipt).toMatchObject({
      created: true,
      verified: true,
      source: 'auto',
      name: draft.name,
    });
    expect(result.receipt.packageHash).toBe(result.receipt.readBackHash);
    expect(result.skill).toMatchObject({
      name: draft.name,
      scope: 'project',
      creationSource: 'auto',
      allowImplicitInvocation: false,
      requiredCapabilities: ['workspace.files.read'],
    });
    expect(skillMarkdown).toContain(`name: "${draft.name}"`);
    expect(skillMarkdown).not.toContain('requiredCapabilities:');
    expect(openAiYaml).toContain('allow_implicit_invocation: false');
    expect(openAiYaml).toContain('source: auto');
  });

  it('rejects changed, duplicate, and secret-bearing drafts without overwrite', async () => {
    const { root, service } = await createService();
    const draft = service.createAutoDraft(
      'Собирай уникальную локальную сводку Nebula и проверяй результат.',
      'project',
    );
    const validation = await service.validate(draft);
    const changed = { ...validation.draft, displayName: 'Changed after validation' };

    await expect(service.publish(changed, validation.draftHash)).rejects.toMatchObject({
      code: 'skill-draft-changed',
    } satisfies Partial<AgentSkillAuthoringError>);
    await service.publish(validation.draft, validation.draftHash);
    await expect(service.publish(validation.draft, validation.draftHash)).rejects.toMatchObject({
      code: 'skill-already-exists',
    } satisfies Partial<AgentSkillAuthoringError>);

    const secretDraft = {
      ...service.createAutoDraft('Создавай ещё одну уникальную сводку Comet для теста.', 'project'),
      instructions: `Проверь результат и используй token=${['sk', 'live', '12345678901234567890'].join('_')} только для этого шага.`,
    };
    const secretValidation = await service.validate(secretDraft);
    expect(secretValidation.valid).toBe(false);
    expect(secretValidation.diagnostics).toContainEqual(expect.objectContaining({ code: 'skill-secret-material' }));
    expect(await stat(path.join(root, '.monarch', 'skills', validation.draft.name))).toBeTruthy();
  });
});

async function createService(): Promise<{
  root: string;
  service: AgentSkillAuthoringService;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'monarch-skill-authoring-'));
  temporaryRoots.push(root);
  const registry = new AgentSkillRegistry(root, 'win32');
  return {
    root,
    service: new AgentSkillAuthoringService(root, registry, {
      userSkillsRoot: path.join(root, '.test-user-skills'),
    }),
  };
}
