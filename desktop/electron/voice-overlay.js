/* PaperPixel: the orb becomes a ring of pixels with spring physics. The phase
   decides the motion — listening turns slowly, thinking scatters and gathers,
   speaking ripples, a result collapses into a tick, an error lets them fall. */
const pixelRing = (() => {
  const host = document.querySelector('.voice-orb');
  const canvas = document.createElement('canvas');
  canvas.className = 'voice-pixels';
  canvas.setAttribute('aria-hidden', 'true');
  host?.append(canvas);
  const S = 112, C = S / 2, N = 14, R = 34, SIZE = 8;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = S * dpr; canvas.height = S * dpr;
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const tick = [[0, 3], [1, 4], [2, 5], [3, 4], [4, 3], [5, 2], [6, 1]];
  const px = Array.from({ length: N }, (_, i) => {
    const a = i / N * Math.PI * 2;
    return { x: C + Math.cos(a) * R, y: C + Math.sin(a) * R, vx: 0, vy: 0, a: 0, va: 0, tx: 0, ty: 0, ta: 0 };
  });
  let phase = 'off', t = 0, spin = 0, raf = 0, last = 0, fallen = false;
  const qd = (a, b) => { let d = (a - b) % 90; if (d > 45) d -= 90; if (d < -45) d += 90; return d; };
  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = getComputedStyle(canvas).color;
    for (const p of px) {
      const r = SIZE * 0.28, h = SIZE / 2;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a * Math.PI / 180);
      ctx.beginPath(); ctx.moveTo(-h + r, -h);
      ctx.arcTo(h, -h, h, h, r); ctx.arcTo(h, h, -h, h, r); ctx.arcTo(-h, h, -h, -h, r); ctx.arcTo(-h, -h, h, -h, r);
      ctx.closePath(); ctx.fill(); ctx.restore();
    }
  }
  function step(now) {
    const dt = Math.min(0.033, (now - last) / 1000 || 0); last = now; t += dt;
    const k = phase === 'thinking' || phase === 'recognizing' || phase === 'routing' ? 420 : 300, c = 26;
    const speed = phase === 'listening' ? 60 : phase === 'speaking' ? 140 : phase === 'idle' ? 0 : 260;
    spin += speed * dt;
    const scatter = (phase === 'thinking' || phase === 'recognizing' || phase === 'routing') && (t % 2.4) > 1.5;
    px.forEach((p, i) => {
      if (phase === 'error') {
        if (!fallen) { p.vx = (Math.random() - 0.5) * 120; p.vy = -80 - Math.random() * 80; p.va = (Math.random() - 0.5) * 900; }
        p.vy += 1600 * dt; p.x += p.vx * dt; p.y = Math.min(S - SIZE, p.y + p.vy * dt); if (p.y >= S - SIZE) { p.vy *= -0.3; p.vx *= 0.8; p.va *= 0.8; }
        p.a += p.va * dt; return;
      }
      if (phase === 'result') {
        const [gx, gy] = tick[i % tick.length], g = 8.5;
        p.tx = C + (gx - 3) * g; p.ty = C + (gy - 3) * g; p.ta = 0;
      } else if (scatter) {
        if (Math.random() < dt * 4) { p.tx = 10 + Math.random() * (S - 20); p.ty = 10 + Math.random() * (S - 20); p.ta = Math.random() * 90; }
      } else {
        const deg = spin + i * 360 / N, a = deg * Math.PI / 180;
        const wave = phase === 'speaking' ? Math.sin(t * 9 + i * 0.9) * 4 : 0;
        p.tx = C + Math.cos(a) * (R + wave); p.ty = C + Math.sin(a) * (R + wave); p.ta = deg;
      }
      const kk = scatter ? 90 : k, cc = scatter ? 10 : c;
      p.vx += (-kk * (p.x - p.tx) - cc * p.vx) * dt; p.vy += (-kk * (p.y - p.ty) - cc * p.vy) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.va += (-kk * qd(p.a, p.ta) - cc * p.va) * dt; p.a += p.va * dt;
    });
    fallen = phase === 'error';
    draw();
    const still = phase === 'idle' || phase === 'result' || phase === 'error';
    const energy = px.reduce((e, p) => e + Math.abs(p.vx) + Math.abs(p.vy), 0);
    raf = still && energy < 1 && t > 0.6 ? 0 : requestAnimationFrame(step);
  }
  return {
    setPhase(next) {
      const value = String(next || 'idle');
      if (value === phase) return;
      phase = value; t = 0;
      if (phase !== 'error') fallen = false;
      if (phase === 'off') { cancelAnimationFrame(raf); raf = 0; return; }
      if (reduced?.matches) {
        px.forEach((p, i) => { const a = i / N * Math.PI * 2; p.x = C + Math.cos(a) * R; p.y = C + Math.sin(a) * R; p.a = a * 180 / Math.PI; });
        draw(); return;
      }
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
    },
  };
})();

const kicker = document.querySelector('#voice-kicker');
const title = document.querySelector('#voice-title');
const text = document.querySelector('#voice-text');
const dataCard = document.querySelector('#voice-data-card');
const cardPrimary = document.querySelector('#voice-card-primary');
const cardSummary = document.querySelector('#voice-card-summary');
const cardMetrics = document.querySelector('#voice-card-metrics');
const cardAttribution = document.querySelector('#voice-card-attribution');

window.monarchVoiceOverlay?.onState?.((value = {}) => {
  const phase = String(value.phase || 'idle').replace(/[^a-z-]/g, '').slice(0, 32) || 'idle';
  const message = String(
    phase === 'error' ? value.detail || value.text || '' : value.text || value.detail || '',
  ).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 360);
  document.body.dataset.phase = phase;
  document.body.dataset.design = value.design === 'classic' ? 'classic' : 'pp';
  document.body.dataset.theme = value.theme === 'dark' ? 'dark' : 'light';
  pixelRing.setPhase(document.body.dataset.design === 'pp' ? phase : 'off');
  document.body.dataset.card = ['result', 'error'].includes(phase) || message ? 'visible' : 'hidden';
  kicker.textContent = String(value.kicker || 'Оскар').trim().slice(0, 80);
  title.textContent = String(value.title || phaseLabel(phase)).trim().slice(0, 120);
  text.textContent = message;
  renderDataCard(value.card);
});

function renderDataCard(value) {
  const card = value && typeof value === 'object' && ['weather', 'exchange-rate'].includes(value.kind)
    ? value
    : null;
  dataCard.hidden = !card;
  if (!card) {
    cardMetrics.replaceChildren();
    return;
  }
  document.body.dataset.cardKind = card.kind;
  cardPrimary.textContent = String(card.primary || '').slice(0, 80);
  cardSummary.textContent = String(card.summary || '').slice(0, 160);
  cardAttribution.textContent = String(card.attribution || '').slice(0, 120);
  cardMetrics.replaceChildren();
  (Array.isArray(card.metrics) ? card.metrics : []).slice(0, 3).forEach((metric) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = String(metric.label || '').slice(0, 40);
    description.textContent = String(metric.value || '').slice(0, 60);
    row.append(term, description);
    cardMetrics.append(row);
  });
}

function phaseLabel(phase) {
  if (phase === 'listening') return 'Слушаю';
  if (phase === 'recognizing') return 'Распознаю';
  if (phase === 'routing') return 'Сверяю команду';
  if (phase === 'thinking') return 'Выполняю';
  if (phase === 'speaking') return 'Отвечаю';
  if (phase === 'error') return 'Не получилось';
  return 'Оскар рядом';
}
