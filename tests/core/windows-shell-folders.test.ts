import { describe, expect, it } from 'vitest';
import { parseWindowsRegistryExport } from '../../src/core/filesystem-policy';

const utf16Hex = (value: string) => [...Buffer.from(value + '\0', 'utf16le')].map(byte => byte.toString(16).padStart(2, '0')).join(',');

describe('Windows shell folder registry export', () => {
  it('reads REG_SZ and REG_EXPAND_SZ values with non-ASCII paths and wrapped hex lines', () => {
    const expand = utf16Hex('%USERPROFILE%\\OneDrive\\Рабочий стол');
    // reg.exe wraps after a comma: "..,\" then an indented continuation line.
    const wrapped = expand.slice(0, 59) + ',\\\r\n  ' + expand.slice(60);
    const text = '\uFEFFWindows Registry Editor Version 5.00\r\n\r\n'
      + '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders]\r\n'
      + `"Desktop"=hex(2):${wrapped}\r\n`
      + '"{374DE290-123F-4565-9164-39C4925E467B}"="C:\\\\Users\\\\owner\\\\Загрузки"\r\n'
      + '"Quoted \\"name\\""="x"\r\n'
      + '"Broken"=hex(2):zz,00\r\n';
    const values = parseWindowsRegistryExport(text);
    expect(values.get('desktop')).toBe('%USERPROFILE%\\OneDrive\\Рабочий стол');
    expect(values.get('{374de290-123f-4565-9164-39c4925e467b}')).toBe('C:\\Users\\owner\\Загрузки');
    expect(values.get('quoted "name"')).toBe('x');
    expect(values.has('broken')).toBe(false);
  });
});
