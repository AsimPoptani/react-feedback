// A small donut progress ring in plain SVG: ticked items in the accent colour, claimed ones lighter, the rest the track.
const NS = 'http://www.w3.org/2000/svg';
const R = 7, C = 2 * Math.PI * R;

// "2 of 11 done, 1 claimed"; "No checklist items" when there are none.
export function donutLabel(c) {
  const total = c?.total || 0;
  if (!total) return 'No checklist items';
  return `${c.done || 0} of ${total} done${c.claimed ? `, ${c.claimed} claimed` : ''}`;
}
// Arc lengths (in px of circumference) for the done and done+claimed segments.
export function donutArcs(c) {
  const total = c?.total || 0;
  if (!total) return { done: 0, claimed: 0 };
  const done = Math.min(c.done || 0, total), claimed = Math.min(c.claimed || 0, total - done);
  return { done: (done / total) * C, claimed: ((done + claimed) / total) * C };
}
export function donutNode(c, size = 18) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 18 18'); svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'donut'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', donutLabel(c));
  const arcs = donutArcs(c);
  const ring = (cls, len) => {
    const o = document.createElementNS(NS, 'circle');
    o.setAttribute('class', cls); o.setAttribute('cx', '9'); o.setAttribute('cy', '9'); o.setAttribute('r', String(R)); o.setAttribute('fill', 'none'); o.setAttribute('stroke-width', '3.5');
    if (len !== null) { o.setAttribute('stroke-dasharray', `${len.toFixed(2)} ${C.toFixed(2)}`); o.setAttribute('transform', 'rotate(-90 9 9)'); }
    return o;
  };
  svg.append(ring('donut-track', null));
  if (arcs.claimed > arcs.done) svg.append(ring('donut-claimed', arcs.claimed));
  if (arcs.done > 0) svg.append(ring('donut-done', arcs.done));
  return svg;
}
