// Help -> "Сообщить об ошибке". The address is fixed here, in the main
// process: the renderer only supplies the person's own words and a short
// description of the app state. Nothing is sent by Monarch itself — the mail
// program (or Gmail in the browser) opens with the letter filled in, the
// person reads it and presses "Send" there.

export const BUG_REPORT_ADDRESS = 'mrpastio@gmail.com';

const MAX_DESCRIPTION = 1200;
const MAX_CONTEXT = 600;
// Mail programs on Windows cut long mailto links; keep the whole link short.
const MAX_MAILTO_LENGTH = 1900;

function cleanText(value, limit) {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, limit);
}

/** Subject and body of the letter, with the computer details the main process knows. */
export function composeBugReport(input, system) {
  const description = cleanText(input?.description, MAX_DESCRIPTION);
  if (!description) throw new Error('bug-report-empty');
  const context = cleanText(input?.context, MAX_CONTEXT);
  const version = cleanText(system?.version, 40) || 'неизвестна';
  const firstLine = description.split('\n')[0].slice(0, 70);
  const subject = `Monarch ${version}: ${firstLine}`;
  const details = [
    `Версия Monarch: ${version}`,
    `Система: ${cleanText(system?.os, 80)}`,
    `Память: ${cleanText(system?.memory, 40)}`,
    context ? context : null,
  ].filter(Boolean).join('\n');
  const body = `${description}\n\n— Сведения о компьютере —\n${details}\n`;
  return { subject, body };
}

/** mailto: link for the mail program; the body is shortened to fit, never the subject. */
export function bugReportMailto(report) {
  const make = (body) => `mailto:${BUG_REPORT_ADDRESS}?subject=${encodeURIComponent(report.subject)}&body=${encodeURIComponent(body)}`;
  let body = report.body;
  let url = make(body);
  while (url.length > MAX_MAILTO_LENGTH && body.length > 40) {
    body = `${body.slice(0, Math.floor(body.length * 0.85))}…`;
    url = make(body);
  }
  return url;
}

/** Gmail compose page in the browser, for computers without a mail program. */
export function bugReportGmailUrl(report) {
  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: BUG_REPORT_ADDRESS,
    su: report.subject,
    body: report.body,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}
