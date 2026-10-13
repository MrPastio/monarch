import { describe, expect, it } from 'vitest';
import { findOscarStarterPrompt, oscarStarterPrompts, renderOscarStarterPrompts } from '../../src/ui/public/modules/oscar-starter-prompts.js';

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

describe('empty chat starter prompts', () => {
  it('offers the Internet example only while the Internet switch is on', () => {
    expect(oscarStarterPrompts({ webEnabled: false }).map(p => p.id)).not.toContain('web');
    expect(oscarStarterPrompts({ webEnabled: true }).map(p => p.id)).toContain('web');
  });

  it('renders buttons that carry an id, never the request text as an action', () => {
    const prompts = oscarStarterPrompts();
    const html = renderOscarStarterPrompts(prompts, escapeHtml);
    expect(html.match(/<button type="button"/g)).toHaveLength(prompts.length);
    for (const prompt of prompts) expect(html).toContain(`data-oscar-starter="${prompt.id}"`);
    expect(html).not.toContain('data-oscar-send');
  });

  it('resolves only prompts that are currently offered', () => {
    expect(findOscarStarterPrompt('web', oscarStarterPrompts({ webEnabled: false }))).toBeNull();
    expect(findOscarStarterPrompt('explain', oscarStarterPrompts())?.text).toMatch(/шифрование/);
  });
});
