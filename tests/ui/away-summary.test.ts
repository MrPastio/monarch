// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderAwaySummary, summarizeAwayIncidents } from '../../src/ui/public/modules/away-summary.js';

describe('while you were away', () => {
  it('counts only events after the last visit and the ones still open', () => {
    const since = Date.parse('2026-09-25T10:00:00Z');
    const summary = summarizeAwayIncidents([
      { created_at: '2026-09-25T09:00:00Z', status: 'open' },
      { created_at: '2026-09-25T11:00:00Z', status: 'open' },
      { created_at: '2026-09-25T12:00:00Z', status: 'resolved' },
    ], since);
    expect(summary).toEqual({ total: 2, open: 1 });
    expect(renderAwaySummary(summary)).toContain('Security записал 2 события · ждут решения: 1');
  });
  it('stays silent when nothing happened', () => {
    expect(renderAwaySummary({ total: 0, open: 0 })).toBe('');
  });
});
