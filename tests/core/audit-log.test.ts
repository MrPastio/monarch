import { describe, expect, it } from 'vitest';
import { MonarchAuditLog } from '../../src/core/audit-log';

describe('MonarchAuditLog secret redaction', () => {
  it('redacts Security PIN and recovery fields recursively', () => {
    const log = new MonarchAuditLog();
    const entry = log.append('security', 'PIN recovery attempted.', {
      pin: '483920',
      newPin: '739105',
      nested: {
        recoveryCode: 'AAAA-BBBB-CCCC-DDDD-EEEE',
        confirmation: '739105',
        safe: 'visible',
      },
    });

    expect(entry.data).toEqual({
      pin: '[redacted]',
      newPin: '[redacted]',
      nested: {
        recoveryCode: '[redacted]',
        confirmation: '[redacted]',
        safe: 'visible',
      },
    });
  });
});
