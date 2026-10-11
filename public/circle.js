// Circle of doom: the whole field on one lap, placed by timing gaps.
// No GPS needed — the leader's position comes from when they last crossed the line,
// everyone else sits behind them by their gap (in seconds) on a reference lap.
//
// Performance: the ring is drawn once. Each frame only moves the existing car elements
// (no rebuilding), and cars glide between timing updates instead of jumping.

const W = 760, C = 380, R = 250, LAB_R = 318;
const SVGNS = "http://www.w3.org/2000/svg";
const num = (v) => { const n = parseFloat(String(v ?? "").replace("+", "")); return Number.isFinite(n) ? n : null; };
const pt = (r, f) => { const a = f * 2 * Math.PI; return [C + r * Math.sin(a), C - r * Math.cos(a)]; };
const P = (r, f) => pt(r, f).map((v) => v.toFixed(1)).join(" ");
const wrap = (f) => ((f % 1) + 1) % 1;
const fmtLap = (s) => { if (!s) return "—"; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };

function span(f0, f1) {
  let a = wrap(f0), b = wrap(f1);
  if (b < a) [a, b] = [b, a];
  if (b - a > 0.5) [a, b] = [b, a + 1];
  return [a, b];
}
const arc = (r, f0, f1) => { const [a, b] = span(f0, f1); return `M${P(r, a)} A${r} ${r} 0 ${b - a > 0.5 ? 1 : 0} 1 ${P(r, b)}`; };
const band = (f0, f1, ri, ro) => { const [a, b] = span(f0, f1); return `M${P(ro, a)} A${ro} ${ro} 0 0 1 ${P(ro, b)} L${P(ri, b)} A${ri} ${ri} 0 0 0 ${P(ri, a)} Z`; };

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// Gaps to the leader (running total of intervals, so lapped cars work too) and the pit call.
export function computeModel(v, sel, pitLoss) {
  const rows = v.rows.filter((r) => r.pos < 99 && !r.out);
  if (!rows.length) return null;
  let total = 0;
  const cars = rows.map((r, i) => {
    if (i > 0) {
      const iv = num(r.int), g = num(r.gap);
      total = iv != null ? total + iv : g != null ? g : total + 1;
    }
    return { n: r.n, tla: r.tla, name: r.name, colour: r.colour, inPit: r.inPit, int: num(r.int), g: total, lapStart: r.lapStart };
  });
  const selCar = cars.find((c) => c.n === sel) ?? null;
  const caution = ["4", "6", "7"].includes(v.track.code);
  let pit = null;
  if (selCar) {
    const loss = caution ? pitLoss * 0.55 : pitLoss;
    const rejoin = selCar.g + loss;
    const others = cars.filter((c) => c !== selCar);
    const ahead = others.filter((c) => c.g < rejoin).sort((a, b) => b.g - a.g)[0];
    const behind = others.filter((c) => c.g >= rejoin).sort((a, b) => a.g - b.g)[0];
    pit = { loss, caution, rejoin, pos: 1 + others.filter((c) => c.g < rejoin).length,
      ahead: ahead ? { tla: ahead.tla, by: rejoin - ahead.g } : null,
      behind: behind ? { tla: behind.tla, by: behind.g - rejoin } : null };
  }
  // Where is the leader right now? Minisectors fill in as a car goes round the lap
  // (they reset at the line), so the share already completed is the leader's progress.
  const leaderRow = v.rows.find((r) => r.n === cars[0].n);
  let segDone = 0, segTotal = 0, stillGoing = true;
  for (const sec of leaderRow?.sectors ?? []) {
    for (const st of sec.seg) {
      segTotal++;
      if (stillGoing && st && st !== 0) segDone++;
      else stillGoing = false;
    }
  }
  const segFrac = segTotal ? segDone / segTotal : null;
  return { cars, selCar, pit, caution, ref: v.refLap || 100, segFrac };
}

export class CircleView {
  constructor(container, onPick) {
    this.box = container;
    this.onPick = onPick;
    this.items = new Map();      // driver -> { dot, label, gapText, tlaText, rects… }
    this.shown = {};             // driver -> eased gap actually drawn
    this.model = null;
    this.segKey = "";
    this.running = false;
    this.lastFrame = 0;
    this.build();
    this.box.addEventListener("click", (e) => {
      const hit = e.target.closest("[data-n]");
      if (hit) this.onPick(hit.dataset.n);
    });
  }

  build() {
    this.box.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${W} ${W}`, class: "circle-svg", role: "img", "aria-label": "Every car placed around one lap by its timing gap" });
    this.svg = svg;
    el("circle", { cx: C, cy: C, r: R, fill: "none", stroke: "#262B36", "stroke-width": 4 }, svg);
    this.bandPath = el("path", { class: "c-band" }, svg);
    this.ticks = el("path", { stroke: "#2E3340", "stroke-width": 2 }, svg);
    this.sectorTicks = el("path", { stroke: "#C3C9D4", "stroke-width": 3 }, svg);
    this.sectorLabels = el("g", {}, svg);
    el("path", { d: `M${P(R, 0.955)} L${P(R - 58, 0.97)} A${R - 58} ${R - 58} 0 0 1 ${P(R - 58, 1.03)} L${P(R, 1.045)}`, fill: "none", stroke: "#3A4050", "stroke-width": 2 }, svg);
    el("text", { x: C, y: C - R + 82, class: "c-sub" }, svg).textContent = "pit lane";
    this.battles = el("path", { fill: "none", stroke: "#FF6B6B", "stroke-width": 7, "stroke-linecap": "round", opacity: 0.85 }, svg);
    this.trail = el("path", { class: "c-trail" }, svg);
    this.leaders = el("path", { fill: "none", stroke: "#3A4050", "stroke-width": 1 }, svg);
    const fx = C - 12, fy = C - R - 24;
    el("rect", { x: fx, y: fy, width: 24, height: 12, fill: "#E8EAF0" }, svg);
    for (const [dx, dy] of [[0, 0], [12, 0], [6, 6], [18, 6]]) el("rect", { x: fx + dx, y: fy + dy, width: 6, height: 6, fill: "#0B0D12" }, svg);
    this.lapText = el("text", { x: C, y: C - 22, class: "c-lap" }, svg);
    this.subText = el("text", { x: C, y: C + 6, class: "c-sub" }, svg);
    this.calText = el("text", { x: C, y: C + 24, class: "c-sub" }, svg);
    this.callText = el("text", { x: C, y: C + 50, class: "c-call" }, svg);
    this.nearText = el("text", { x: C, y: C + 72, class: "c-sub" }, svg);
    this.lossText = el("text", { x: C, y: C + 92, class: "c-sub" }, svg);
    this.debug = new URLSearchParams(location.search).has("debug") ? el("text", { x: 12, y: 20, class: "c-debug" }, svg) : null;
    this.dotLayer = el("g", {}, svg);
    this.labelLayer = el("g", {}, svg);
    this.box.appendChild(svg);
  }

  // Called whenever new timing arrives (about twice a second).
  setData(v, sel, pitLoss, nowFn) {
    this.v = v;
    this.nowFn = nowFn;
    this.model = computeModel(v, sel, pitLoss);
    if (!this.model) return;
    const m = this.model;

    // static ring decorations: only rebuild when the minisector layout changes
    const leaderRow = v.rows.find((r) => r.n === m.cars[0].n);
    const counts = (leaderRow?.sectors ?? []).map((s) => s.seg.length || 0);
    const key = counts.join(",");
    if (key !== this.segKey) {
      this.segKey = key;
      const N = counts.reduce((a, b) => a + b, 0);
      let ticks = "", sTicks = "";
      this.sectorLabels.innerHTML = "";
      if (N) {
        for (let k = 0; k < N; k++) ticks += `M${P(R - 6, k / N)} L${P(R + 6, k / N)} `;
        let acc = 0;
        counts.forEach((n, i) => {
          sTicks += `M${P(R - 14, acc / N)} L${P(R + 14, acc / N)} `;
          const [x, y] = pt(R - 34, (acc + n / 2) / N);
          el("text", { x: x.toFixed(0), y: y.toFixed(0), class: "c-sector" }, this.sectorLabels).textContent = `S${i + 1}`;
          acc += n;
        });
      }
      this.ticks.setAttribute("d", ticks);
      this.sectorTicks.setAttribute("d", sTicks);
    }

    // create / remove car elements to match the field
    const present = new Set(m.cars.map((c) => c.n));
    for (const [n, it] of this.items) if (!present.has(n)) { it.dot.remove(); it.label.remove(); this.items.delete(n); delete this.shown[n]; }
    for (const c of m.cars) {
      if (this.items.has(c.n)) continue;
      const dot = el("circle", { r: 8, class: "hit", "data-n": c.n }, this.dotLayer);
      el("title", {}, dot).textContent = c.name;
      const label = el("g", { class: "hit", "data-n": c.n }, this.labelLayer);
      const box = el("rect", { x: -30, y: -17, width: 60, height: 34, rx: 6, fill: "#0B0D12" }, label);
      const stripe = el("rect", { x: -30, y: -17, width: 60, height: 3, rx: 1.5 }, label);
      const tla = el("text", { y: 1, class: "c-tla" }, label);
      const gap = el("text", { y: 13, class: "c-gap" }, label);
      this.items.set(c.n, { dot, label, box, stripe, tla, gap });
    }

    // text that only changes with new data
    const selCar = m.selCar;
    m.cars.forEach((c, i) => {
      const it = this.items.get(c.n);
      const isSel = selCar && c.n === selCar.n;
      it.dot.setAttribute("fill", c.colour);
      it.dot.setAttribute("r", isSel ? 12 : 8);
      it.dot.setAttribute("stroke", isSel ? "#FFB547" : "#13161D");
      it.dot.setAttribute("stroke-width", isSel ? 4 : 2);
      it.stripe.setAttribute("fill", c.colour);
      it.box.setAttribute("stroke", isSel ? "#FFB547" : "#262B36");
      it.tla.textContent = c.tla + (c.inPit ? "·PIT" : "");
      it.gap.textContent = selCar
        ? (isSel ? "REF" : `${c.g - selCar.g > 0 ? "+" : "−"}${Math.abs(c.g - selCar.g).toFixed(1)}`)
        : (i === 0 ? "LEADER" : `+${c.g.toFixed(1)}`);
      if (this.shown[c.n] == null) this.shown[c.n] = c.g;
    });

    // Until we've seen the leader cross the line, estimate their lap start from minisectors.
    const leader = m.cars[0];
    if (leader.lapStart) this.est = null;
    else if (m.segFrac != null && (!this.est || this.est.n !== leader.n || this.est.seg !== m.segFrac)) {
      const guess = nowFn() - m.segFrac * m.ref * 1000;
      // keep the running estimate unless the minisectors say we're more than a few seconds off
      if (!this.est || this.est.n !== leader.n || Math.abs(this.est.start - guess) > 4000) this.est = { n: leader.n, start: guess, seg: m.segFrac };
      else this.est.seg = m.segFrac;
    }

    this.lapText.textContent = v.totalLaps ? `${v.lap}/${v.totalLaps}` : "";
    this.subText.textContent = `${v.track.label} · reference lap ${fmtLap(m.ref)}`;
    this.calText.textContent = m.cars[0].lapStart || this.est ? "" : "Placing cars once the leader next crosses the line…";
    if (m.pit) {
      const p = m.pit;
      this.callText.textContent = `If ${selCar.tla} pits now → P${p.pos}`;
      this.nearText.textContent = [p.ahead ? `${p.ahead.by.toFixed(1)}s behind ${p.ahead.tla}` : "", p.behind ? `${p.behind.by.toFixed(1)}s ahead of ${p.behind.tla}` : ""].filter(Boolean).join(" · ");
      this.lossText.textContent = `pit stop costs ~${p.loss.toFixed(0)}s${p.caution ? " under caution" : ""}`;
      this.bandPath.setAttribute("class", p.caution ? "c-band-sc" : "c-band");
    } else {
      this.callText.textContent = "";
      this.nearText.textContent = "Tap a car to see where it would rejoin after a pit stop";
      this.lossText.textContent = "";
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (t) => {
      if (!this.running) return;
      if (t - this.lastFrame > 45) { this.lastFrame = t; this.frame(); } // ~20 fps is plenty
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }

  frame() {
    const m = this.model;
    if (!m) return;
    const now = this.nowFn();
    const leader = m.cars[0];
    const start = leader.lapStart ?? (this.est?.n === leader.n ? this.est.start : null);
    const lf = start ? Math.min(0.999, Math.max(0, (now - start) / 1000 / m.ref)) : 0;

    // ease drawn gaps towards the latest timing so cars glide instead of jumping
    const pos = m.cars.map((c) => {
      const s = this.shown[c.n] ?? c.g;
      const next = Math.abs(c.g - s) > 20 ? c.g : s + (c.g - s) * 0.18;
      this.shown[c.n] = next;
      return { c, f: wrap(lf - next / m.ref) };
    });

    // spread labels so they never overlap
    const minSep = Math.min(0.034, 0.85 / Math.max(pos.length, 1));
    const order = pos.map((p, i) => ({ i, l: p.f })).sort((a, b) => a.l - b.l);
    for (let pass = 0; pass < 30; pass++) {
      let moved = false;
      for (let k = 1; k < order.length; k++) {
        const gap = order[k].l - order[k - 1].l;
        if (gap < minSep) { const push = (minSep - gap) / 2; order[k].l += push; order[k - 1].l -= push; moved = true; }
      }
      if (!moved) break;
    }
    const labF = new Array(pos.length);
    for (const o of order) labF[o.i] = o.l;

    let leaders = "", battles = "";
    pos.forEach(({ c, f }, i) => {
      const it = this.items.get(c.n);
      const r = c.inPit ? R - 58 : R;
      const [x, y] = pt(r, f);
      it.dot.setAttribute("cx", x.toFixed(1));
      it.dot.setAttribute("cy", y.toFixed(1));
      const [lx, ly] = pt(LAB_R, labF[i]);
      it.label.setAttribute("transform", `translate(${lx.toFixed(1)} ${ly.toFixed(1)})`);
      const [ex, ey] = pt(LAB_R - 24, labF[i]);
      leaders += `M${P(r + 9, f)} L${ex.toFixed(1)} ${ey.toFixed(1)} `;
      if (i > 0 && c.int != null && c.int < 1 && !c.inPit && !pos[i - 1].c.inPit) battles += arc(R, pos[i - 1].f, f) + " ";
    });
    this.leaders.setAttribute("d", leaders);
    if (this.debug) {
      const age = start ? ((now - start) / 1000).toFixed(1) : "—";
      this.debug.textContent = `leader ${leader.tla} · ${leader.lapStart ? "line seen" : this.est ? "estimated" : "unknown"} · ${age}s into lap · ref ${m.ref.toFixed(1)}s · progress ${(lf * 100).toFixed(0)}% · minisectors ${m.segFrac == null ? "—" : (m.segFrac * 100).toFixed(0) + "%"}`;
    }
    this.battles.setAttribute("d", battles);

    if (m.pit && m.selCar) {
      const sf = pos.find((p) => p.c === m.selCar)?.f ?? 0;
      const f0 = wrap(lf - (m.pit.rejoin - 1.5) / m.ref), f1 = wrap(lf - (m.pit.rejoin + 1.5) / m.ref);
      this.bandPath.setAttribute("d", band(f0, f1, R - 16, R + 16));
      this.trail.setAttribute("d", arc(R - 30, sf, wrap(lf - m.pit.rejoin / m.ref)));
    } else {
      this.bandPath.setAttribute("d", "");
      this.trail.setAttribute("d", "");
    }
  }
}
