import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync('src/ui/public/index.html', 'utf8');
const app = readFileSync('src/ui/public/app.js', 'utf8');
const onboarding = readFileSync('src/ui/public/modules/model-onboarding.js', 'utf8');
const welcome = readFileSync('src/ui/public/modules/model-setup-welcome.js', 'utf8');
const models = readFileSync('src/ui/public/modules/model-manager.js', 'utf8');
const styles = readFileSync('src/ui/public/ui-refresh.css', 'utf8');
const setupStyles = readFileSync('src/ui/public/setup-flow.css', 'utf8');

describe('first-run model setup UI', () => {
  it('starts with one hardware recommendation and keeps every model voluntarily available', () => {
    expect(html).toContain('id="model-setup"');
    expect(html).toContain('Показать все модели');
    expect(html).toContain('Скачать все три');
    expect(html).toContain('Пропустить установку моделей');
    expect(html).toContain('Если автоматическая установка не работает :(');
    expect(html).toContain('id="model-setup-manual"');
    expect(onboarding).toContain('models.filter((model) => model.role === recommendedRole || selectedRoles.has(model.role))');
    expect(onboarding).toContain("installModels(roles, required && flow.mode === 'first' ? 'onboarding' : 'settings')");
    expect(onboarding).toContain('skipModelOnboarding()');
    expect(onboarding).toContain('selectedRoles = elements.allInput.checked ? new Set(roles)');
  });

  it('asks where Oscar should think and adapts the steps to the answer', () => {
    for (const mode of ['local', 'max', 'hybrid']) expect(html).toContain(`data-setup-mode="${mode}"`);
    expect(html).toContain('Где будет думать Оскар?');
    expect(onboarding).toContain("if (flow.work === 'hybrid') steps.push('local', 'max');");
    expect(onboarding).toContain("saveModelPreference({ work: flow.work || 'local', maxLocalFallback: flow.fallback })");
    // Installs that already had models (an update from 0.2.x) still get the setup once.
    expect(onboarding).toContain('if (!required && setupNeverFinished(components) && !flow.open && !flow.finishing)');
    expect(onboarding).toContain("if (!completion || completion === 'not-applicable' || completion === 'pending') return false;");
    // MAX connects through the same bridge and the same three disclosures as Settings → MAX.
    for (const consent of ['nonLocalProcessing', 'selectedContext', 'providerTerms']) expect(html).toContain(`data-setup-consent="${consent}"`);
    expect(onboarding).toContain('bridge.configureProvider(input)');
    expect(onboarding).toContain("input.apiKey = ''");
    expect(html).toContain('id="setup-fallback-input" checked');
  });

  it('renders pinned manual files and opens the exact models root through the trusted desktop bridge', () => {
    expect(onboarding).toContain('model.manualInstall');
    expect(html).toContain('Открыть папку моделей');
    expect(onboarding).toContain('window.monarchDesktop?.openModelsFolder');
    expect(onboarding).toContain('target="_blank"');
  });

  it('keeps implementation details out of the friendly first-run copy', () => {
    const setupMarkup = html.slice(html.indexOf('<section class="model-setup"'), html.indexOf('<div class="app-shell'));
    expect(setupMarkup).not.toMatch(/SHA-256|Hugging Face|провер(ка|яется) целостности|данные остаются/iu);
    expect(onboarding).not.toMatch(/SHA-256|Hugging Face|провер(ка|яется) целостности|данные остаются/iu);
  });

  it('shows only installed models in chat and keeps all downloads in Settings', () => {
    expect(app).toContain('readSelectableOscarModelAvailability');
    expect(app).toContain('item.hidden = hideUnavailable && disabled');
    expect(models).toContain('data-model-install="gemma4-fast,gemma4-balanced,qwen3.8-27b-pro"');
    expect(models).toContain("installModels(roles, 'settings')");
  });

  it('animates through one owner with a responsive reduced-motion path', () => {
    expect(onboarding).toContain('function goTo(step, direction, options = {})');
    expect(onboarding).toContain('settleTransitions();');
    expect(onboarding).toContain('reducedUiMotion.matches');
    expect(setupStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(setupStyles).toContain('html[data-motion="reduced"] .setup');
    expect(setupStyles).toContain('@media (max-width: 760px)');
    expect(setupStyles).not.toMatch(/animation:[^;]*infinite/u);
  });

  it('keeps polling from every component state update so installed completion replaces stale progress', () => {
    expect(app).toMatch(/function render\(\) \{[\s\S]*scheduleComponentStateRefresh\(state\.data\?\.components\)/);
  });

  it('plays the slower post-model brand and five-second beta message once, with click-to-skip', () => {
    expect(html).toContain('id="model-setup-welcome"');
    expect(html).toContain('Не судите строго,это только BETA,приятного использования');
    expect(welcome).toContain('onboarding?.welcomeRequired !== true');
    expect(welcome).toContain('acknowledgeModelOnboardingWelcome()');
    expect(welcome).toContain("addEventListener('click'");
    expect(welcome).toContain('MODEL_WELCOME_MESSAGE_MS = 5_000');
    expect(styles).toContain('.model-setup-welcome');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
