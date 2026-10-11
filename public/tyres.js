// Tyre strategy: every driver's stints across the race, plus lap times and tyre fade.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TYRE = { S: "#FF5A5A", M: "#FFD23F", H: "#E8EAF0", I: "#3DDC97", W: "#4A90E2" };
const NAME = { S: "soft", M: "medium", H: "hard", I: "intermediate", W: "wet" };

// Seconds lost per lap over the current stint's recent laps (simple least-squares slope),
// ignoring in/out laps and laps much slower than the driver's typical pace.
export function fade(hist) {
  if (hist.length < 4) return null;
  const tyre = hist[hist.length - 1].tyre;
  const stint = [];
  for (let i = hist.length - 1; i >= 0 && hist[i].tyre === tyre; i--) stint.unshift(hist[i]);
  const laps = stint.slice(1).slice(-8); // skip the out-lap
  if (laps.length < 4) return null;
  const best = Math.min(...laps.map((h) => h.s));
  const ok = laps.filter((h) => h.s < best * 1.03);
  if (ok.length < 4) return null;
  const n = ok.length, mx = ok.reduce((a, h) => a + h.lap, 0) / n, my = ok.reduce((a, h) => a + h.s, 0) / n;
  const num = ok.reduce((a, h) => a + (h.lap - mx) * (h.s - my), 0);
  const den = ok.reduce((a, h) => a + (h.lap - mx) ** 2, 0);
  return den ? num / den : null;
}

function spark(hist) {
  const pts = hist.slice(-15);
  if (pts.length < 2) return `<span class="muted small">collecting laps…</span>`;
  const best = Math.min(...pts.map((h) => h.s));
  const cap = best * 1.05;
  const w = 150, h = 34;
  const xs = (i) => (i / (pts.length - 1)) * (w - 6) + 3;
  const ys = (s) => h - 4 - ((Math.min(s, cap) - best) / (cap - best || 1)) * (h - 10);
  const dots = pts.map((p, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(p.s).toFixed(1)}" r="2.6" fill="${TYRE[p.tyre] ?? "#9AA3B2"}"><title>Lap ${p.lap}: ${p.s.toFixed(3)}s</title></circle>`).join("");
  const line = pts.map((p, i) => `${xs(i).toFixed(1)},${ys(p.s).toFixed(1)}`).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${line}" fill="none" stroke="#3A4050" stroke-width="1.5"></polyline>${dots}</svg>`;
}

export function renderTyres(v) {
  const rows = v.rows.filter((r) => r.pos < 99);
  if (!rows.length) return `<div class="muted empty">Waiting for timing data…</div>`;
  const total = v.totalLaps || Math.max(...rows.map((r) => r.stints.reduce((a, s) => a + s.laps, 0)), 1);
  const nowPct = Math.min(100, (v.lap / total) * 100);

  const body = rows.map((r) => {
    const segs = r.stints.map((s, i) => {
      const last = i === r.stints.length - 1;
      const col = TYRE[s.c] ?? "#6B7383";
      const w = Math.max(0, (s.laps / total) * 100);
      const style = s.isNew ? `background:${col};color:#0B0D12` : `background:transparent;color:${col};box-shadow:inset 0 0 0 2px ${col}`;
      return `<span class="stint ${last ? "current" : ""}" style="width:${w.toFixed(2)}%;${style}" title="${NAME[s.c] ?? s.c}, ${s.isNew ? "new" : "used"} set, ${s.laps} laps">${w > 3 ? `${esc(s.c)} ${s.laps}` : ""}</span>`;
    }).join("");
    const f = fade(r.hist);
    const fadeText = f == null ? "—" : `${f >= 0 ? "+" : "−"}${Math.abs(f).toFixed(2)}s`;
    const fadeCls = f == null ? "muted" : f > 0.12 ? "hot" : f > 0.05 ? "warm" : "cool";
    return `<tr class="${r.out ? "is-out" : ""}">
      <td class="num pos">${r.pos}</td>
      <td class="bar"><i style="background:${esc(r.colour)}"></i></td>
      <td><span class="drv">${esc(r.tla)}</span>${r.inPit ? `<span class="tag pit">IN PIT</span>` : ""}</td>
      <td class="stints-cell"><div class="stints">${segs}<span class="now-line" style="left:${nowPct.toFixed(2)}%"></span></div></td>
      <td class="num">${esc(r.tyreAge)}</td>
      <td class="num ${fadeCls}">${fadeText}</td>
      <td>${spark(r.hist)}</td>
    </tr>`;
  }).join("");

  return `<div class="scroll"><table class="timing tyres-table">
    <thead><tr><th class="r">P</th><th></th><th>DRV</th><th>STINTS (LAP 1 → ${total})</th><th class="r">AGE</th><th class="r">FADE / LAP</th><th>LAST 15 LAPS</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  <p class="muted small">Solid = new set, outlined = used set. Fade = how much slower each lap is getting on the current tyres (needs a few laps after you open the page). Hotter colour = tyres dropping off faster.</p>`;
}
