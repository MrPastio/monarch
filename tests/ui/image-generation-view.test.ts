import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatManualProviderPrompt } from '../../src/ui/public/modules/image-generation-pane.js';

const readSource = (relativePath: string) =>
  readFileSync(relativePath, 'utf8').replace(/\r\n?/g, '\n');

const appSource = readSource('src/ui/public/app.js');
const indexSource = readSource('src/ui/public/index.html');
const paneSource = readSource('src/ui/public/modules/image-generation-pane.js');
const genesisSource = readSource('src/ui/public/modules/monarch-genesis-field.js');
const oscarSource = readSource('src/ui/public/modules/oscar-pane.js');

describe('Images workspace', () => {
  it('keeps an empty Perchance draft empty instead of duplicating generated aspect-ratio lines', () => {
    expect(formatManualProviderPrompt({ prompt: '', aspectRatio: '1:1', style: 'none', count: 1 })).toBe('');
    expect(formatManualProviderPrompt({ prompt: 'orange monarch', aspectRatio: '1:1', style: 'none', count: 1 }))
      .toBe('orange monarch\nAspect ratio: 1:1');
  });

  it('replaces Project with direct image generation and removes top-level Models', () => {
    expect(indexSource).toContain('data-scroll-target="images-section"');
    expect(indexSource).toContain('<span>Изображения</span>');
    expect(indexSource).not.toContain('id="workspace-section"');
    expect(indexSource).not.toContain('id="models-section"');
    expect(indexSource).not.toContain('data-scroll-target="models-section"');
    expect(indexSource).toContain('data-settings-panel="models"');
    expect(appSource).toContain("if (activeView === 'images-section')");
    expect(appSource).toContain('renderImageGenerationPane();');
  });

  it('uses embedded Perchance by default and keeps AI Horde as an explicit emergency job', () => {
    expect(indexSource).toContain('data-images-tab="perchance"');
    expect(indexSource).toContain('id="image-emergency-tab" hidden');
    expect(indexSource).toContain('AI Horde используется только когда Perchance недоступен');
    expect(indexSource).toContain('id="image-generation-form"');
    expect(indexSource).toContain('id="image-perchance-bridge"');
    expect(paneSource).toContain('prepareImageGeneration(draft)');
    expect(paneSource).toContain("preparation.status === 'confirmation-required'");
    expect(paneSource).toContain('fetchImageGenerationJob(job.jobId)');
    expect(paneSource).toContain('fetchImageGenerationResult(job.jobId, index)');
    expect(paneSource).toContain('cancelImageGenerationJob(job.jobId)');
    expect(paneSource).toContain('window.monarchDesktop.openImageProvider');
    expect(paneSource).toContain('desktop.showEmbeddedImageProvider');
    expect(paneSource).toContain("revealEmergencyProvider(`Perchance недоступен");
  });

  it('blocks every provider handoff until the current agreement and both checkboxes are accepted', () => {
    expect(indexSource).toContain('id="image-cloud-processing-consent"');
    expect(indexSource).toContain('id="image-third-party-terms-consent"');
    expect(indexSource).toContain('id="image-provider-consent-confirm" disabled');
    expect(indexSource).toContain('Без обоих подтверждений Monarch не откроет встроенный Perchance');
    expect(indexSource).toContain('id="image-perchance-adult-attestation"');
    expect(paneSource).toContain("action: 'perchance-access'");
    expect(paneSource).toContain('fetchImageProviderAgreement()');
    expect(paneSource).toContain('agreementVersion: agreement.version');
    expect(paneSource).toContain('cloudProcessingAccepted: true');
    expect(paneSource).toContain('thirdPartyTermsAccepted: true');
    expect(paneSource).not.toContain('adultAttested: true,\n        } : null');
    expect(paneSource).toContain('acceptImageProviderAgreement()');
    expect(indexSource).toContain('</section>\n\n          <dialog class="image-confirm-dialog" id="image-perchance-age-dialog"');
    expect(indexSource).toContain('<dialog class="image-confirm-dialog image-provider-consent-dialog"');
    expect(paneSource).toContain('closeImageProvider?.()');
  });

  it('explains the independent free service and ads after consent plus the 18+ attestation', () => {
    expect(indexSource).toContain('id="image-perchance-intro-dialog"');
    expect(indexSource).toContain('Бесплатный режим сервиса');
    expect(indexSource).toContain('На странице есть реклама');
    expect(indexSource).toContain('Сеть принадлежит стороннему сервису');
    expect(indexSource).toContain('Почему интерфейс отличается');
    expect(paneSource).toContain("action: 'perchance-intro'");
    expect(paneSource).toContain('providerIntroAcknowledgedAt');
  });

  it('marks the Perchance integration explicitly as a test-only BETA feature', () => {
    expect(indexSource).toContain('<span class="image-beta-chip">BETA</span>');
    expect(indexSource).toContain('Тестовая BETA-функция');
    expect(indexSource).toContain('Не готовая production-функция');
    expect(indexSource).toContain('Экспериментальная функция без SLA');
    expect(indexSource).toContain('Основной сервис · TEST BETA');
    expect(paneSource).toContain('Perchance · BETA');
    expect(paneSource).toContain('тестовая внешняя функция · 18+');
  });

  it('provides stateless Fast prompt translation and imports a real Perchance Download into Gallery', () => {
    expect(indexSource).toContain('id="image-perchance-prompt"');
    expect(indexSource).toContain('id="image-perchance-translate"');
    expect(indexSource).toContain('без истории, памяти и поиска в интернете');
    expect(paneSource).toContain('translateImagePrompt(text)');
    expect(paneSource).toContain('result.translatedText');
    expect(paneSource).toContain('onImageProviderDownload');
    expect(paneSource).toContain("value.status !== 'ready'");
    expect(paneSource).toContain('await importImageToLibrary({');
    expect(paneSource).toContain('dataBase64: value.dataBase64');
  });

  it('routes Oscar image requests through the same provider policy instead of simulating output', () => {
    expect(oscarSource).toContain('evaluateImageGenerationIntent(visibleText');
    expect(oscarSource).toContain('handoffOscarImageGeneration(imageIntent');
    expect(oscarSource).toContain('reserveOscarImageProviderWindow(visibleText)');
    expect(paneSource).toContain("detail: { source: 'oscar', preparation }");
  });

  it('implements Genesis Field without fake progress stages', () => {
    expect(indexSource).toContain('id="monarch-genesis-field"');
    expect(genesisSource).toContain("const ACTIVE_STATES = new Set(['preparing', 'generating'])");
    expect(genesisSource).toContain('requestAnimationFrame');
    expect(genesisSource).toContain("prefers-reduced-motion: reduce");
    expect(genesisSource).toContain('detectLowPerformance()');
    expect(genesisSource).not.toMatch(/progress(?:bar|Percent)|Math\.round\([^)]*100/iu);
  });

  it('hides NSFW gallery content until both policy and session visibility allow it', () => {
    expect(indexSource).toContain('id="image-nsfw-visibility" hidden');
    expect(paneSource).toContain("record.contentRating !== 'nsfw' || nsfwVisible");
    expect(paneSource).toContain('if (!active) {');
    expect(paneSource).toContain('nsfwVisible = false;');
  });
});
