import { describe, expect, it } from 'vitest';
import { renderSystemMap, systemMapModules } from '../../src/ui/public/modules/system-map.js';

const escapeHtml = (value: string) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const system = { runtimeContract: { modules: [
  { id: 'coder', name: 'Monarch Coder', kind: 'tooling', status: 'active', capabilities: 20 },
  { id: 'safe', name: 'Monarch Safe', kind: 'system', status: 'inactive', capabilities: 4 },
  { id: 'broken', name: 'Broken', kind: 'domain', status: 'failed', capabilities: 1 },
] } };

describe('system map', () => {
  it('lists live modules by group with plain names', () => {
    expect(systemMapModules(system, 'tooling').map(m => m.name)).toEqual(['Coder']);
    expect(systemMapModules(system).map(m => [m.name, m.status])).toEqual([['Broken', 'failed'], ['Coder', 'active'], ['Safe', 'inactive']]);
  });
  it('summarises how many modules work and renders the chosen filter', () => {
    const html = renderSystemMap(system, 'system', escapeHtml);
    expect(html).toContain('Модулей: 3, работают: 1');
    expect(html).toContain('data-system-map-group="system" aria-checked="true"');
    expect(html).toContain('Safe');
    expect(html).not.toContain('Coder</strong>');
  });
});
