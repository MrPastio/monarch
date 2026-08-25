import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_PROVIDER_AGREEMENT,
  IMAGE_PROVIDER_AGREEMENT_VERSION,
} from '../../src/image-generation';

const legalDocument = readFileSync('docs/legal/EXTERNAL_CLOUD_SERVICES_TERMS_RU.md', 'utf8');

describe('external cloud services agreement', () => {
  it('publishes Perchance as the primary interactive provider and AI Horde as emergency-only', () => {
    expect(IMAGE_PROVIDER_AGREEMENT.version).toBe(IMAGE_PROVIDER_AGREEMENT_VERSION);
    expect(IMAGE_PROVIDER_AGREEMENT.provider).toMatchObject({
      name: 'AI Horde',
      minimumAge: 13,
      termsUrl: 'https://aihorde.net/terms/',
      privacyUrl: 'https://aihorde.net/privacy/',
    });
    expect(IMAGE_PROVIDER_AGREEMENT.manualFallback).toMatchObject({
      name: 'Perchance',
      termsUrl: 'https://perchance.org/terms-of-service',
    });
    expect(IMAGE_PROVIDER_AGREEMENT.sections.length).toBeGreaterThanOrEqual(18);
    const text = JSON.stringify(IMAGE_PROVIDER_AGREEMENT);
    expect(text).toContain('Perchance всегда выбирается по умолчанию');
    expect(text).toContain('AI Horde не запускается автоматически');
    expect(text).toContain('только лицам от 18 лет');
    expect(text).toContain('не автоматизирует DOM');
    expect(text).toContain('нажатия пользователем Download');
    expect(text).toContain('проверяет magic bytes');
    expect(text).toContain('исключительно тестовой BETA-функцией');
    expect(text).toContain('не является production-сервисом');
  });

  it('draws an explicit product/network boundary without pretending mandatory liability disappears', () => {
    const text = JSON.stringify(IMAGE_PROVIDER_AGREEMENT);
    expect(text).toContain('не создаёт аффилированность, партнёрство');
    expect(text).toContain('формирует HTTPS API-запрос к AI Horde');
    expect(text).toContain('не добавляет собственную облачную телеметрию');
    expect(text).toContain('Каждый будущий provider');
    expect(text).toContain('собственные действия и дефекты Monarch');
    expect(text).toContain('закон запрещает исключать');
    expect(text).toContain('несовершеннолетними');
    expect(text).toContain('deepfakes');
    expect(text).toContain('закон запрещает исключать');
  });

  it('keeps the detailed release document aligned with re-consent and legal-review boundaries', () => {
    expect(legalDocument).toContain(`Версия: \`${IMAGE_PROVIDER_AGREEMENT_VERSION}\``);
    expect(legalDocument).toContain('не является бессрочным или blanket-разрешением');
    expect(legalDocument).toContain('Основной генератор — независимый сайт **Perchance**');
    expect(legalDocument).toContain('Скрытого или автоматического переключения нет');
    expect(legalDocument).toContain('sandboxed `WebContentsView`');
    expect(legalDocument).toContain('локальному мосту сохранения Monarch');
    expect(legalDocument).toContain('**TEST BETA:**');
    expect(legalDocument).toContain('юридическое имя/наименование оператора');
    expect(legalDocument).toContain('Абсолютная фраза «Разработчик ни за что и никогда не отвечает» не должна использоваться');
  });
});
