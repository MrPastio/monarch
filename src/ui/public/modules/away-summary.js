// "Пока тебя не было": when Monarch opens again, a short note about Security
// events recorded while the window was closed. The last-seen time is a
// per-device convenience in localStorage; the events come from Security itself.
import { executeCapability } from './api.js';
import { escapeHtml } from './utils.js';

const LAST_SEEN_KEY = 'monarch.lastSeenAt';
const MIN_AWAY_MS = 5 * 60_000;

function readLastSeen() {
  try { const value = Number(localStorage.getItem(LAST_SEEN_KEY)); return Number.isFinite(value) && value > 0 ? value : 0; } catch { return 0; }
}
function writeLastSeen(now = Date.now()) {
  try { localStorage.setItem(LAST_SEEN_KEY, String(now)); } catch { /* optional convenience */ }
}

export function summarizeAwayIncidents(incidents, since) {
  const recent = (Array.isArray(incidents) ? incidents : []).filter(incident => {
    const at = Date.parse(String(incident?.created_at || incident?.updated_at || ''));
    return Number.isFinite(at) && at > since;
  });
  return { total: recent.length, open: recent.filter(incident => incident.status === 'open').length };
}

export function renderAwaySummary(summary) {
  if (!summary.total) return '';
  const events = summary.total === 1 ? '1 событие' : summary.total < 5 ? `${summary.total} события` : `${summary.total} событий`;
  const open = summary.open ? ` · ждут решения: ${summary.open}` : ' · решений не нужно';
  return `<div class="away-summary-copy"><strong>Пока тебя не было</strong><span>Security записал ${escapeHtml(events)}${escapeHtml(open)}</span></div>
    <div class="away-summary-actions"><button type="button" class="claude-secondary-btn" data-away-open>Открыть Security</button><button type="button" class="claude-ghost-btn" data-away-close aria-label="Скрыть">Скрыть</button></div>`;
}

export function initAwaySummary({ openSecurity }) {
  const since = readLastSeen();
  writeLastSeen();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') writeLastSeen(); }, 60_000);
  document.addEventListener('visibilitychange', () => writeLastSeen());
  window.addEventListener('pagehide', () => { writeLastSeen(); clearInterval(timer); }, { once: true });
  if (!since || Date.now() - since < MIN_AWAY_MS) return;
  void (async () => {
    let incidents = [];
    try {
      const response = await executeCapability('security', 'security.incidents.list', { limit: 100 }, 'ui:security', false);
      const result = response?.result || response;
      incidents = result?.ok === false ? [] : result?.output?.payload?.incidents || [];
    } catch { return; }
    const html = renderAwaySummary(summarizeAwayIncidents(incidents, since));
    if (!html) return;
    const card = document.createElement('aside');
    card.className = 'away-summary'; card.setAttribute('role', 'status'); card.innerHTML = html;
    const close = () => { card.dataset.state = 'leaving'; card.addEventListener('animationend', () => card.remove(), { once: true }); setTimeout(() => card.remove(), 400); };
    card.querySelector('[data-away-close]')?.addEventListener('click', close);
    card.querySelector('[data-away-open]')?.addEventListener('click', () => { openSecurity(); close(); });
    document.body.append(card);
  })();
}
