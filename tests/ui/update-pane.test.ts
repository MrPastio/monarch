import { describe, expect, it } from 'vitest';
import {
  primaryIntentForState,
  shouldShowUpdateNotice,
} from '../../src/ui/public/modules/update-pane.js';

describe('Monarch update pane', () => {
  it('keeps the main update UX one-step while preserving pause and resume', () => {
    expect(primaryIntentForState('update-available')).toBe('install');
    expect(primaryIntentForState('ready-to-install')).toBe('install');
    expect(primaryIntentForState('downloading')).toBe('pause');
    expect(primaryIntentForState('paused')).toBe('resume');
    expect(primaryIntentForState('failed')).toBe('check');
  });

  it('shows the startup notice only when a concrete release needs attention', () => {
    const release = { version: '0.2.3.2' };
    expect(shouldShowUpdateNotice({ state: 'update-available', release })).toBe(true);
    expect(shouldShowUpdateNotice({ state: 'downloading', release })).toBe(true);
    expect(shouldShowUpdateNotice({ state: 'up-to-date', release })).toBe(false);
    expect(shouldShowUpdateNotice({ state: 'failed', release: null })).toBe(false);
  });
});
