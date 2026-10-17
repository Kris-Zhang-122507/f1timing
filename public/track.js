// Track map: the real circuit shape, with every car placed along it using the same
// timing-based positions as the circle of doom (so it works live, with no GPS feed).
const SVGNS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export const circuitSlug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const cache = {};
// the circuit file: { points, corners?: [{ n, l, p: [x, y] }], marshal?: [{ n, p }] }
export async function loadTrackInfo(circuit) {
  const slug = circuitSlug(circuit);
  if (!slug) return null;
  if (!(slug in cache)) cache[slug] = fetch(`data/tracks/${slug}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return cache[slug];
}
export async function loadTrack(circuit) { return (await loadTrackInfo(circuit))?.points ?? null; }

// Real car positions for an archived race (data/positions/<key>.json), if the archive has them.
const gpsCache = {};
export async function loadGps(key) {
  if (!key) return null;
  if (key in gpsCache) return gpsCache[key];
  gpsCache[key] = null;
  try { const r = await fetch(`data/positions/${key}.json`); gpsCache[key] = r.ok ? await r.json() : null; } catch { /* timing-based instead */ }
  return gpsCache[key];
}

export class TrackView {
  constructor(box, circle, onPick) {
    this.box = box;
    this.circle = circle; // CircleView: we reuse its per-car lap positions
    this.onPick = onPick;
    this.items = new Map();
    this.running = false;
    this.box.addEventListener("click", (e) => { const hit = e.target.closest("[data-n]"); if (hit) this.onPick(hit.dataset.n); });
  }

  // gps: { t0, step, outline, cars: { n: [x0, y0, x1, y1, …] } } and nowFn gives the replay clock
  setGps(gps, nowFn) {
    this.nowFn = nowFn;
    if (gps === this.gps) return;
    this.gps = gps;
    if (gps?.outline) this.setPoints(gps.outline, true);
    else if (this.usingGps) { this.points = null; this.usingGps = false; }
  }

  setPoints(points, fromGps = false) {
    if (this.gps?.outline && !fromGps) return; // real positions win over the generic outline
    if (points === this.points) return;
    this.usingGps = fromGps;
    this.points = points;
    this.bbox = null;
    this.items.clear();
    this.box.innerHTML = "";
    if (!points) { this.box.innerHTML = `<div class="muted empty">The track map appears once a session at this circuit has been archived (about an hour after it ends).</div>`; return; }
    // cumulative distance along the outline so a lap fraction maps to a point
    this.cum = [0];
    for (let i = 1; i < points.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    this.len = this.cum[this.cum.length - 1];
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const pad = 70, w = Math.max(...xs) + pad * 2, h = Math.max(...ys) + pad * 2;
    this.off = pad;
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, class: "track-svg", role: "img", "aria-label": "Circuit map with every car placed by its timing" });
    const d = "M" + points.map((p) => `${p[0] + pad} ${p[1] + pad}`).join(" L") + " Z";
    el("path", { d, fill: "none", stroke: "#262B36", "stroke-width": 26, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    el("path", { d, fill: "none", stroke: "#3A4050", "stroke-width": 2, "stroke-dasharray": "2 10" }, svg);
    const [sx, sy] = [points[0][0] + pad, points[0][1] + pad];
    el("rect", { x: sx - 10, y: sy - 10, width: 20, height: 20, fill: "#E8EAF0", rx: 3 }, svg);
    el("text", { x: sx, y: sy - 18, class: "c-sub" }, svg).textContent = "start / finish";
    if (fromGps) el("text", { x: pad, y: h - 20, class: "c-sub", "text-anchor": "start" }, svg).textContent = "real car positions (GPS, once a second)";
    this.flagLayer = el("g", { class: "flag-layer" }, svg);
    this.cornerLayer = el("g", { class: "corner-layer" }, svg);
    this.flagKey = "";
    this.svg = svg;
    this.drawCorners();
    this.drawFlags();
    this.battleLayer = el("g", {}, svg);
    this.dotLayer = el("g", {}, svg);
    this.svg = svg;
    this.box.appendChild(svg);
  }

  // corner numbers and marshal sectors, from the circuit file
  setInfo(info) {
    if (info === this.info) return;
    this.info = info;
    this.drawCorners();
    this.flagKey = "";
    this.drawFlags();
  }

  // a point given in the circuit file's 0–1000 box, placed on whichever outline is showing
  place(p) {
    const b = this.bbox ??= (() => { const xs = this.points.map((q) => q[0]), ys = this.points.map((q) => q[1]); const minX = Math.min(...xs), minY = Math.min(...ys); return { minX, minY, size: Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) }; })();
    return [b.minX + (p[0] / 1000) * b.size, b.minY + (p[1] / 1000) * b.size];
  }
  nearest(xy) {
    let best = 0, bd = Infinity;
    this.points.forEach((q, i) => { const d = (q[0] - xy[0]) ** 2 + (q[1] - xy[1]) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  }

  drawCorners() {
    if (!this.cornerLayer) return;
    this.cornerLayer.innerHTML = "";
    const corners = this.info?.corners;
    if (!corners?.length || !this.points) return;
    const n = this.points.length, pts = this.points, off = this.off;
    const cx = pts.reduce((a, q) => a + q[0], 0) / n, cy = pts.reduce((a, q) => a + q[1], 0) / n;
    for (const c of corners) {
      const xy = this.place(c.p), i = this.nearest(xy);
      // push the label to the outside of the bend (away from where the track curves to)
      const a = pts[(i - 6 + n) % n], b = pts[(i + 6) % n], p = pts[i];
      let ox = p[0] - (a[0] + b[0]) / 2, oy = p[1] - (a[1] + b[1]) / 2, len = Math.hypot(ox, oy);
      if (len < 4) { ox = p[0] - cx; oy = p[1] - cy; len = Math.hypot(ox, oy) || 1; }
      const lx = xy[0] + (ox / len) * 40 + off, ly = xy[1] + (oy / len) * 40 + off;
      const g = el("g", { class: "corner" }, this.cornerLayer);
      el("line", { x1: xy[0] + off, y1: xy[1] + off, x2: lx, y2: ly, class: "corner-tick" }, g);
      el("circle", { cx: lx, cy: ly, r: 17, class: "corner-dot" }, g);
      el("text", { x: lx, y: ly, class: "corner-num" }, g).textContent = `${c.n}${c.l}`;
    }
  }

  // flags: { sectors: { 7: "yellow" | "double" }, track: "4" } — lights up the stretch of track
  setFlags(flags) {
    this.flags = flags;
    this.drawFlags();
  }
  drawFlags() {
    if (!this.flagLayer || !this.points) return;
    const f = this.flags ?? {}, ms = this.info?.marshal ?? [];
    const key = JSON.stringify([f.sectors, f.track, ms.length]);
    if (key === this.flagKey) return;
    this.flagKey = key;
    this.flagLayer.innerHTML = "";
    const pts = this.points, n = pts.length, off = this.off;
    const path = (i0, i1) => { const out = []; for (let k = i0; ; k = (k + 1) % n) { out.push(pts[k]); if (k === i1 || out.length > n) break; } return "M" + out.map((q) => `${q[0] + off} ${q[1] + off}`).join(" L"); };
    // whole track: safety car / VSC / red flag
    const whole = { 4: ["sc", "SAFETY CAR"], 6: ["vsc", "VIRTUAL SAFETY CAR"], 7: ["vsc", "VSC ENDING"], 5: ["red", "RED FLAG"] }[f.track];
    if (whole) el("path", { d: path(0, n - 1) + " Z", class: `flag-track ${whole[0]}` }, this.flagLayer);
    // one marshal sector = from its post to the next one
    const sorted = [...ms].sort((a, b) => a.n - b.n);
    for (const [num, kind] of Object.entries(f.sectors ?? {})) {
      const k = sorted.findIndex((m) => m.n === Number(num));
      if (k < 0) continue;
      const i0 = this.nearest(this.place(sorted[k].p)), i1 = this.nearest(this.place(sorted[(k + 1) % sorted.length].p));
      el("path", { d: path(i0, i1), class: `flag-sector ${kind}` }, this.flagLayer);
      const mid = pts[(i0 + Math.round(((i1 - i0 + n) % n) / 2)) % n];
      const g = el("g", { class: `flag-tag ${kind}` }, this.flagLayer);
      const label = `${kind === "double" ? "YY" : "Y"} ${num}`, wdt = 18 + label.length * 10;
      el("rect", { x: mid[0] + off - wdt / 2, y: mid[1] + off - 46, width: wdt, height: 24, rx: 5 }, g);
      el("text", { x: mid[0] + off, y: mid[1] + off - 34 }, g).textContent = label;
      el("title", {}, g).textContent = `${kind === "double" ? "Double yellow" : "Yellow"} flag in marshal sector ${num}`;
    }
  }

  at(f) {
    const target = (((f % 1) + 1) % 1) * this.len;
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] < target) lo = mid + 1; else hi = mid; }
    const i = Math.max(1, lo), a = this.points[i - 1], b = this.points[i];
    const seg = this.cum[i] - this.cum[i - 1] || 1, t = (target - this.cum[i - 1]) / seg;
    return [a[0] + (b[0] - a[0]) * t + this.off, a[1] + (b[1] - a[1]) * t + this.off];
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = 0;
    const loop = (t) => {
      if (!this.running) return;
      if (t - last > 45) { last = t; this.frame(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }

  // where car n really was at time t (interpolated between the once-a-second samples)
  gpsAt(n, t) {
    const g = this.gps, xy = g?.cars?.[n];
    if (!xy) return null;
    const f = (t - g.t0) / g.step, i = Math.floor(f), k = f - i;
    if (i < 0 || i * 2 + 3 >= xy.length) return null;
    const [x0, y0, x1, y1] = [xy[i * 2], xy[i * 2 + 1], xy[i * 2 + 2], xy[i * 2 + 3]];
    if (x0 < 0) return null;
    if (x1 < 0) return [x0 + this.off, y0 + this.off];
    return [x0 + (x1 - x0) * k + this.off, y0 + (y1 - y0) * k + this.off];
  }

  frame() {
    const pos = this.circle.lastPos;
    if (!this.points || !pos) return;
    const t = this.usingGps && this.nowFn ? this.nowFn() : null;
    const sel = this.circle.model?.selCar?.n;
    const seen = new Set();
    // cars close together on track get their names stacked above/below so they stay readable
    const order = [...pos].sort((a, b) => a.f - b.f);
    const lift = {};
    order.forEach((p, i) => { const prev = order[i - 1]; lift[p.n] = prev && p.f - prev.f < 0.02 ? (lift[prev.n] === -20 ? 36 : -20) : -20; });
    for (const p of pos) {
      seen.add(p.n);
      let it = this.items.get(p.n);
      if (!it) {
        const g = el("g", { class: "hit", "data-n": p.n }, this.dotLayer);
        const dot = el("circle", { r: 13, "stroke-width": 3 }, g);
        const label = el("text", { class: "tr-tla", y: -20 }, g);
        it = { g, dot, label };
        this.items.set(p.n, it);
      }
      const real = t != null ? this.gpsAt(p.n, t) : null;
      if (t != null && !real) { it.g.setAttribute("opacity", 0); continue; }
      const [x, y] = real ?? this.at(p.f);
      it.g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      it.g.setAttribute("opacity", p.inPit ? 0.4 : 1);
      it.dot.setAttribute("fill", p.colour);
      it.dot.setAttribute("stroke", p.n === sel ? "#FFB547" : "#0B0D12");
      it.label.textContent = p.tla;
      it.label.setAttribute("y", lift[p.n]);
    }
    for (const [n, it] of this.items) if (!seen.has(n)) { it.g.remove(); this.items.delete(n); }
  }
}
