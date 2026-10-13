import { afterEach, describe, expect, it, vi } from 'vitest';
import { astraGoalRequest, astraTurnView, astraCardInput, astraSelectionTargets, astraWindowTargets,
  astraActionTargets, astraElapsedLabel, astraHumanIssue, astraDeploymentBadge } from '../../src/ui/public/modules/astra-turn-panel.js';
import { createOscarAstraTurn, sendOscarAstraInput, controlOscarAstraTurn, recoverOscarAstraTurn, cancelOscarTurnSubmission,
  fetchOscarAstraSelections, revokeOscarAstraSelection } from '../../src/ui/public/modules/api.js';

const config = { deployment: 'isolated-validation', conversationId: 'conversation', targets: [
  { key: 'read', selectionId: 'selection', targetId: 'selected', label: 'selected.txt', access: 'observe' },
  { key: 'create', selectionId: 'selection', targetId: 'output', label: 'Новый отчёт.txt', access: 'exclusive-create' },
] };
const identity = { clientRequestId: 'request', inputMessageId: 'message' };
describe('deployment badge', () => {
  it('never labels ordinary isolated work a test run', () => {
    expect(astraDeploymentBadge(config)).toBe('Только выбранное');
    expect(astraDeploymentBadge({ ...config, localAnalysis: true })).toBe('Локальный анализ');
    for (const value of [config, { ...config, localAnalysis: true }, undefined, {}]) {
      expect(astraDeploymentBadge(value)).not.toMatch(/тест/iu);
    }
  });
});
describe('local analysis renderer contract', () => {
  it('binds an explicit local analysis without inventing a cloud model choice', () => {
    const value = { target: 'read', text: 'Объясни файл', modelMode: 'local' };
    expect(astraGoalRequest({ ...config, localAnalysis: true }, value, identity).astra.goal)
      .toEqual({ kind: 'analyze', targets: ['selected'], modelMode: 'local' });
    expect(() => astraGoalRequest(config, value, identity)).toThrow('Локальный анализ');
    expect(() => astraGoalRequest({ ...config, localAnalysis: true }, { ...value, modelChoice: 'gpt-oss-120b' }, identity)).toThrow();
    expect(() => astraGoalRequest({ ...config, localAnalysis: true }, { ...value, target: 'create' }, identity)).toThrow();
  });
});
describe('explicit window observation renderer contract', () => {
  const window = { selectionId: 'window_selection', title: '<script>untrusted</script>', processName: 'QA',
    expiresAt: Date.now() + 60000, authority: 'observe', authorizesInput: false };
  const target = astraWindowTargets([window])[0];
  const computer = { ...config, computerObservation: true, targets: [target] };
  const input = { target: target.key, text: 'Наблюдай окно.', contentKind: 'literal', content: '' };
  it('emits only opaque selection and closed observation goal, never native handles or file authority', () => {
    expect(astraGoalRequest(computer, input, identity).astra).toEqual({ selectionId: window.selectionId, goal: { kind: 'computer-observe' } });
    expect(target.label).toContain('<script>'); expect(target).not.toHaveProperty('windowRef');
  });
  it('rejects expired or unadvertised choice, oversized source and reference promotion', () => {
    expect(() => astraGoalRequest({ ...computer, computerObservation: false }, input, identity)).toThrow();
    expect(() => astraGoalRequest({ ...computer, targets: [{ ...target, expiresAt: 1 }] }, input, identity)).toThrow();
    expect(() => astraGoalRequest(computer, { ...input, text: 'x'.repeat(4097) }, identity)).toThrow();
    expect(() => astraGoalRequest(computer, { ...input, references: ['read'] }, identity)).toThrow();
    expect(() => astraWindowTargets([{ ...window, authorizesInput: true }])).toThrow();
  });
});
describe('pre-issued Computer action renderer contract', () => {
  const plan = { selectionId: 'action_plan', title: '<script>owned title</script>', summary: 'Заменить значение поля',
    expiresAt: Date.now() + 60000, authority: 'approval-required', grantScope: 'none' };
  const target = astraActionTargets([plan])[0];
  const actionConfig = { ...config, computerActions: true, targets: [target] };
  it('submits only the opaque plan and closed goal', () => {
    const request = astraGoalRequest(actionConfig, { target: target.key, text: 'Выполни выбранное действие.', references: [] }, identity);
    expect(request.astra).toEqual({ selectionId: plan.selectionId, goal: { kind: 'computer-action' } });
    expect(JSON.stringify(request)).not.toContain(plan.title); expect(JSON.stringify(request)).not.toContain(plan.summary);
  });
  it('cannot self-arm, add native fields or reuse an expired plan', () => {
    expect(() => astraGoalRequest({ ...actionConfig, computerActions: false }, { target: target.key, text: 'Действуй.' }, identity)).toThrow();
    expect(() => astraGoalRequest({ ...actionConfig, targets: [{ ...target, expiresAt: 1 }] }, { target: target.key, text: 'Действуй.' }, identity)).toThrow();
    expect(() => astraActionTargets([{ ...plan, grantScope: 'once' }])).toThrow();
  });
});
const value = { target: 'create', text: '  Точная задача\n🟠  ', contentKind: 'literal', content: '  \n🟠' };
const binding = 'sha256:' + 'a'.repeat(64);
const approval = { type: 'approval.required', sequence: 3, payload: { runtime: 'astra-v3', id: 'approval', digest: binding } };
const question = { type: 'user.input.required', sequence: 3, payload: { runtime: 'astra-v3', id: 'question', digest: binding, text: '<script>untrusted</script>' } };
const turn = { id: 'turn_1', conversationId: 'conversation', inputMessageId: 'message', revision: 1,
  request: { astra: {} }, status: 'waiting-for-approval', activeApprovalId: 'approval' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('Astra explicit renderer source and durable card projection', () => {
  it('shows elapsed work time and human recovery guidance without runtime identifiers', () => {
    expect(astraElapsedLabel({ createdAt: '2026-09-04T10:00:00.000Z', updatedAt: '2026-09-04T10:01:05.000Z' }))
      .toBe('Время работы: 1 мин 5 сек');
    expect(astraElapsedLabel({ createdAt: '2026-09-04T10:00:00.000Z',
      outcome: { completedAt: '2026-09-04T10:00:00.400Z' } })).toBe('Время работы: меньше секунды');
    expect(astraElapsedLabel({ createdAt: 'invalid', updatedAt: 'also-invalid' })).toBe('');
    expect(astraHumanIssue('recovery-required')).toContain('не будет повторять действие автоматически');
    expect(astraHumanIssue({ code: 'source-projection-failed' })).toContain('Не удалось обновить состояние');
    expect(astraHumanIssue('__proto__')).toBe('Не удалось достоверно определить состояние задачи. Проверь её ещё раз.');
  });
  it('does not present a durably delivered partial Astra result as successful work', () => {
    const partial = astraTurnView({ turn: { ...turn, status: 'succeeded', outcome: { kind: 'partial' } }, events: [
      { type: 'agent.progress', sequence: 1, payload: { runtime: 'astra-v3', astraProjection: 'partial_snapshot', status: 'partial' } },
    ] });
    expect(partial).toMatchObject({ status: 'partial', terminal: true });
  });
  it('retries recovery with the same source and request ID, without resume or approval data', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    await recoverOscarAstraTurn(turn, 'stable_recovery'); await recoverOscarAstraTurn(turn, 'stable_recovery');
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe('/api/oscar/turns/turn_1/astra-recover'); expect(calls[0]![1].body).toBe(calls[1]![1].body);
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ version: 1, conversationId: 'conversation', inputMessageId: 'message', requestId: 'stable_recovery' });
  });
  it('binds explicit draft references to observe handles without labels, paths or auto approval', () => {
    const request = astraGoalRequest({ ...config, referenceInputs: true },
      { ...value, contentKind: 'draft', references: ['read'], modelMode: 'max' }, identity);
    expect(request.astra.goal).toEqual({ kind: 'create', target: 'output', content: { kind: 'draft', modelMode: 'max',
      references: [{ selectionId: 'selection', target: 'selected' }] } });
    expect(JSON.stringify(request)).not.toMatch(/confirmed|Новый отчёт|selected\.txt/);
  });
  it('accepts only the bounded MAX choice on a model draft', () => {
    expect(astraGoalRequest(config, { ...value, contentKind: 'draft', content: '', modelMode: 'max' }, identity)
      .astra.goal.content).toEqual({ kind: 'draft', modelMode: 'max' });
    expect(astraGoalRequest(config, { ...value, contentKind: 'draft', content: '', modelMode: 'max',
      modelChoice: 'gpt-oss-120b' }, identity).astra.goal.content)
      .toEqual({ kind: 'draft', modelMode: 'max', modelChoice: 'gpt-oss-120b' });
    expect(astraGoalRequest(config, { ...value, contentKind: 'draft', content: '', modelMode: 'max',
      modelChoice: 'qwen-3.8-27b', previewAcknowledged: true }, identity).astra.goal.content)
      .toEqual({ kind: 'draft', modelMode: 'max', modelChoice: 'qwen-3.8-27b', previewAcknowledged: true });
    expect(() => astraGoalRequest(config, { ...value, contentKind: 'literal', modelMode: 'max' }, identity)).toThrow();
    expect(() => astraGoalRequest(config, { ...value, contentKind: 'draft', modelMode: 'provider/model' }, identity)).toThrow();
    expect(() => astraGoalRequest(config, { ...value, contentKind: 'draft', modelMode: 'max',
      modelChoice: 'qwen-3.8-27b' }, identity)).toThrow('тестовый статус Qwen');
    expect(() => astraGoalRequest(config, { ...value, contentKind: 'draft', modelMode: 'max',
      modelChoice: 'arbitrary-model' }, identity)).toThrow('модель MAX недоступна');
    expect(() => astraGoalRequest(config, { ...value, contentKind: 'draft',
      modelChoice: 'gpt-oss-120b' }, identity)).toThrow('Сначала выбери MAX');
  });
  it.each([
    { contentKind: 'literal', references: ['read'] }, { contentKind: 'reply', references: ['read'] },
    { target: 'read', contentKind: 'draft', references: ['read'] }, { contentKind: 'draft', references: ['create'] },
    { contentKind: 'draft', references: ['unknown'] }, { contentKind: 'draft', references: ['read', 'read'] },
    { contentKind: 'draft', references: Array.from({ length: 9 }, (_, i) => 'read' + i) },
  ])('rejects an invalid or unavailable material selection (%#)', override => {
    expect(() => astraGoalRequest({ ...config, referenceInputs: true }, { ...value, ...override }, identity)).toThrow();
  });
  it('keeps reference mode unavailable unless advertised by the host', () => {
    expect(() => astraGoalRequest(config, { ...value, contentKind: 'draft', references: ['read'] }, identity)).toThrow();
  });
  it('renders only validated server selection descriptors without turning labels into paths', () => {
    const targets = astraSelectionTargets({ selections: [{ selectionId: 'selection', targets: [
      { targetId: 'file', label: '<script>label</script>', access: 'observe', maxBytes: 4096 },
    ] }] });
    expect(targets).toEqual([{ key: 'selection_file', selectionId: 'selection', targetId: 'file', access: 'observe', label: 'Прочитать <script>label</script>' }]);
    expect(astraSelectionTargets({ selections: [] })).toEqual([]);
    expect(() => astraSelectionTargets({ selections: [{ selectionId: 'bad/path', targets: [] }] })).toThrow();
    expect(() => astraSelectionTargets({ selections: [{ selectionId: 'selection', targets: [] }] })).toThrow();
  });
  it('keeps a multi-file choice in one selection and submits every opaque handle for analysis', () => {
    const targets = Array.from({ length: 8 }, (_, index) => ({
      targetId: `file_${index}`, label: `file-${index}.txt`, access: 'observe', maxBytes: 4096,
    }));
    const [group] = astraSelectionTargets({ selections: [{ selectionId: 'selection', targets }] });
    const targetIds = targets.map(target => target.targetId);
    expect(group).toMatchObject({ selectionId: 'selection', targetIds, access: 'observe' });
    expect(group.label).toContain('8 файлов');
    const grouped = { ...config, targets: [group] };
    expect(astraGoalRequest(grouped, { ...value, target: group.key, modelMode: 'max', modelChoice: 'gpt-oss-120b' }, identity)
      .astra.goal).toEqual({ kind: 'analyze', targets: targetIds, modelMode: 'max', modelChoice: 'gpt-oss-120b' });
    expect(astraGoalRequest(grouped, { ...value, target: group.key }, identity).astra.goal)
      .toEqual({ kind: 'observe', targets: targetIds });
    expect(() => astraGoalRequest({ ...config, referenceInputs: true, targets: [config.targets[1], group] },
      { ...value, contentKind: 'draft', references: [group.key] }, identity)).toThrow('Материал недоступен');
    expect(() => astraSelectionTargets({ selections: [{ selectionId: 'selection', targets: [...targets,
      { targetId: 'file_8', label: 'file-8.txt', access: 'observe', maxBytes: 4096 }] }] })).toThrow('не больше 8');
  });
  it('preserves exact source/content bytes and does not pass arbitrary identity authority', () => {
    const request = astraGoalRequest(config, value, { ...identity, actor: 'fake', confirmed: true });
    expect(request.text).toBe(value.text); expect(request.astra.goal.content.text).toBe(value.content);
    expect(request).not.toHaveProperty('actor'); expect(request).not.toHaveProperty('confirmed'); expect(request.privacyMode).toBe('persistent');
  });
  it.each(['literal', 'reply', 'draft'])('builds explicit %s create without raw paths or permissions', contentKind => {
    const request = astraGoalRequest(config, { ...value, contentKind, content: '' }, identity);
    expect(request.astra.goal).toEqual({ kind: 'create', target: 'output', content: contentKind === 'literal' ? { kind: 'literal', text: '' } : { kind: contentKind } });
    expect(JSON.stringify(request)).not.toContain('Новый отчёт.txt');
  });
  it('builds model-free selected observation', () => {
    expect(astraGoalRequest(config, { ...value, target: 'read' }, identity).astra.goal).toEqual({ kind: 'observe', targets: ['selected'] });
  });
  it('turns an explicit MAX choice on a selected file into grounded analysis, never a create request', () => {
    expect(astraGoalRequest(config, { ...value, target: 'read', modelMode: 'max', modelChoice: 'gpt-oss-120b' }, identity).astra.goal)
      .toEqual({ kind: 'analyze', targets: ['selected'], modelMode: 'max', modelChoice: 'gpt-oss-120b' });
    expect(astraGoalRequest(config, { ...value, target: 'read', modelMode: 'max', modelChoice: 'qwen-3.8-27b',
      previewAcknowledged: true }, identity).astra.goal).toEqual({ kind: 'analyze', targets: ['selected'], modelMode: 'max',
      modelChoice: 'qwen-3.8-27b', previewAcknowledged: true });
    expect(() => astraGoalRequest(config, { ...value, target: 'read', modelMode: 'max', modelChoice: 'qwen-3.8-27b' }, identity)).toThrow();
  });
  it('rejects missing isolate, unknown selection and oversized UTF-8 source', () => {
    expect(() => astraGoalRequest({ ...config, deployment: 'product' }, value, identity)).toThrow();
    expect(() => astraGoalRequest(config, { ...value, target: 'C:/Safe' }, identity)).toThrow();
    expect(() => astraGoalRequest(config, { ...value, text: '🟠'.repeat(2049) }, identity)).toThrow();
  });
  it('requires exact approval and never treats arbitrary reply as permission', () => {
    expect(astraCardInput(approval, 'approve', { messageId: 'reply' })).toEqual({ kind: 'decide', decision: {
      approvalId: 'approval', approvalDigest: binding, messageId: 'reply', decision: 'approve' } });
    expect(() => astraCardInput(approval, 'да', { messageId: 'reply' })).toThrow();
    expect(() => astraCardInput({ ...approval, payload: { ...approval.payload, digest: '' } }, 'approve', { messageId: 'reply' })).toThrow();
  });
  it.each(['', '  \n', '🟠 <script>'])('retains exact reply %j', text => {
    expect(astraCardInput(question, text, { requestId: 'reply_request', messageId: 'reply_message' })).toEqual({ kind: 'reply', reply: {
      requestId: 'reply_request', questionId: 'question', questionDigest: binding, messageId: 'reply_message', text } });
  });
  it('hides accepted card before outbox projection and never revives terminal/stale approvals', () => {
    expect(astraTurnView({ turn, events: [approval] }).card).toEqual(approval);
    const accepted = { type: 'agent.progress', sequence: 4, payload: { runtime: 'astra-v3', astraInputId: 'reply' } };
    expect(astraTurnView({ turn, events: [approval, accepted] }).card).toBeNull();
    expect(astraTurnView({ turn: { ...turn, status: 'succeeded' }, events: [approval] }).card).toBeNull();
    expect(astraTurnView({ turn: { ...turn, activeApprovalId: 'changed' }, events: [approval] }).card).toBeNull();
  });
  it('uses runtime unknown/paused state without inferring completion from text', () => {
    const cp = { turn, events: [{ type: 'agent.progress', sequence: 1, payload: { runtime: 'astra-v3', astraProjection: 'snapshot', status: 'indeterminate' } }] };
    expect(astraTurnView(cp)).toMatchObject({ status: 'indeterminate', terminal: false });
    expect(() => astraTurnView({ turn: { ...turn, request: {} }, events: [] })).toThrow();
  });
  it('shows a projection failure without a snapshot until a new actual projection recovers', () => {
    const healthy = { type: 'agent.progress', sequence: 1, payload: { runtime: 'astra-v3', astraProjection: 'same_snapshot', status: 'awaiting-approval' } };
    const failure = { type: 'agent.progress', sequence: 2, payload: { runtime: 'astra-v3', runtimeIssue: 'source-projection-failed' } };
    const input = { type: 'agent.progress', sequence: 3, payload: { runtime: 'astra-v3', astraInputId: 'unrelated' } };
    expect(astraTurnView({ turn, events: [healthy, failure, input] })).toMatchObject({ issue: 'source-projection-failed', status: 'awaiting-approval', terminal: false });
    expect(astraTurnView({ turn, events: [healthy, failure, input, { ...healthy, sequence: 4 }] }).issue).toBeNull();
  });
  it('sends exact IDs/source using the same authenticated API, no V2 message/action endpoint', async () => {
    vi.stubGlobal('window', { monarchDesktop: { getMutationAttestation: vi.fn(async () => 'owned-synthetic-attestation') } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ turn }), { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    const request = astraGoalRequest(config, value, identity), input = astraCardInput(question, '', { requestId: 'reply_request', messageId: 'reply_message' });
    await createOscarAstraTurn(request); await createOscarAstraTurn(request); await sendOscarAstraInput(turn, input); await controlOscarAstraTurn(turn, 'pause');
    await cancelOscarTurnSubmission('request', { astra: true });
    await fetchOscarAstraSelections('conversation'); await revokeOscarAstraSelection('selection', 'conversation');
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![1].body).toBe(calls[1]![1].body); expect(JSON.parse(String(calls[0]![1].body))).toEqual(request);
    expect(calls[2]![0]).toBe('/api/oscar/turns/turn_1/astra-input');
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ version: 1, conversationId: 'conversation', inputMessageId: 'message', input });
    expect(calls[3]![0]).toBe('/api/oscar/turns/turn_1/pause');
    expect(JSON.parse(String(calls[4]![1].body))).toEqual({ version: 1, clientRequestId: 'request', privacyMode: 'persistent', astra: true });
    expect(calls[5]![0]).toBe('/api/oscar/astra/selections?conversationId=conversation');
    expect(calls[6]![0]).toBe('/api/oscar/astra/selections/selection/revoke');
    expect(JSON.parse(String(calls[6]![1].body))).toEqual({ version: 1, conversationId: 'conversation' });
    expect(calls[0]![1].headers).toHaveProperty('X-Monarch-Desktop-Attestation', 'owned-synthetic-attestation');
    expect(() => controlOscarAstraTurn(turn, 'approve')).toThrow();
  });
});
