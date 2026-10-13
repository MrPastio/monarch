import { describe, expect, it } from 'vitest';
import { AstraJournalError } from '../../src/agent-v3/journal';
import { AstraTaskFaultContainment, astraTaskFaultCode, astraTaskFaultReason, synchronizeEach,
  type AstraTaskFaultNotice } from '../../src/agent-v3/task-fault';

describe('Astra task fault isolation', () => {
  it('contains only faults that belong to one task', () => {
    expect(astraTaskFaultCode(new Error('astra-agent-decision:evidence-shape'))).toBe('astra-agent-decision:evidence-shape');
    expect(astraTaskFaultCode(new Error('astra-agent-task:capability-args-binding'))).toBe('astra-agent-task:capability-args-binding');
    expect(astraTaskFaultCode(new Error('astra-computer-task:work-substitution'))).toBe('astra-computer-task:work-substitution');
  });

  it('keeps journal, scheduler, ownership and unknown faults host-level', () => {
    expect(astraTaskFaultCode(new AstraJournalError('commit-fenced'))).toBeUndefined();
    expect(astraTaskFaultCode(new Error('astra-journal:closed'))).toBeUndefined();
    expect(astraTaskFaultCode(new Error('astra-scheduler:owner-fenced'))).toBeUndefined();
    expect(astraTaskFaultCode(new Error('astra-agent-task:owner-required'))).toBeUndefined();
    expect(astraTaskFaultCode(new Error('astra-agent-task:index-budget'))).toBeUndefined();
    expect(astraTaskFaultCode(new Error('astra-read-task:scheduler-binding'))).toBeUndefined();
    expect(astraTaskFaultCode(new Error('astra-agent-task:evidence-shape and more text'))).toBeUndefined();
    expect(astraTaskFaultCode(new TypeError('Cannot read properties of undefined'))).toBeUndefined();
    expect(astraTaskFaultCode('astra-agent-task:action-missing')).toBeUndefined();
  });

  it('bounds the durable reason to the task reason grammar', () => {
    const reason = astraTaskFaultReason('astra-computer-action-task:' + 'x'.repeat(120));
    expect(reason.length).toBe(96);
    expect(reason).toMatch(/^[a-z0-9:-]{1,96}$/u);
  });

  it('drives every task past a contained fault and skips quarantined ones', () => {
    const seen: string[] = [], faults: string[] = [];
    const views = synchronizeEach(['a', 'b', 'c', 'd'], id => {
      seen.push(id); if (id === 'b') throw new Error('astra-agent-task:action-missing'); return id.toUpperCase();
    }, { skip: id => id === 'd', fault: (id, error) => { faults.push(id + ':' + (error as Error).message); } });
    expect(views).toEqual(['A', 'C']);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(faults).toEqual(['b:astra-agent-task:action-missing']);
  });

  it('settles a faulting task once, then quarantines it instead of looping', () => {
    const notices: AstraTaskFaultNotice[] = [], settled: string[] = [];
    const containment = new AstraTaskFaultContainment(() => true, notice => notices.push(notice));
    const fault = new Error('astra-agent-decision:evidence-shape');
    const policy = containment.policy('agent', new Map(), (taskId, reason) => settled.push(taskId + '=' + reason));
    policy.fault('t1', fault);
    expect(settled).toEqual(['t1=task-fault:astra-agent-decision:evidence-shape']);
    expect(policy.skip('t1')).toBe(false); // settled tasks still need to be driven to their outcome
    policy.fault('t1', fault);
    expect(settled).toHaveLength(1);
    expect(policy.skip('t1')).toBe(true);
    expect(notices.map(notice => notice.outcome)).toEqual(['settled', 'quarantined']);
  });

  it('quarantines when settling itself faults at task level, but rethrows a host-level settle fault', () => {
    const containment = new AstraTaskFaultContainment(() => true, () => undefined);
    const pass = new Map<string, Set<string>>();
    containment.policy('agent', pass, () => { throw new Error('astra-agent-task:certificate-stream'); })
      .fault('t1', new Error('astra-agent-task:action-missing'));
    expect(containment.policy('agent', pass).skip('t1')).toBe(true);
    const journalDown = new AstraJournalError('closed');
    expect(() => containment.policy('agent', pass, () => { throw journalDown; })
      .fault('t2', new Error('astra-agent-task:action-missing'))).toThrow(journalDown);
  });

  it('treats host-level faults, a lost lease and a shared cause as host failures', () => {
    let owner = true;
    const containment = new AstraTaskFaultContainment(() => owner, () => undefined);
    const pass = new Map<string, Set<string>>(), policy = containment.policy('read', pass);
    expect(() => policy.fault('t1', new Error('astra-scheduler:closed'))).toThrow('astra-scheduler:closed');
    const same = new Error('astra-read-task:proof');
    policy.fault('t2', same); containment.policy('agent', pass).fault('t3', same);
    expect(() => policy.fault('t4', same)).toThrow(same); // three tasks, one code, one pass
    owner = false;
    expect(() => containment.policy('read', new Map()).fault('t5', new Error('astra-read-task:other')))
      .toThrow('astra-read-task:other');
  });

  it('stops containing once its bounded memory is full', () => {
    const containment = new AstraTaskFaultContainment(() => true, () => undefined, 2);
    const policy = () => containment.policy('create', new Map());
    policy().fault('a', new Error('astra-create-task:x'));
    policy().fault('b', new Error('astra-create-task:x'));
    expect(() => policy().fault('c', new Error('astra-create-task:x'))).toThrow('astra-create-task:x');
  });

  it('lets the policy escalate a fault, and preserves the old behaviour without one', () => {
    const sync = (id: string) => { if (id === 'b') throw new Error('astra-scheduler:closed'); return id; };
    expect(() => synchronizeEach(['a', 'b'], sync, { skip: () => false,
      fault: (_id, error) => { throw error; } })).toThrow('astra-scheduler:closed');
    expect(() => synchronizeEach(['a', 'b'], sync)).toThrow('astra-scheduler:closed');
  });
});
