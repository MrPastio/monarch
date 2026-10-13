import { describe, expect, it } from 'vitest';
import {
  ASTRA_INTERACTIVE_AGENT_DEADLINE_MS,
  interactiveAgentDeadlineMs,
} from '../../src/app/astra-task-facade';
import { ASTRA_AGENT_MAX_TASK_DURATION_MS } from '../../src/agent-v3/agent-task-profile';

describe('deadline for a chat-initiated agent task', () => {
  it('does not leave a request typed in chat running until tomorrow', () => {
    // Submitted without a deadline, a task inherits the contract's ceiling.
    // That ceiling is for work someone budgeted for; a person who typed a
    // request is waiting at the screen.
    expect(interactiveAgentDeadlineMs(undefined)).toBe(ASTRA_INTERACTIVE_AGENT_DEADLINE_MS);
    expect(ASTRA_INTERACTIVE_AGENT_DEADLINE_MS).toBeLessThan(ASTRA_AGENT_MAX_TASK_DURATION_MS);
    // Still long enough for real multi-step local work.
    expect(ASTRA_INTERACTIVE_AGENT_DEADLINE_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('defers to a budget the request already states', () => {
    expect(interactiveAgentDeadlineMs({ budgets: { maxWallTimeMs: 90_000 } })).toBeUndefined();
    // An empty budget block states nothing, so it is not a stated budget.
    expect(interactiveAgentDeadlineMs({ budgets: {} })).toBe(ASTRA_INTERACTIVE_AGENT_DEADLINE_MS);
    expect(interactiveAgentDeadlineMs({})).toBe(ASTRA_INTERACTIVE_AGENT_DEADLINE_MS);
  });

  it('leaves the twelve hour ceiling alone for host-selected Coder project work', () => {
    // `submitOwned` requires an execution profile if and only if the actor is
    // `coder` — the pilot running host-selected project work on its own
    // schedule, not a person typing in chat. Clamping that to thirty minutes
    // broke real multi-hour project tasks.
    expect(interactiveAgentDeadlineMs(undefined, true)).toBeUndefined();
    expect(interactiveAgentDeadlineMs({}, true)).toBeUndefined();
    expect(interactiveAgentDeadlineMs({ budgets: { maxWallTimeMs: 90_000 } }, true)).toBeUndefined();
  });
});
