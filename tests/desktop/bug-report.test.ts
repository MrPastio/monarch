import { describe, expect, it } from 'vitest';
import {
  BUG_REPORT_ADDRESS,
  bugReportGmailUrl,
  bugReportMailto,
  composeBugReport,
} from '../../desktop/electron/bug-report.mjs';

const system = { version: '0.3.0.98', os: 'Windows 10.0.26300 x64', memory: '16 ГБ' };

describe('bug report letter', () => {
  it('always goes to the fixed address with the computer details appended', () => {
    const report = composeBugReport({ description: 'Нет первой настройки\nпосле установки', context: 'Вид: pp' }, system);
    expect(report.subject).toBe('Monarch 0.3.0.98: Нет первой настройки');
    expect(report.body).toContain('Версия Monarch: 0.3.0.98');
    expect(report.body).toContain('Вид: pp');
    const mailto = bugReportMailto(report);
    expect(mailto.startsWith(`mailto:${BUG_REPORT_ADDRESS}?subject=`)).toBe(true);
    const gmail = new URL(bugReportGmailUrl(report));
    expect(gmail.hostname).toBe('mail.google.com');
    expect(gmail.searchParams.get('to')).toBe('mrpastio@gmail.com');
  });

  it('refuses an empty report and keeps long letters within what mail programs open', () => {
    expect(() => composeBugReport({ description: '   ' }, system)).toThrow('bug-report-empty');
    const report = composeBugReport({ description: 'ж'.repeat(5000), context: 'к'.repeat(5000) }, system);
    expect(report.body.length).toBeLessThan(2000);
    expect(bugReportMailto(report).length).toBeLessThanOrEqual(1900);
  });
});
