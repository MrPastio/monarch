import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync('src/ui/public/app.js', 'utf8');

describe('workspace view rendering', () => {
  it('renders live workspace data when the Project view is active', () => {
    expect(appSource).toContain(
      "if (activeView === 'models-section' || activeView === 'workspace-section') {",
    );
    expect(appSource).toMatch(
      /if \(activeView === 'models-section' \|\| activeView === 'workspace-section'\) \{\s*renderModelManager\(\);\s*return;/,
    );
  });
});
