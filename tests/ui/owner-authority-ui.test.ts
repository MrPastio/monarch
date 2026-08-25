import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeOwnerEnrollmentStatus,
  ownerEnrollmentDiagnosticMessage,
} from '../../src/ui/public/modules/owner-enrollment.js';

const html = readFileSync('src/ui/public/index.html', 'utf8');
const app = readFileSync('src/ui/public/app.js', 'utf8');
const styles = readFileSync('src/ui/public/styles-v2.css', 'utf8');
const enrollment = readFileSync('src/ui/public/modules/owner-enrollment.js', 'utf8');
const preload = readFileSync('desktop/electron/preload.mjs', 'utf8');

describe('Owner authority UI', () => {
  it('shows a glass authority badge without a client-side Owner switch', () => {
    expect(html).toContain('id="authority-status-card"');
    expect(html).toContain('id="authority-tier"');
    expect(app).toContain("authority?.source === 'signed-device-entitlement'");
    expect(styles).toContain('.authority-status-card[data-tier="owner"]');
    expect(html).not.toMatch(/(?:owner|authority)[^>]{0,80}<input/iu);
    expect(app).not.toMatch(/setAuthority|updateAuthority|enableOwner/u);
  });

  it('offers packaged request/export/import/restart without exposing key material', () => {
    expect(html).toContain('id="owner-enrollment-card"');
    expect(html).toContain('id="owner-request-export"');
    expect(html).toContain('id="owner-entitlement-import"');
    expect(styles).toContain('.owner-enrollment-card');
    expect(enrollment).toContain('getOwnerEnrollmentStatus');
    expect(enrollment).toContain('importOwnerEntitlement');
    expect(preload).toContain("ipcRenderer.invoke('monarch:owner-device-request-export')");
    expect(preload).toContain("ipcRenderer.invoke('monarch:owner-entitlement-import')");
    expect(enrollment).not.toMatch(/device-private|proofSignature|signature\s*:/u);
  });

  it('normalizes only safe enrollment metadata and explains a wrong device', () => {
    expect(normalizeOwnerEnrollmentStatus({
      deviceStatus: 'ready',
      deviceIdPrefix: 'abcdef123456',
      requestReady: true,
      entitlementStatus: 'wrong-device',
      diagnostic: 'owner-device-mismatch',
      signature: 'must-not-survive',
    })).toEqual({
      schemaVersion: 1,
      deviceStatus: 'ready',
      deviceIdPrefix: 'abcdef123456',
      requestReady: true,
      entitlementStatus: 'wrong-device',
      expiresAt: null,
      diagnostic: 'owner-device-mismatch',
      ownerSuspended: false,
    });
    expect(ownerEnrollmentDiagnosticMessage('owner-device-mismatch')).toContain('другого устройства');
  });
});
