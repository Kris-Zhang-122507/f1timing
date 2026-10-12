// Compare: two drivers head to head.
import { lapSeconds } from "./lib/race.js?v=mv4or1zu";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = parseFloat(String(v ?? "").replace("+", "")); return Number.isFinite(n) ? n : null; };
const fmt = (s) => { if (s == null) return "—"; const m = Math.floor(s / 60); return m ? `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}` : s.toFixed(3); };

function median(xs) { const a = xs.filter((x) => x != null).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; }
function recentPace(r) {
  const laps = r.hist.slice(-6).map((h) => h.s);
  if (laps.length < 2) return null;
  const best = Math.min(...laps);
  return median(laps.filter((s) => s < best * 1.04));
}

// lower is better unless `higher`
function stat(label, a, b, show, note, higher = false) {
  let win = 0;
  if (a != null && b != null && a !== b) win = (higher ? a > b : a < b) ? 1 : 2;
  const share = a != null && b != null && a + b > 0 ? (higher ? a / (a + b) : b / (a + b)) * 100 : 50;
  return `<div class="cmp-stat">
    <div class="muted small caps">${label}</div>
    <div class="cmp-vals"><span class="${win === 1 ? "win" : ""}">${show(a)}</span><span class="${win === 2 ? "win" : ""}">${show(b)}</span></div>
    <div class="cmp-bar"><span class="a" style="width:${share.toFixed(0)}%"></span><span class="b"></span></div>
    <div class="small muted">${note ?? ""}</div>
  </div>`;
}

// Speed, throttle and brake along both drivers' fastest laps (from the archive job).
function telemetryHtml(tele, A, B) {
  if (tele === "shielded") return `<section class="card"><h2>Speed, throttle and brake</h2><div class="muted small">Hidden by the spoiler shield until the replay ends — the fastest laps would give away results. Untick “Spoiler shield” to see them now.</div></section>`;
  const a = tele?.drivers?.[A.n], b = tele?.drivers?.[B.n];
  if (!a || !b) {
    return `<section class="card"><h2>Speed, throttle and brake</h2><div class="muted small">${tele ? "No telemetry for one of these drivers in this session." : "Appears once a session at this circuit has been archived (about an hour after it ends)."}</div></section>`;
  }
  const maxD = Math.max(a.d[a.d.length - 1], b.d[b.d.length - 1]);
  const W = 1000;
  const lane = (key, h, max, label, step = false) => {
    const line = (t, col, dash) => {
      const pts = t[key].map((v, i) => `${((t.d[i] / maxD) * W).toFixed(1)},${(h - 4 - (v / max) * (h - 8)).toFixed(1)}`).join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" ${dash ? 'stroke-dasharray="6 4"' : ""} ${step ? 'stroke-linejoin="miter"' : 'stroke-linejoin="round"'}></polyline>`;
    };
    return `<div class="tele-lane"><div class="muted small caps">${label}</div>
      <svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" class="tele-svg" style="height:${h}px" role="img" aria-label="${label} for ${esc(A.tla)} and ${esc(B.tla)}">${line(a, A.colour, false)}${line(b, B.colour, true)}</svg></div>`;
  };
  const vmax = Math.max(...a.speed, ...b.speed);
  const da = a.time - b.time;
  return `<section class="card">
    <div class="card-head"><h2>Speed, throttle and brake — fastest laps</h2>
      <span class="muted small">${esc(A.tla)} ${fmt(a.time)} (solid) vs ${esc(B.tla)} ${fmt(b.time)} (dashed) · ${da === 0 ? "identical" : `${da < 0 ? esc(A.tla) : esc(B.tla)} ${Math.abs(da).toFixed(3)}s quicker`}</span></div>
    ${lane("speed", 150, vmax, `Speed (top ${vmax} km/h)`)}
    ${lane("throttle", 60, 100, "Throttle")}
    ${lane("brake", 34, 1, "Brake", true)}
    ${a.gear && b.gear ? lane("gear", 60, 8, "Gear", true) : ""}
    ${a.rpm && b.rpm ? lane("rpm", 70, Math.max(...a.rpm, ...b.rpm), `Engine RPM (top ${Math.max(...a.rpm, ...b.rpm).toLocaleString()})`) : ""}
    <div class="muted small">Distance along the lap → (${(maxD / 1000).toFixed(2)} km)</div>
  </section>`;
}

export function renderCompare(v, aN, bN, tele) {
  const rows = v.rows.filter((r) => r.pos < 99);
  if (rows.length < 2) return `<div class="muted empty">Waiting for timing data…</div>`;
  const A = rows.find((r) => r.n === aN) ?? rows[0];
  const B = rows.find((r) => r.n === bN && r.n !== A.n) ?? rows.find((r) => r.n !== A.n);
  const opts = (sel) => rows.map((r) => `<option value="${esc(r.n)}" ${r.n === sel ? "selected" : ""}>${esc(r.tla)} — ${esc(r.name)} (P${r.pos})</option>`).join("");

  const bestA = lapSeconds(A.best), bestB = lapSeconds(B.best);
  const paceA = recentPace(A), paceB = recentPace(B);
  const stA = num(A.bestSpeeds.st), stB = num(B.bestSpeeds.st);
  const secA = A.bestSectors.map(lapSeconds), secB = B.bestSectors.map(lapSeconds);
  const secWins = [0, 0];
  secA.forEach((s, i) => { if (s != null && secB[i] != null) secWins[s < secB[i] ? 0 : 1]++; });

  // gap between them on track right now
  const gA = A.pos === 1 ? 0 : num(A.gap), gB = B.pos === 1 ? 0 : num(B.gap);
  const between = gA != null && gB != null ? Math.abs(gA - gB) : null;
  const aheadTla = A.pos < B.pos ? A.tla : B.tla, behindTla = A.pos < B.pos ? B.tla : A.tla;

  // lap-by-lap: same laps both completed (since the page opened)
  const byLap = new Map(B.hist.map((h) => [h.lap, h.s]));
  const pairs = A.hist.filter((h) => byLap.has(h.lap)).map((h) => ({ lap: h.lap, d: byLap.get(h.lap) - h.s })).slice(-30);
  const usable = pairs.filter((p) => Math.abs(p.d) < 5);
  const aWins = usable.filter((p) => p.d > 0).length;
  const maxD = Math.max(0.3, ...usable.map((p) => Math.abs(p.d)));
  const bars = pairs.map((p) => {
    const h = Math.min(1, Math.abs(p.d) / maxD) * 70;
    const big = Math.abs(p.d) >= 5;
    return `<div class="lapbar" title="Lap ${p.lap}: ${p.d > 0 ? A.tla : B.tla} quicker by ${Math.abs(p.d).toFixed(3)}s${big ? " (pit stop or traffic)" : ""}">
      <div class="half up"><i style="height:${p.d > 0 ? h : 0}px;background:${esc(A.colour)};${big ? "opacity:.35" : ""}"></i></div>
      <div class="half down"><i style="height:${p.d < 0 ? h : 0}px;background:${esc(B.colour)};${big ? "opacity:.35" : ""}"></i></div>
    </div>`;
  }).join("");

  const sectorCells = [0, 1, 2].map((i) => {
    const a = secA[i], b = secB[i];
    const w = a != null && b != null ? (a < b ? A.tla : B.tla) : "";
    return `<div class="cmp-sector"><div class="muted small caps">Best S${i + 1}</div><div class="mono">${fmt(a)} · ${fmt(b)}</div><div class="small">${w ? `${esc(w)} by ${Math.abs(a - b).toFixed(3)}s` : "—"}</div></div>`;
  }).join("");

  return `<div class="cmp-pick">
      <label class="cmp-sel" style="border-color:${esc(A.colour)}">Driver A<select id="cmpA">${opts(A.n)}</select></label>
      <span class="vs">VS</span>
      <label class="cmp-sel" style="border-color:${esc(B.colour)}">Driver B<select id="cmpB">${opts(B.n)}</select></label>
      <div class="cmp-now">${between != null ? `<b>${esc(aheadTla)}</b> is <b>${between.toFixed(1)}s</b> ahead of <b>${esc(behindTla)}</b> on track` : ""}</div>
    </div>
    <div class="cmp-stats" style="--a:${esc(A.colour)};--b:${esc(B.colour)}">
      ${stat("Best lap", bestA, bestB, fmt, bestA && bestB ? (bestA === bestB ? "Identical!" : `${bestA < bestB ? A.tla : B.tla} faster by ${Math.abs(bestA - bestB).toFixed(3)}s`) : "")}
      ${stat("Recent pace (typical lap)", paceA, paceB, fmt, paceA && paceB ? `${paceA < paceB ? A.tla : B.tla} ${Math.abs(paceA - paceB).toFixed(2)}s a lap quicker` : "needs a few laps since you opened the page")}
      ${stat("Top speed", stA, stB, (x) => (x ? `${x} km/h` : "—"), stA && stB ? `${stA > stB ? A.tla : B.tla} +${Math.abs(stA - stB)} km/h` : "", true)}
      ${stat("Tyres", A.tyreAge === "" ? null : Number(A.tyreAge), B.tyreAge === "" ? null : Number(B.tyreAge), (x) => (x == null ? "—" : `${x} laps`), `${esc(A.tla)} on ${esc(A.tyre)} · ${esc(B.tla)} on ${esc(B.tyre)} (younger = fresher)`)}
    </div>
    <section class="card">
      <div class="card-head"><h2>Best sectors this session</h2><span class="muted small">${esc(A.tla)} won ${secWins[0]} · ${esc(B.tla)} won ${secWins[1]}</span></div>
      <div class="cmp-sectors">${sectorCells}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Lap by lap — who was quicker?</h2>
        <div class="legend"><span><i class="sw" style="background:${esc(A.colour)}"></i>${esc(A.tla)} quicker (up)</span><span><i class="sw" style="background:${esc(B.colour)}"></i>${esc(B.tla)} quicker (down)</span></div></div>
      ${pairs.length ? `<div class="lapbars">${bars}</div><div class="small muted">${pairs[0].lap ? `Laps ${pairs[0].lap}–${pairs[pairs.length - 1].lap}` : ""} · ${esc(A.tla)} quicker on ${aWins} of ${usable.length} laps. Faded bars are pit stops or traffic.</div>`
        : `<div class="muted small">Builds up as both drivers complete laps while the page is open.</div>`}
    </section>
    ${telemetryHtml(tele, A, B)}`;
}
