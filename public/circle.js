// Circle of doom: the whole field on one lap, placed by timing gaps.
// No GPS needed — the leader's position comes from when they last crossed the line,
// everyone else sits behind them by their gap (in seconds) on a reference lap.

const W = 760, C = 380, R = 250;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = parseFloat(String(v ?? "").replace("+", "")); return Number.isFinite(n) ? n : null; };
const pt = (r, f) => { const a = f * 2 * Math.PI; return [C + r * Math.sin(a), C - r * Math.cos(a)]; };
const P = (r, f) => pt(r, f).map((v) => v.toFixed(1)).join(" ");
const wrap = (f) => ((f % 1) + 1) % 1;

// clockwise arc from fraction f0 to f1 (f1 may be < f0, we go the short way round)
function arc(r, f0, f1) {
  let a = wrap(f0), b = wrap(f1);
  if (b < a) [a, b] = [b, a];
  if (b - a > 0.5) [a, b] = [b, a + 1];
  return `M${P(r, a)} A${r} ${r} 0 ${b - a > 0.5 ? 1 : 0} 1 ${P(r, b)}`;
}
function band(f0, f1, inner, outer) {
  let a = wrap(f0), b = wrap(f1);
  if (b < a) [a, b] = [b, a];
  if (b - a > 0.5) [a, b] = [b, a + 1];
  return `M${P(outer, a)} A${outer} ${outer} 0 0 1 ${P(outer, b)} L${P(inner, b)} A${inner} ${inner} 0 0 0 ${P(inner, a)} Z`;
}
const fmtLap = (s) => { if (!s) return "—"; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };

export function computeCircle(v, sel, pitLoss) {
  const rows = v.rows.filter((r) => r.pos < 99 && !r.out);
  if (!rows.length) return null;
  const ref = v.refLap || 100;

  // gap to leader = running total of intervals (works for lapped cars too)
  let total = 0;
  const cars = rows.map((r, i) => {
    if (i > 0) {
      const iv = num(r.int);
      const g = num(r.gap);
      total = iv != null ? total + iv : g != null ? g : total + 1;
    }
    return { ...r, g: total };
  });

  const leader = cars[0];
  let leaderFrac = 0;
  const calibrated = !!leader.lapStart;
  if (calibrated) leaderFrac = Math.min(0.999, Math.max(0, (v.now - leader.lapStart) / 1000 / ref));
  for (const c of cars) c.f = wrap(leaderFrac - c.g / ref);

  const selCar = cars.find((c) => c.n === sel) ?? null;
  const caution = ["4", "6", "7"].includes(v.track.code);
  let pit = null;
  if (selCar) {
    const loss = caution ? pitLoss * 0.55 : pitLoss;
    const rejoin = selCar.g + loss;
    const ahead = cars.filter((c) => c !== selCar && c.g < rejoin).sort((a, b) => b.g - a.g)[0];
    const behind = cars.filter((c) => c !== selCar && c.g >= rejoin).sort((a, b) => a.g - b.g)[0];
    pit = {
      loss, caution,
      pos: 1 + cars.filter((c) => c !== selCar && c.g < rejoin).length,
      ahead: ahead ? { tla: ahead.tla, by: rejoin - ahead.g } : null,
      behind: behind ? { tla: behind.tla, by: behind.g - rejoin } : null,
      f0: wrap(leaderFrac - (rejoin - 1.5) / ref),
      f1: wrap(leaderFrac - (rejoin + 1.5) / ref),
    };
  }
  return { cars, leaderFrac, calibrated, ref, selCar, pit };
}

export function renderCircle(v, sel, pitLoss) {
  const m = computeCircle(v, sel, pitLoss);
  if (!m) return `<div class="muted empty">Waiting for timing data…</div>`;
  const { cars, selCar, pit } = m;

  // sector + minisector ticks, using the leader's segment counts
  const segCounts = (cars[0].sectors ?? []).map((s) => s.seg.length || 0);
  const N = segCounts.reduce((a, b) => a + b, 0);
  let ticks = "", sectorTicks = "", sectorLabels = "";
  if (N) {
    for (let k = 0; k < N; k++) { const f = k / N; ticks += `M${P(R - 6, f)} L${P(R + 6, f)} `; }
    let acc = 0;
    segCounts.forEach((n, i) => {
      const f = acc / N;
      sectorTicks += `M${P(R - 14, f)} L${P(R + 14, f)} `;
      const [x, y] = pt(R - 34, (acc + n / 2) / N);
      sectorLabels += `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" class="c-sector">S${i + 1}</text>`;
      acc += n;
    });
  }

  // battles: consecutive cars under a second, neither in the pits
  let battles = "";
  for (let i = 1; i < cars.length; i++) {
    const a = cars[i - 1], b = cars[i], iv = num(b.int);
    if (iv != null && iv < 1 && !a.inPit && !b.inPit) battles += arc(R, a.f, b.f) + " ";
  }

  // labels: spread around so they never overlap, with a leader line back to the dot
  const LAB_R = 318;
  const minSep = Math.min(0.034, 0.85 / Math.max(cars.length, 1));
  const order = cars.map((c, i) => ({ i, l: c.f })).sort((a, b) => a.l - b.l);
  for (let pass = 0; pass < 80; pass++) {
    for (let k = 1; k < order.length; k++) {
      const gap = order[k].l - order[k - 1].l;
      if (gap < minSep) { const push = (minSep - gap) / 2; order[k].l += push; order[k - 1].l -= push; }
    }
  }
  const labF = {};
  order.forEach((o) => { labF[o.i] = o.l; });

  let leaders = "", dots = "", labels = "";
  cars.forEach((c, i) => {
    const r = c.inPit ? R - 58 : R;
    const [x, y] = pt(r, c.f);
    const [lx, ly] = pt(LAB_R, labF[i]);
    const [ex, ey] = pt(LAB_R - 24, labF[i]);
    const isSel = selCar && c.n === selCar.n;
    leaders += `M${P(r + 9, c.f)} L${ex.toFixed(1)} ${ey.toFixed(1)} `;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isSel ? 12 : 8}" fill="${esc(c.colour)}" stroke="${isSel ? "#FFB547" : "#13161D"}" stroke-width="${isSel ? 4 : 2}" class="hit" data-n="${esc(c.n)}"><title>${esc(c.name)}</title></circle>`;
    const gapText = selCar
      ? (isSel ? "REF" : `${c.g - selCar.g > 0 ? "+" : "−"}${Math.abs(c.g - selCar.g).toFixed(1)}`)
      : (i === 0 ? "LEADER" : `+${c.g.toFixed(1)}`);
    labels += `<g class="hit" data-n="${esc(c.n)}" transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)})">
      <rect x="-30" y="-17" width="60" height="34" rx="6" fill="#0B0D12" stroke="${isSel ? "#FFB547" : "#262B36"}"></rect>
      <rect x="-30" y="-17" width="60" height="3" rx="1.5" fill="${esc(c.colour)}"></rect>
      <text y="1" class="c-tla">${esc(c.tla)}${c.inPit ? "·PIT" : ""}</text>
      <text y="13" class="c-gap">${gapText}</text>
    </g>`;
  });

  let pitBand = "", trail = "", centre = "";
  if (pit) {
    pitBand = `<path d="${band(pit.f0, pit.f1, R - 16, R + 16)}" class="${pit.caution ? "c-band-sc" : "c-band"}"></path>`;
    trail = `<path d="${arc(R - 30, selCar.f, (pit.f0 + pit.f1) / 2)}" class="c-trail"></path>`;
    const near = [pit.ahead ? `${pit.ahead.by.toFixed(1)}s behind ${esc(pit.ahead.tla)}` : "", pit.behind ? `${pit.behind.by.toFixed(1)}s ahead of ${esc(pit.behind.tla)}` : ""].filter(Boolean).join(" · ");
    centre = `<text x="${C}" y="${C + 46}" class="c-call">If ${esc(selCar.tla)} pits now → P${pit.pos}</text>
      <text x="${C}" y="${C + 68}" class="c-sub">${near}</text>
      <text x="${C}" y="${C + 88}" class="c-sub">pit stop costs ~${pit.loss.toFixed(0)}s${pit.caution ? " under caution" : ""}</text>`;
  } else {
    centre = `<text x="${C}" y="${C + 50}" class="c-sub">Tap a car to see where it would rejoin after a pit stop</text>`;
  }

  const pitLane = `M${P(R, 0.955)} L${P(R - 58, 0.97)} A${R - 58} ${R - 58} 0 0 1 ${P(R - 58, 1.03)} L${P(R, 1.045)}`;
  const flagX = C - 12, flagY = C - R - 24;
  return `<svg viewBox="0 0 ${W} ${W}" class="circle-svg" role="img" aria-label="Every car placed around one lap by its timing gap">
    <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="#262B36" stroke-width="4"></circle>
    ${pitBand}
    <path d="${ticks}" stroke="#2E3340" stroke-width="2"></path>
    <path d="${sectorTicks}" stroke="#C3C9D4" stroke-width="3"></path>
    ${sectorLabels}
    <path d="${pitLane}" fill="none" stroke="#3A4050" stroke-width="2"></path>
    <text x="${C}" y="${C - R + 82}" class="c-sub">pit lane</text>
    <path d="${battles}" fill="none" stroke="#FF6B6B" stroke-width="7" stroke-linecap="round" opacity="0.85"></path>
    ${trail}
    <path d="${leaders}" fill="none" stroke="#3A4050" stroke-width="1"></path>
    <g>
      <rect x="${flagX}" y="${flagY}" width="24" height="12" fill="#E8EAF0"></rect>
      <rect x="${flagX}" y="${flagY}" width="6" height="6" fill="#0B0D12"></rect><rect x="${flagX + 12}" y="${flagY}" width="6" height="6" fill="#0B0D12"></rect>
      <rect x="${flagX + 6}" y="${flagY + 6}" width="6" height="6" fill="#0B0D12"></rect><rect x="${flagX + 18}" y="${flagY + 6}" width="6" height="6" fill="#0B0D12"></rect>
    </g>
    <text x="${C}" y="${C - 22}" class="c-lap">${v.totalLaps ? `${v.lap}/${v.totalLaps}` : ""}</text>
    <text x="${C}" y="${C + 6}" class="c-sub">${esc(v.track.label)} · reference lap ${fmtLap(m.ref)}</text>
    ${m.calibrated ? "" : `<text x="${C}" y="${C + 24}" class="c-sub">Placing cars once the leader next crosses the line…</text>`}
    ${centre}
    ${dots}
    ${labels}
  </svg>`;
}
