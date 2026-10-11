// Rewind: the race in one chart (positions lap by lap) and the key moments.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BADGE = { pit: "Pit", overtake: "Overtake", fastest: "Fastest lap", sc: "Safety car", red: "Red flag", green: "Green flag", out: "Retired" };

export function renderRewind(v, focus, markLap) {
  const rows = v.rows.filter((r) => r.pos < 99 && r.posHist.length);
  const laps = rows.flatMap((r) => r.posHist.map((p) => p.lap));
  if (laps.length < 2) {
    return `<section class="card"><h2>The race in one chart</h2><div class="muted small">Positions are recorded at the end of every lap while the page is open — check back in a couple of laps. Full-race rewinds for past sessions come with the replay update.</div></section>`;
  }
  const minLap = Math.min(...laps), maxLap = Math.max(...laps);
  const maxPos = Math.max(...rows.flatMap((r) => r.posHist.map((p) => p.pos)), 10);
  const W = 1000, H = 40 + maxPos * 26, L = 46, Rm = 70;
  const x = (lap) => L + ((lap - minLap) / Math.max(1, maxLap - minLap)) * (W - L - Rm);
  const y = (pos) => 24 + (pos - 1) * 26;

  // laps with safety cars shaded
  let shade = "";
  for (const [lap, ev] of Object.entries(v.lapEvents)) {
    const l = Number(lap);
    if (ev === "sc" && l >= minLap && l <= maxLap) shade += `<rect x="${(x(l) - 4).toFixed(1)}" y="10" width="8" height="${H - 30}" fill="#3A2A0A"></rect>`;
  }
  let grid = "";
  for (let p = 1; p <= maxPos; p++) grid += `<text x="${L - 10}" y="${y(p) + 4}" class="rw-axis" text-anchor="end">P${p}</text><line x1="${L}" x2="${W - Rm}" y1="${y(p)}" y2="${y(p)}" stroke="#1C2029"></line>`;
  const step = Math.max(1, Math.ceil((maxLap - minLap) / 10));
  for (let l = minLap; l <= maxLap; l += step) grid += `<text x="${x(l).toFixed(1)}" y="${H - 6}" class="rw-axis" text-anchor="middle">L${l}</text>`;

  // draw unfocused drivers first, focused on top
  const ordered = [...rows].sort((a, b) => (a.n === focus) - (b.n === focus));
  const lines = ordered.map((r) => {
    const pts = r.posHist.map((p) => `${x(p.lap).toFixed(1)},${y(p.pos).toFixed(1)}`).join(" ");
    const last = r.posHist[r.posHist.length - 1];
    const dim = focus && r.n !== focus;
    return `<g class="rw-line" data-n="${esc(r.n)}" opacity="${dim ? 0.18 : 1}">
      <polyline points="${pts}" fill="none" stroke="transparent" stroke-width="14"></polyline>
      <polyline points="${pts}" fill="none" stroke="${esc(r.colour)}" stroke-width="${r.n === focus ? 4 : 2.5}" stroke-linejoin="round"></polyline>
      <text x="${(x(last.lap) + 8).toFixed(1)}" y="${(y(last.pos) + 4).toFixed(1)}" class="rw-label">${esc(r.tla)}</text>
    </g>`;
  }).join("");
  const marker = markLap != null && markLap >= minLap && markLap <= maxLap
    ? `<line x1="${x(markLap).toFixed(1)}" x2="${x(markLap).toFixed(1)}" y1="8" y2="${H - 22}" stroke="#FFB547" stroke-width="2"></line>` : "";

  const moments = v.story.length ? v.story.map((e) => `<button class="moment ${e.lap === markLap ? "on" : ""}" data-lap="${e.lap ?? ""}">
      <span class="badge ${e.type}">${BADGE[e.type] ?? e.type} · L${e.lap ?? "?"}</span><span>${esc(e.head)}</span></button>`).join("")
    : `<div class="muted small">Moments (pit stops, overtakes, safety cars…) appear here as they happen.</div>`;

  return `<section class="card">
      <div class="card-head"><h2>The race in one chart</h2><span class="muted small">Position at the end of each lap since lap ${minLap}. Tap a line to follow a driver · shaded = safety car / VSC.</span></div>
      <div class="scroll"><svg viewBox="0 0 ${W} ${H}" class="rw-svg" role="img" aria-label="Driver positions lap by lap">${shade}${grid}${lines}${marker}</svg></div>
      ${focus ? `<button class="btn" id="rwClear">Show everyone</button>` : ""}
    </section>
    <section class="card"><h2>Jump to a moment</h2><div class="moments">${moments}</div></section>`;
}
