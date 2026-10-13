import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeAstraMaxSetupView,
  validAstraMaxSetupInput,
} from '../../src/ui/public/modules/astra-max-setup.js';

describe('Astra MAX first-use setup', () => {
  it('normalizes a bounded credential-free desktop view', () => {
    expect(normalizeAstraMaxSetupView({ available: true, state: 'ready', connectionVerified: true, title: 'Игнорируется',
      detail: 'Игнорируется.', nextAction: 'none', models: [
        { id: 'gpt-oss-120b', label: 'GPT OSS 120B', detail: 'Для сложных задач' },
        { id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B', detail: 'Preview', preview: true },
      ] })).toEqual({ available: true, state: 'ready', connectionVerified: true, title: 'MAX готов',
      detail: 'Подключение проверено. MAX можно использовать для новых задач.',
      nextAction: 'none', models: [
        { id: 'gpt-oss-120b', label: 'GPT OSS 120B', detail: 'Для сложных задач', preview: false },
      ] });
    expect(normalizeAstraMaxSetupView({ available: true, state: 'ready', title: 'MAX готов' })).toMatchObject({
      connectionVerified: false, title: 'Ключ MAX сохранён', detail: 'Доступ проверится при первой задаче.',
    });
    expect(JSON.stringify(normalizeAstraMaxSetupView({ state: 'unknown', apiKey: 'gsk_secret' })))
      .not.toContain('gsk_secret');
  });

  it('requires the key and all three explicit acknowledgements', () => {
    const key = 'gsk_preview_fixture_123456789012345';
    expect(validAstraMaxSetupInput(key, {
      nonLocalProcessing: true, selectedContext: true, providerTerms: true,
    })).toBe(true);
    expect(validAstraMaxSetupInput(key, {
      nonLocalProcessing: true, selectedContext: false, providerTerms: true,
    })).toBe(false);
    expect(validAstraMaxSetupInput('short', {
      nonLocalProcessing: true, selectedContext: true, providerTerms: true,
    })).toBe(false);
  });

  it('places MAX in the model menu with a separate explicit cloud-mode choice', () => {
    const index = readFileSync('src/ui/public/index.html', 'utf8');
    const app = readFileSync('src/ui/public/app.js', 'utf8');
    const setup = readFileSync('src/ui/public/modules/astra-max-setup.js', 'utf8');
    const styles = readFileSync('src/ui/public/ui-refresh.css', 'utf8');
    const astraComposer = readFileSync('src/ui/public/modules/oscar-astra-composer.js', 'utf8');
    const turnPanel = readFileSync('src/ui/public/modules/astra-turn-panel.js', 'utf8');
    expect(index).toContain('data-astra-max-open');
    expect(index).not.toContain('id="astra-max-setup-dialog"');
    expect(index).toContain('id="astra-max-key" type="password"');
    expect(index).toContain('id="astra-max-cloud-check"');
    expect(index).toContain('id="astra-max-context-check"');
    expect(index).toContain('id="astra-max-terms-check"');
    expect(index).not.toContain('id="astra-max-use"');
    expect(index.includes('id="astra-max-qwen-preview-check"')).toBe(false);
    expect(index).not.toContain('data-value="astra-max"');
    expect(app).toContain('astraMaxMode = initAstraMaxSetup()');
    expect(setup).toContain('window.monarchDesktop?.astraMax');
    expect(setup).toContain("selected: () => selected && active()");
    expect(setup.includes("modelChoice === 'qwen-3.8-27b'")).toBe(false);
    expect(setup.includes('previewAcknowledged: true')).toBe(false);
    expect(setup).toContain('Проверяю ключ и модель. Ещё немного…');
    expect(setup).not.toContain('Проверяю и сохраняю подключение…');
    expect(setup).not.toMatch(/(?:localStorage|sessionStorage)\.setItem\([^\n]*(?:apiKey|key\.value)/u);
    expect(astraComposer).toContain("bridge.maxPreview === true");
    expect(astraComposer).toContain('astra-max-pilot-dock');
    expect(turnPanel).toContain("node('strong', 'Оскар')");
    expect(turnPanel).toContain('Время работы:');
    expect(turnPanel).not.toMatch(/Задача: ['"]? \+ current\.turn\.id|Runtime требует внимания|Отпечаток содержимого:/u);
    expect(styles).not.toContain('.astra-max-dialog');
    expect(styles).toContain('.astra-max-model-choice');
    expect(styles).toContain('backdrop-filter: blur(28px)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
