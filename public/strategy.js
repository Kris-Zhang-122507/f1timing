// Strategy tab: predicted finish, pit predictor, battle forecast and the pit stop log.
// Everything here is a simple, explainable estimate — not a crystal ball.
import { computeModel } from "./circle.js?v=mv3woo3f";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TYRE = { S: "#FF5A5A", M: "#FFD23F", H: "#E8EAF0", I: "#3DDC97", W: "#4A90E2" };
const tyre = (c) => `<span class="mini-tyre" style="border-color:${TYRE[c] ?? "#6B7383"}">${esc(c)}</span>`;
const bar = (r) => `<i class="team" style="background:${esc(r.colour)}"></i>`;

// Dry races: every driver must use two different dry compounds (unless it rained).
export function needsStop(r) {
  const used = new Set(r.stints.map((s) => s.c));
  if (used.has("I") || used.has("W")) return false;
  return [...used].filter((c) => "SMH".includes(c)).length < 2;
}

// Typical recent pace: median of the last 5 laps, ignoring slow outliers (pit/SC laps).
function pace(r) {
  const laps = r.hist.slice(-6).map((h) => h.s);
  if (laps.length < 3) return null;
  const best = Math.min(...laps);
  const ok = laps.filter((s) => s < best * 1.04).sort((a, b) => a - b);
  return ok[Math.floor(ok.length / 2)] ?? null;
}

export function predictFinish(v, pitLoss) {
  const m = computeModel(v, null, pitLoss);
  if (!m) return [];
  const lapsLeft = Math.max(0, (v.totalLaps || 0) - (v.lap || 0));
  const lead = v.rows.find((r) => r.n === m.cars[0].n);
  const leadPace = lead ? pace(lead) : null;
  return m.cars.map((c) => {
    const r = v.rows.find((x) => x.n === c.n);
    const p = pace(r);
    const paceDelta = p && leadPace ? Math.max(-3, Math.min(3, p - leadPace)) : 0;
    const stop = needsStop(r);
    const projected = c.g + paceDelta * lapsLeft + (stop && lapsLeft > 0 ? pitLoss : 0);
    return { r, now: r.pos, projected, stop, paceDelta, hasPace: !!(p && leadPace) };
  }).sort((a, b) => a.projected - b.projected).map((x, i) => ({ ...x, pred: i + 1 }));
}

export function renderStrategy(v, pitLoss) {
  if (!v.rows.length) return `<div class="muted empty">Waiting for timing data…</div>`;
  const lapsLeft = Math.max(0, (v.totalLaps || 0) - (v.lap || 0));
  const caution = ["4", "6", "7"].includes(v.track.code);

  // ---------- predicted finish ----------
  const pred = predictFinish(v, pitLoss);
  const predRows = pred.map((x) => {
    const move = x.now - x.pred;
    const arrow = move > 0 ? `<span class="up">▲${move}</span>` : move < 0 ? `<span class="down">▼${-move}</span>` : `<span class="muted">–</span>`;
    const why = [x.stop ? "still has to pit" : "", x.hasPace && Math.abs(x.paceDelta) >= 0.15 ? `${x.paceDelta > 0 ? "+" : "−"}${Math.abs(x.paceDelta).toFixed(2)}s/lap vs leader` : ""].filter(Boolean).join(" · ");
    return `<tr><td class="num pos">${x.pred}</td><td>${bar(x.r)}<span class="drv">${esc(x.r.tla)}</span></td><td class="num">${arrow}</td><td class="muted small">${why}</td></tr>`;
  }).join("");

  // ---------- pit predictor ----------
  const pitRows = v.rows.filter((r) => r.pos < 99 && !r.out).map((r) => {
    const m = computeModel(v, r.n, pitLoss);
    const p = m?.pit;
    if (!p) return "";
    const drop = p.pos - r.pos;
    const traffic = p.ahead && p.ahead.by < 1.5 ? `<span class="warn">stuck behind ${esc(p.ahead.tla)}</span>` : p.ahead ? `${p.ahead.by.toFixed(1)}s behind ${esc(p.ahead.tla)}` : "clear air";
    return `<tr class="${r.inPit ? "in-pit" : ""}"><td class="num pos">${r.pos}</td><td>${bar(r)}<span class="drv">${esc(r.tla)}</span></td>
      <td class="nowrap">${tyre(r.tyre)} <span class="muted small">${esc(r.tyreAge)}</span></td>
      <td class="num nowrap">P${p.pos} <span class="muted small">${drop > 0 ? "−" + drop : "±0"}</span></td>
      <td class="small">${traffic}</td>
      <td class="nowrap">${needsStop(r) ? `<span class="tag pit" title="Hasn't used two different tyre types yet">MUST PIT</span>` : ""}</td></tr>`;
  }).join("");

  // ---------- battle forecast ----------
  const forecasts = [];
  for (let i = 1; i < v.rows.length; i++) {
    const a = v.rows[i - 1], b = v.rows[i];
    if (a.out || b.out || a.inPit || b.inPit) continue;
    const h = b.intHist;
    const gap = parseFloat(String(b.int).replace("+", ""));
    if (!Number.isFinite(gap) || gap > 8 || h.length < 3) continue;
    const rate = (h[h.length - 1] - h[0]) / (h.length - 1); // seconds per lap, negative = closing
    if (rate > -0.05) continue;
    const laps = Math.max(0, (gap - 0.5) / -rate);
    forecasts.push({ a, b, gap, rate, laps, inTime: laps <= lapsLeft });
  }
  forecasts.sort((x, y) => x.laps - y.laps);
  const fcHtml = forecasts.length ? forecasts.slice(0, 8).map((f) => `<div class="fc ${f.inTime ? "" : "late"}">
      <div class="who">${bar(f.b)}${esc(f.b.tla)} <span class="muted">→</span> ${bar(f.a)}${esc(f.a.tla)} <span class="muted small">for P${f.a.pos}</span></div>
      <div class="num">${f.gap.toFixed(1)}s · closing ${(-f.rate).toFixed(2)}s/lap</div>
      <div class="small ${f.inTime ? "good" : "muted"}">${f.laps < 1 ? "on the gearbox now" : f.inTime ? `catches in ~${Math.ceil(f.laps)} laps (lap ${v.lap + Math.ceil(f.laps)})` : `needs ~${Math.ceil(f.laps)} laps — only ${lapsLeft} left`}</div>
    </div>`).join("") : `<div class="muted small">Nobody is closing on the car ahead fast enough yet (needs a few laps of data after you open the page).</div>`;

  // ---------- pit stop log (rebuilt from tyre stints, so it covers the whole race) ----------
  const stops = [];
  for (const r of v.rows) {
    let lap = 0;
    r.stints.forEach((s, k) => {
      if (k > 0) {
        const dur = r.pitTimes.find((p) => Math.abs(p.lap - lap) <= 1)?.dur;
        stops.push({ r, lap, from: r.stints[k - 1].c, to: s.c, isNew: s.isNew, dur });
      }
      lap += s.laps;
    });
  }
  stops.sort((a, b) => b.lap - a.lap);
  const logHtml = stops.length ? stops.map((s) => `<tr><td class="num">L${s.lap || "?"}</td><td>${bar(s.r)}<span class="drv">${esc(s.r.tla)}</span></td>
      <td>${tyre(s.from)} → ${tyre(s.to)} <span class="muted small">${s.isNew ? "new" : "used"}</span></td>
      <td class="num">${s.dur ? s.dur.toFixed(1) + "s" : "<span class='muted'>—</span>"}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted small">No pit stops yet.</td></tr>`;

  return `<div class="strategy">
    <section class="card">
      <h2>Predicted finish</h2>
      <p class="muted small">Current gaps + each driver's recent pace over the ${lapsLeft} laps left + a ${pitLoss}s stop for anyone who still has to pit. Pace needs a few laps after you open the page.</p>
      <table class="timing compact"><tbody>${predRows}</tbody></table>
    </section>
    <section class="card">
      <h2>If they pit this lap…</h2>
      <p class="muted small">Where each driver would rejoin. Pit stop ≈ ${pitLoss}s${caution ? `, about ${Math.round(pitLoss * 0.55)}s right now under caution` : ""} (change it on the Circle tab).</p>
      <div class="scroll"><table class="timing compact"><thead><tr><th class="r">P</th><th>DRV</th><th>TYRE · AGE</th><th class="r">REJOIN</th><th>TRAFFIC</th><th></th></tr></thead><tbody>${pitRows}</tbody></table></div>
    </section>
    <section class="card">
      <h2>Battle forecast</h2>
      <div class="forecasts">${fcHtml}</div>
    </section>
    <section class="card">
      <h2>Pit stops</h2>
      <div class="scroll"><table class="timing compact"><thead><tr><th>LAP</th><th>DRV</th><th>TYRES</th><th class="r">PIT LANE</th></tr></thead><tbody>${logHtml}</tbody></table></div>
    </section>
  </div>`;
}
