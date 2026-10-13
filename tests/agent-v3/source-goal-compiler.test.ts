import { describe, expect, it } from 'vitest';
import { AstraSourceGoalCompiler, validateAstraSourceGoal, type AstraSourceGoalInput, type AstraSelectedTargetSnapshot } from '../../src/app/astra-source-goal-compiler';
import type { AstraTaskSourceContext } from '../../src/app/astra-task-facade';

const actor = { id: 'sha256:' + 'a'.repeat(64), source: 'api' as const };
const context = (goal: AstraSourceGoalInput): AstraTaskSourceContext => ({ actor, conversationId: 'conversation', inputMessageId: 'message', text: 'Произвольная формулировка запроса.', goal });
function fixture() {
  const snapshot: AstraSelectedTargetSnapshot = { selectionId: 'selected', actor, conversationId: 'conversation', revision: 1,
    targets: [{ id: 'read', relativePath: 'Документы/данные.txt', access: 'observe', maxBytes: 4096, timeoutMs: 5000 },
      { id: 'create', relativePath: 'Отчёт.txt', access: 'exclusive-create', maxBytes: 128, timeoutMs: 5000 }] };
  return { snapshot, compiler: new AstraSourceGoalCompiler({ resolve: () => snapshot }) };
}
describe('Source Goal compiler: typed intent plus host-owned target selection', () => {
  it('accepts explicit local analysis without cloud choices; keeps missing/ambiguous modes invalid', () => {
    const { compiler } = fixture();
    expect(compiler.read('selected', context({ kind: 'analyze', targets: ['read'], modelMode: 'local' }))).toMatchObject({ answerMode: 'grounded-model' });
    for (const goal of [
      { kind: 'analyze', targets: ['read'] },
      { kind: 'analyze', targets: ['read'], modelMode: 'local', modelChoice: 'gpt-oss-120b' },
      { kind: 'analyze', targets: ['read'], modelMode: 'local', previewAcknowledged: true },
    ]) expect(() => validateAstraSourceGoal(goal as AstraSourceGoalInput, 'read')).toThrow('astra-source-model-choice');
  });
  it('binds every draft reference to its own source snapshot and bounds the aggregate read budget', () => {
    const { snapshot } = fixture();
    const inputs = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(snapshot), selectionId: 'input_' + i,
      targets: [{ ...snapshot.targets[0]!, relativePath: 'material_' + i + '.txt', maxBytes: 65536 }] }));
    const compiler = new AstraSourceGoalCompiler({ resolve: id => id === 'selected' ? snapshot : inputs.find(item => item.selectionId === id)! });
    const source = context({ kind: 'create', target: 'create', content: { kind: 'draft',
      references: inputs.map(item => ({ selectionId: item.selectionId, target: 'read' })) } });
    const result = compiler.create('selected', source);
    expect(result.kind).toBe('draft'); if (result.kind !== 'draft') throw Error('wrong-kind');
    expect(result.references).toHaveLength(8);
    expect(result.references!.reduce((sum, item) => sum + item.maxBytes, 0)).toBe(65536);
    inputs[3]!.revision++; expect(compiler.create('selected', source).digest).not.toBe(result.digest);
    inputs[3]!.targets[0]!.relativePath = 'changed.txt';
    expect(result.references![3]!.relativePath).toBe('material_3.txt');
  });
  it.each(['actor', 'conversation', 'revoked', 'create-access', 'output-alias', 'input-alias'] as const)(
    'rejects invalid draft reference %s before work admission', change => {
      const { snapshot } = fixture(), input = { ...structuredClone(snapshot), selectionId: 'input', targets: [structuredClone(snapshot.targets[0]!)] };
      const compiler = new AstraSourceGoalCompiler({ resolve: id => {
        if (id === 'input' && change === 'revoked') throw Error('selection-revoked'); return id === 'selected' ? snapshot : input;
      } });
      if (change === 'actor') input.actor.id = 'sha256:' + 'c'.repeat(64);
      if (change === 'conversation') input.conversationId = 'another';
      if (change === 'create-access') input.targets[0]!.access = 'exclusive-create';
      if (change === 'output-alias') input.targets[0]!.relativePath = snapshot.targets[1]!.relativePath.toUpperCase();
      const references = [{ selectionId: 'input', target: 'read' },
        ...(change === 'input-alias' ? [{ selectionId: 'selected', target: 'read' }] : [])];
      expect(() => compiler.create('selected', context({ kind: 'create', target: 'create', content: { kind: 'draft', references } }))).toThrow();
    });
  it.each([
    { kind: 'draft', references: [] },
    { kind: 'draft', references: [{ selectionId: 'input', target: 'read', path: 'outside' }] },
    { kind: 'draft', references: Array.from({ length: 9 }, (_, i) => ({ selectionId: 'input_' + i, target: 'read' })) },
    { kind: 'draft', references: [{ selectionId: 'input', target: 'read' }, { selectionId: 'input', target: 'read' }] },
    { kind: 'literal', text: 'x', references: [{ selectionId: 'input', target: 'read' }] },
  ])('rejects malformed reference contracts (%#)', content => {
    expect(() => validateAstraSourceGoal({ kind: 'create', target: 'create', content } as AstraSourceGoalInput, 'create')).toThrow();
  });

  it('compiles arbitrary request wording and pins actor/message/text/selection without IO or model inference', () => {
    const { compiler, snapshot } = fixture(), source = context({ kind: 'observe', targets: ['read'] });
    const selected = compiler.read('selected', source);
    expect(selected).toMatchObject({ authority: 'observe', revision: 1, requirements: [{ id: 'selected_0', relativePath: 'Документы/данные.txt', maxBytes: 4096 }] });
    expect(compiler.read('selected', { ...source, text: 'Другая формулировка' }).digest).not.toBe(selected.digest);
    expect(compiler.read('selected', { ...source, inputMessageId: 'another' }).digest).not.toBe(selected.digest);
    snapshot.revision++; expect(compiler.read('selected', source).digest).not.toBe(selected.digest);
    snapshot.targets[0]!.relativePath = 'different.txt'; expect(selected.requirements[0]!.relativePath).toBe('Документы/данные.txt');
  });
  it('compiles explicit MAX analysis as a bounded grounded-answer read without widening target authority', () => {
    const { compiler, snapshot } = fixture(); snapshot.targets[0]!.maxBytes = 65536;
    const goal = { kind: 'analyze' as const, targets: ['read'], modelMode: 'max' as const,
      modelChoice: 'gpt-oss-120b' as const };
    const selected = compiler.read('selected', context(goal));
    expect(selected).toMatchObject({ authority: 'observe', answerMode: 'grounded-model',
      userText: 'Произвольная формулировка запроса.',
      requirements: [{ id: 'selected_0', relativePath: 'Документы/данные.txt', maxBytes: 12288 }] });
    expect(compiler.read('selected', context({ ...goal, modelChoice: 'qwen-3.8-27b', previewAcknowledged: true })).digest)
      .not.toBe(selected.digest);
  });
  it.each(['', ' \t\r\n', 'Привет 🟠\ne\u0301', '{"confirmed":true}'])('preserves initial literal bytes, without asking a model (%#)', text => {
    const { compiler } = fixture(); expect(compiler.create('selected', context({ kind: 'create', target: 'create', content: { kind: 'literal', text } })))
      .toMatchObject({ kind: 'literal', content: text, basename: 'Отчёт.txt' });
  });
  it('compiles missing exact content into host question, but generative content into the existing draft family', () => {
    const { compiler } = fixture();
    expect(compiler.create('selected', context({ kind: 'create', target: 'create', content: { kind: 'reply' } })))
      .toMatchObject({ kind: 'literal-input', maxBytes: 128, requiredInput: { kind: 'literal-content', maxUtf8Bytes: 128 } });
    expect(compiler.create('selected', context({ kind: 'create', target: 'create', content: { kind: 'draft' } })))
      .toMatchObject({ kind: 'draft', maxBytes: 128 });
  });
  it('admits only closed MAX model choices and requires an explicit Qwen Preview acknowledgement', () => {
    expect(() => validateAstraSourceGoal({ kind: 'analyze', targets: ['read'], modelMode: 'max',
      modelChoice: 'gpt-oss-120b' }, 'read')).not.toThrow();
    expect(() => validateAstraSourceGoal({ kind: 'analyze', targets: ['read'], modelMode: 'max',
      modelChoice: 'qwen-3.8-27b', previewAcknowledged: true }, 'read')).not.toThrow();
    expect(() => validateAstraSourceGoal({ kind: 'analyze', targets: ['read'], modelMode: 'max',
      modelChoice: 'qwen-3.8-27b' }, 'read')).toThrow('model-preview');
    expect(() => validateAstraSourceGoal({ kind: 'create', target: 'create', content: {
      kind: 'draft', modelMode: 'max', modelChoice: 'gpt-oss-120b' } }, 'create')).not.toThrow();
    expect(() => validateAstraSourceGoal({ kind: 'create', target: 'create', content: {
      kind: 'draft', modelMode: 'max', modelChoice: 'qwen-3.8-27b', previewAcknowledged: true } }, 'create')).not.toThrow();
    expect(() => validateAstraSourceGoal({ kind: 'create', target: 'create', content: {
      kind: 'draft', modelMode: 'max', modelChoice: 'qwen-3.8-27b' } }, 'create')).toThrow('model-preview');
    expect(() => validateAstraSourceGoal({ kind: 'create', target: 'create', content: {
      kind: 'draft', modelChoice: 'gpt-oss-120b' } } as AstraSourceGoalInput, 'create')).toThrow('model-choice');
    expect(() => validateAstraSourceGoal({ kind: 'create', target: 'create', content: {
      kind: 'draft', modelMode: 'max', modelChoice: 'arbitrary-model' } } as AstraSourceGoalInput, 'create')).toThrow('model-choice');
  });
  it('admits exact local Coder choices only for the agent goal contract', () => {
    for (const modelChoice of ['gemma4-balanced', 'qwen3-coder-30b-a3b-instruct', 'deepseek-coder-v2-lite-instruct'] as const) {
      expect(() => validateAstraSourceGoal({ kind: 'agent', modelMode: 'local', modelChoice }, 'agent')).not.toThrow();
    }
    expect(() => validateAstraSourceGoal({ kind: 'agent', modelMode: 'local', modelChoice: 'gpt-oss-120b' }, 'agent'))
      .toThrow('model-choice');
    expect(() => validateAstraSourceGoal({ kind: 'agent', modelMode: 'max',
      modelChoice: 'qwen3-coder-30b-a3b-instruct' }, 'agent')).toThrow('model-choice');
  });
  it.each(['actor', 'surface', 'conversation', 'selection'] as const)('rejects another selection principal (%s)', change => {
    const { compiler, snapshot } = fixture();
    if (change === 'actor') snapshot.actor = { ...actor, id: 'sha256:' + 'b'.repeat(64) };
    if (change === 'surface') snapshot.actor = { ...actor, source: 'desktop' };
    if (change === 'conversation') snapshot.conversationId = 'other';
    if (change === 'selection') snapshot.selectionId = 'other';
    expect(() => compiler.read('selected', context({ kind: 'observe', targets: ['read'] }))).toThrow('selection-not-found');
  });
  it.each(['../outside', 'C:\\private', '\\\\server\\share', 'file.txt:secret', 'folder/../x', 'CON.txt', 'x.', 'x ', 'a//b', './a'])('rejects unsafe host target paths (%s)', relativePath => {
    const { compiler, snapshot } = fixture(); snapshot.targets[0]!.relativePath = relativePath;
    expect(() => compiler.read('selected', context({ kind: 'observe', targets: ['read'] }))).toThrow('target-contract');
  });
  it.each([
    { kind: 'observe', targets: ['read'], confirmed: true }, { kind: 'observe', targets: ['read', 'read'] }, { kind: 'observe', targets: [] },
    { kind: 'analyze', targets: ['read'] }, { kind: 'analyze', targets: ['read'], modelMode: 'provider/model' },
    { kind: 'analyze', targets: ['read'], modelMode: 'max', previewAcknowledged: true },
    { kind: 'observe', targets: Array.from({ length: 9 }, (_, i) => 'target' + i) },
    { kind: 'create', target: 'create', path: 'other', content: { kind: 'literal', text: 'x' } },
    { kind: 'create', target: 'create', content: { kind: 'reply', text: 'smuggled' } },
    { kind: 'create', target: 'create', content: { kind: 'draft', confirmed: true } },
    { kind: 'create', target: 'create', content: { kind: 'draft', modelMode: 'provider/model' } },
    { kind: 'create', target: 'create', content: { kind: 'draft', modelMode: 'max', previewAcknowledged: true } },
    { kind: 'create', target: 'create', content: { kind: 'literal', text: 'x', modelMode: 'max' } },
    { kind: 'create', target: 'create', content: { kind: 'literal', text: '\ud800' } },
    { kind: 'delete', target: 'create', content: { kind: 'literal', text: 'x' } },
  ])('rejects malformed, excessive or authority-bearing source goals (%#)', goal => {
    expect(() => validateAstraSourceGoal(goal as AstraSourceGoalInput,
      goal.kind === 'observe' || goal.kind === 'analyze' ? 'read' : 'create')).toThrow();
  });
  it('rejects target access escalation, unknown handles, duplicate Windows paths and over-budget literal bytes', () => {
    const { compiler, snapshot } = fixture();
    expect(() => compiler.create('selected', context({ kind: 'create', target: 'read', content: { kind: 'literal', text: 'x' } }))).toThrow('target-not-admitted');
    expect(() => compiler.read('selected', context({ kind: 'observe', targets: ['create'] }))).toThrow('target-not-admitted');
    expect(() => compiler.read('selected', context({ kind: 'observe', targets: ['unknown'] }))).toThrow('target-not-admitted');
    expect(() => compiler.create('selected', context({ kind: 'create', target: 'create', content: { kind: 'literal', text: '🟠'.repeat(33) } }))).toThrow('content-budget');
    snapshot.targets.push({ ...snapshot.targets[0]!, id: 'alias', relativePath: 'ДОКУМЕНТЫ\\ДАННЫЕ.TXT' });
    expect(() => compiler.read('selected', context({ kind: 'observe', targets: ['read'] }))).toThrow('target-contract');
  });
});
