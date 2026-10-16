// The Monarch mark: two equal bands mirrored about the axis, every vertex on a
// grid of u = 1/26 of the height (W 49u, H 26u, slope 17u : 26u, shared base
// 15u). The left band is an inner contour; the right one is glass laid on top,
// so the contour does not show through it. Colours come from the theme tokens
// (--mark-*), stroke widths are in screen pixels so small marks stay crisp.

export const MARK_LEFT_BAND = 'M0 0H15L32 26H17Z';
export const MARK_RIGHT_BAND = 'M34 0H49L32 26H17Z';
/** Unit vectors along each band's long edge, pointing down its slope. */
export const MARK_LEFT_DIRECTION = Object.freeze({ x: 17 / Math.hypot(17, 26), y: 26 / Math.hypot(17, 26) });
export const MARK_RIGHT_DIRECTION = Object.freeze({ x: -17 / Math.hypot(17, 26), y: 26 / Math.hypot(17, 26) });

let sequence = 0;

/** Inline SVG markup of the mark. `sheen` adds the light strip the intro moves across the glass. */
export function monarchMarkSvg({ className = '', sheen = false, title = '' } = {}) {
  const id = `monarch-mark-${++sequence}`;
  const label = title ? `<title>${title.replace(/[<&>"]/gu, '')}</title>` : '';
  return `<svg class="monarch-mark ${className}" viewBox="0 0 49 26" ${title ? 'role="img"' : 'aria-hidden="true"'} focusable="false">${label}
  <defs>
    <clipPath id="${id}-l"><path d="${MARK_LEFT_BAND}"/></clipPath>
    <clipPath id="${id}-r"><path d="${MARK_RIGHT_BAND}"/></clipPath>
    <linearGradient id="${id}-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--mark-glass-a)"/><stop offset="1" style="stop-color:var(--mark-glass-b)"/>
    </linearGradient>${sheen ? `
    <linearGradient id="${id}-s" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" style="stop-color:var(--mark-sheen);stop-opacity:0"/>
      <stop offset=".5" style="stop-color:var(--mark-sheen);stop-opacity:.75"/>
      <stop offset="1" style="stop-color:var(--mark-sheen);stop-opacity:0"/>
    </linearGradient>` : ''}
  </defs>
  <g class="monarch-mark-line" data-mark="line">
    <path d="${MARK_LEFT_BAND}" clip-path="url(#${id}-l)" class="monarch-mark-contour" vector-effect="non-scaling-stroke"/>
  </g>
  <g class="monarch-mark-glass" data-mark="glass">
    <path d="${MARK_RIGHT_BAND}" style="fill:url(#${id}-g)"/>
    <path d="${MARK_RIGHT_BAND}" clip-path="url(#${id}-r)" class="monarch-mark-edge" vector-effect="non-scaling-stroke"/>${sheen ? `
    <g clip-path="url(#${id}-r)"><rect data-mark="sheen" x="-12" y="-4" width="9" height="34" style="fill:url(#${id}-s)" opacity="0"/></g>` : ''}
  </g>
</svg>`;
}

/** Fills every `[data-monarch-mark]` placeholder once. */
export function mountMonarchMarks(root = document) {
  for (const host of root.querySelectorAll('[data-monarch-mark]:not([data-mark-mounted])')) {
    host.innerHTML = monarchMarkSvg({ className: host.dataset.monarchMark || '' });
    host.dataset.markMounted = 'true';
  }
}
