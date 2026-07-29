import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync('src/ui/public/index.html', 'utf8');
const coderSource = readFileSync('src/ui/public/modules/coder-pane.js', 'utf8');
const coderStyles = readFileSync('src/ui/public/coder.css', 'utf8');

describe('Coder task-first workspace UX', () => {
  it('keeps project and model selection visible while moving only secondary tools into one popover', () => {
    const workspaceBar = indexSource.slice(
      indexSource.indexOf('<header class="coder-workspace-bar">'),
      indexSource.indexOf('<div id="coder-onboarding"'),
    );

    expect(workspaceBar).toContain('class="coder-project-identity"');
    expect(workspaceBar).toContain('id="coder-run-status"');
    expect(workspaceBar).toContain('class="coder-project-switcher"');
    expect(workspaceBar).toContain('class="coder-model-switch coder-model-switch-inline"');
    expect(workspaceBar).toContain('<details class="coder-action-menu coder-setup-menu">');
    expect(workspaceBar).toContain('>Ещё</summary>');
    expect(workspaceBar).toContain('id="coder-project-select"');
    expect(workspaceBar).toContain('id="coder-project-new"');
    expect(workspaceBar).toContain('id="coder-project-import"');
    expect(workspaceBar).toContain('data-coder-model="qwen3-coder-30b-a3b-instruct"');
    expect(workspaceBar).toContain('id="coder-safe-encrypt"');
    expect(workspaceBar).toContain('id="coder-fast-open"');
    expect(indexSource).not.toContain('class="coder-mobile-bar"');
  });

  it('uses a stable command rail instead of hiding primary navigation behind a context menu', () => {
    expect(indexSource).toContain('<span class="coder-kicker">ТЕКУЩАЯ ЦЕЛЬ</span>');
    expect(indexSource).toContain('<nav class="coder-command-rail" aria-label="Разделы Coder">');
    expect(indexSource).toContain('id="coder-workspace-focus"');
    expect(indexSource).toContain('id="coder-mobile-project"');
    expect(indexSource).toContain('id="coder-history-open"');
    expect(indexSource).toContain('id="coder-mobile-result"');
    expect(indexSource).not.toContain('<details class="coder-context-menu">');
    expect(coderStyles).toMatch(/\.coder-workspace\s*\{[^}]*grid-template-columns:\s*82px minmax\(0,\s*1fr\);/s);
    expect(coderStyles).toContain('.coder-command-rail button.is-current');
    expect(coderStyles).toContain('.coder-explorer.is-drawer-open,');
    expect(coderStyles).toContain('.coder-context-panel.is-drawer-open');
    expect(coderSource).toContain("openWorkspaceDrawer('result')");
    expect(coderSource).toContain("classList.toggle('is-drawer-open', panel === 'project')");
    expect(coderSource).toContain("syncWorkspaceNavigation('work')");
    expect(coderSource).not.toContain('resultPanelOpen');
  });

  it('shows truthful task progress and keeps technical events one explicit switch away', () => {
    expect(indexSource).toContain('id="coder-progress-brief" data-state="current"');
    expect(indexSource).toContain('id="coder-progress-work" data-state="idle"');
    expect(indexSource).toContain('id="coder-progress-verify" data-state="idle"');
    expect(coderSource).toContain('function renderRunProgress(run)');
    expect(coderSource).toContain("event?.kind === 'tool-result' && event?.ok === true");
    expect(coderSource).toContain("Array.isArray(run?.summary?.tests)");
    expect(coderSource).toContain('const CODER_FOCUS_EVENT_LIMIT = 6;');
    expect(coderSource).toContain("presentation.tone === 'failure'");
    expect(coderSource).toContain("archive.className = 'coder-event-archive'");
    expect(coderSource).toContain("summary.textContent = 'Показать полностью'");
    expect(indexSource).toContain('data-coder-event-filter="focus" aria-pressed="true">Главное</button>');
    expect(indexSource).toContain('data-coder-event-filter="all" aria-pressed="false">Подробно</button>');
    expect(indexSource).toContain('class="coder-event-view-switch"');
    expect(indexSource).not.toContain('<details class="coder-journal-menu">');
    expect(coderStyles).toContain('.coder-activity::before');
    expect(coderStyles).toContain('.coder-event::before');
    expect(coderStyles).toMatch(/\.coder-event\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  });

  it('presents one primary action for every task lifecycle state', () => {
    expect(indexSource).toContain('id="coder-run-submit" type="submit" class="coder-primary">Начать работу</button>');
    expect(coderSource).toContain('renderComposerVisibility(run)');
    expect(coderSource).toContain("['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)");
    expect(coderSource).toContain("elements.runRetry.textContent = 'Новая задача'");
    expect(coderSource).toContain("elements.runRetry.textContent = 'Изменить задачу'");
    expect(coderSource).toContain("elements.runRetry.textContent = 'Продолжить с checkpoint'");
    expect(coderStyles).toContain('.coder-composer[hidden] { display: none; }');
    expect(coderStyles).toContain('.coder-composer[aria-busy="true"] textarea');
  });

  it('keeps results user-facing while placing metrics under technical disclosure', () => {
    const contextPanel = indexSource.slice(
      indexSource.indexOf('<aside id="coder-context-panel"'),
      indexSource.indexOf('</aside>', indexSource.indexOf('<aside id="coder-context-panel"')),
    );

    expect(contextPanel).toContain('<span>Итог</span>');
    expect(contextPanel).toContain('Изменённые файлы');
    expect(contextPanel).toContain('Проверки');
    expect(contextPanel).toContain('<details class="coder-context-technical">');
    expect(contextPanel.indexOf('id="coder-context-percent"'))
      .toBeGreaterThan(contextPanel.indexOf('<details class="coder-context-technical">'));
  });
});
