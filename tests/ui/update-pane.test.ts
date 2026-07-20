import { describe, expect, it } from 'vitest';
import { primaryIntentForState } from '../../src/ui/public/modules/update-pane.js';

describe('Monarch update pane', () => {
  it('keeps the main update UX one-step while preserving pause and resume', () => {
    expect(primaryIntentForState('update-available')).toBe('install');
    expect(primaryIntentForState('ready-to-install')).toBe('install');
    expect(primaryIntentForState('downloading')).toBe('pause');
    expect(primaryIntentForState('paused')).toBe('resume');
    expect(primaryIntentForState('failed')).toBe('check');
  });
});
