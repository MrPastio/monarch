import { describe, expect, it } from 'vitest';
import { renderAccessMatrix } from '../../src/ui/public/modules/access-matrix.js';

const escapeHtml = (value: string) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rows = [
  { autonomyMode: 'guided', sandboxMode: 'read-only', cells: [{ risk: 'read', mode: 'allow' }, { risk: 'money', mode: 'deny' }] },
  { autonomyMode: 'full-local', sandboxMode: 'danger-full-access', cells: [{ risk: 'read', mode: 'allow' }, { risk: 'money', mode: 'deny' }] },
];

describe('Access matrix view', () => {
  it('renders the runtime rows and lights only the active mode', () => {
    const html = renderAccessMatrix(rows, 'full-local', escapeHtml);
    expect(html).toContain('Всегда спрашивать');
    expect(html).toContain('Деньги и платежи');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('data-decision="deny"');
    expect(html).toContain('Запрещено');
  });
  it('renders nothing without runtime rows instead of inventing policy', () => {
    expect(renderAccessMatrix(undefined, 'guided', escapeHtml)).toBe('');
  });
});
