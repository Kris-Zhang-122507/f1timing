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
export async function loadTrack(circuit) {
  const slug = circuitSlug(circuit);
  if (!slug) return null;
  if (slug in cache) return cache[slug];
  try {
    const r = await fetch(`data/tracks/${slug}.json`);
    cache[slug] = r.ok ? (await r.json()).points : null;
  } catch { cache[slug] = null; }
  return cache[slug];
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

  setPoints(points) {
    if (points === this.points) return;
    this.points = points;
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
    this.battleLayer = el("g", {}, svg);
    this.dotLayer = el("g", {}, svg);
    this.svg = svg;
    this.box.appendChild(svg);
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

  frame() {
    const pos = this.circle.lastPos;
    if (!this.points || !pos) return;
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
      const [x, y] = this.at(p.f);
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
