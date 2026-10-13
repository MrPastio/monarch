import { describe, expect, it } from 'vitest';
import { collectReferencedComponents } from '../../desktop/electron/component-references.mjs';

describe('component ownership inventory', () => {
  it('passes roots as encoded data and returns only known roots', async () => {
    const roots = ["E:\\Monarch App\\versions\\0.3.0.25", "E:\\literal'$()"];
    const result = await collectReferencedComponents(roots, { platform: 'win32', run: async (exe, args, options) => {
      expect(exe).toBe('powershell.exe');
      expect(options.windowsHide).toBe(true);
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      expect(script).not.toContain(roots[1]);
      expect(script).toContain(Buffer.from(JSON.stringify(roots)).toString('base64'));
      expect(script).toContain('Get-CimInstance Win32_Process');
      expect(script).toContain('Get-ScheduledTask');
      return { stdout: JSON.stringify([roots[0]]) };
    }});
    expect(result).toEqual([roots[0]]);
  });
  it.each(['{}', '["unexpected"]', 'invalid'])('rejects incomplete or foreign readback: %s', async stdout => {
    await expect(collectReferencedComponents(['E:\\known'], { platform: 'win32', run: async () => ({ stdout }) })).rejects.toThrow();
  });
  it('does not interpret inventory failure as no references', async () => {
    await expect(collectReferencedComponents(['E:\\known'], { platform: 'win32', run: async () => { throw new Error('access denied'); } })).rejects.toThrow('access denied');
  });
});
