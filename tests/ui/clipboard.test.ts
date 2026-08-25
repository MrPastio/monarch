import { describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../../src/ui/public/modules/clipboard.js';

describe('clipboard helper', () => {
  it('prefers the trusted Electron bridge in Desktop', async () => {
    const copyText = vi.fn().mockResolvedValue(true);
    const writeText = vi.fn();

    await expect(copyTextToClipboard('shutdown /s /f /t 0', {
      desktop: { copyText },
      clipboard: { writeText },
    })).resolves.toBe(true);

    expect(copyText).toHaveBeenCalledWith('shutdown /s /f /t 0');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses the browser Clipboard API when the Desktop bridge is absent', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await expect(copyTextToClipboard('copy me', {
      desktop: null,
      clipboard: { writeText },
    })).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('copy me');
  });

  it('falls back to a temporary selection when async clipboard access fails', async () => {
    const textarea = {
      value: '',
      style: {},
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    const documentRef = {
      activeElement: { focus: vi.fn() },
      body: { appendChild: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(true),
    };

    await expect(copyTextToClipboard('fallback', {
      desktop: { copyText: vi.fn().mockRejectedValue(new Error('ipc failed')) },
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      documentRef,
    })).resolves.toBe(true);

    expect(textarea.value).toBe('fallback');
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(documentRef.execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.remove).toHaveBeenCalledOnce();
  });
});
