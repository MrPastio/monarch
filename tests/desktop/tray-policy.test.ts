import { describe, expect, it } from 'vitest';
import { shouldHideToTrayOnClose, trayWindowLabel } from '../../desktop/electron/tray-policy.mjs';

describe('Electron tray lifecycle policy', () => {
  it('hides an ordinary close in the tray instead of quitting', () => {
    expect(shouldHideToTrayOnClose({
      smokeMode: false,
      shuttingDown: false,
      quitRequested: false,
    })).toBe(true);
  });

  it('allows the window to close only during explicit or controlled shutdown', () => {
    expect(shouldHideToTrayOnClose({
      smokeMode: false,
      shuttingDown: false,
      quitRequested: true,
    })).toBe(false);
    expect(shouldHideToTrayOnClose({
      smokeMode: false,
      shuttingDown: true,
      quitRequested: false,
    })).toBe(false);
    expect(shouldHideToTrayOnClose({
      smokeMode: true,
      shuttingDown: false,
      quitRequested: false,
    })).toBe(false);
  });

  it('uses a truthful tray action label for visible and hidden windows', () => {
    expect(trayWindowLabel(true)).toBe('Скрыть Monarch');
    expect(trayWindowLabel(false)).toBe('Открыть Monarch');
  });
});
