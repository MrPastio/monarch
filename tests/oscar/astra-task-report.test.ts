import { describe, expect, it } from 'vitest';
import { astraTaskReport } from '../../src/oscar-turn/coordinator';

describe('Astra task report', () => {
  it('lists done, rejected, refused and failed steps plus approvals the person granted', () => {
    const view = { id: 't', status: 'succeeded', activities: [
      { round: 1, capabilityId: 'workspace.files.write', reason: '', state: 'observed', ok: true, target: 'a.txt' },
      { round: 2, capabilityId: 'workspace.files.delete', reason: '', state: 'failed', summary: 'approval-rejected', ok: false },
      { round: 3, capabilityId: 'workspace.files.write', reason: '', state: 'failed', summary: 'permission-denied', ok: false },
      { round: 4, capabilityId: 'web.fetch', reason: '', state: 'failed', summary: 'network-timeout', ok: false },
      { round: 5, capabilityId: 'workspace.files.read', reason: '', state: 'proposed' },
    ] } as any;
    const events = [
      { type: 'approval.required', payload: { runtime: 'astra-v3', id: 'approval_1', capability: { title: 'Удалить файлы' } } },
      { type: 'agent.progress', payload: { runtime: 'astra-v3', approvalId: 'approval_1', decision: 'approve' } },
      { type: 'approval.required', payload: { runtime: 'astra-v3', id: 'approval_2', capability: { title: 'Отправить письмо' } } },
      { type: 'agent.progress', payload: { runtime: 'astra-v3', approvalId: 'approval_2', decision: 'reject' } },
    ];
    const report = astraTaskReport(view, events);
    expect(report.map(entry => entry.state)).toEqual(['done', 'rejected', 'denied', 'failed', 'approved']);
    expect(report.at(-1)?.title).toBe('Ты разрешил: Удалить файлы');
  });
});
