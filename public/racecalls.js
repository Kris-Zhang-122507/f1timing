// Two Live panels:
//   Stewards  — pending penalties, the order once they're applied, investigations, track limits
//   Pit window — for each close battle: could the car behind undercut, or the car ahead overcut?
import { computeModel, lossFor } from "./circle.js?v=mv4zt3z3";
import { fade } from "./tyres.js?v=mv4zt3z3";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (s) => { const x = parseFloat(String(s ?? "").replace("+", "")); return Number.isFinite(x) ? x : null; };
const bar = (r) => `<i class="team" style="background:${esc(r.colour)}"></i>`;
const isRace = (v) => !!v.totalLaps && !v.quali;
const tla = (v, n) => v.rows.find((r) => r.n === n)?.tla ?? n;
const lower = (s) => String(s ?? "").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

// ---------------- stewards ----------------
export function renderStewards(v, pitLoss) {
  const st = v.stewards;
  if (!st || !v.rows.length) return `<div class="muted small">Penalties, investigations and track limits show here during a session.</div>`;
  const pending = st.penalties.filter((p) => !p.served);
  const served = st.penalties.filter((p) => p.served && !p.replaced);

  // order once pending time penalties are added (races only)
  let corrected = "";
  const timePens = pending.filter((p) => p.kind === "time");
  if (isRace(v) && timePens.length) {
    const m = computeModel(v, null, pitLoss);
    if (m) {
      const add = {};
      for (const p of timePens) add[p.n] = (add[p.n] ?? 0) + p.secs;
      // gaps must only grow down the order (a stale gap can briefly say otherwise)
      let floor = 0;
      const now = m.cars.map((c) => {
        const r = v.rows.find((x) => x.n === c.n);
        const g = Math.max(floor, c.g);
        floor = g;
        return { ...c, pos: r?.pos ?? 99, adj: g + (add[c.n] ?? 0) };
      });
      const after = [...now].sort((a, b) => a.adj - b.adj || a.pos - b.pos).map((c, i) => ({ ...c, after: now[i].pos }));
      const moved = after.filter((c) => c.after !== c.pos);
      corrected = moved.length
        ? `<div class="stw-moves">${moved.map((c) => `<div class="stw-move"><span>${bar(c)}<b>${esc(c.tla)}</b></span><span class="mono">P${c.pos} → <b class="${c.after > c.pos ? "down" : "up"}">P${c.after}</b></span><span class="muted small">${add[c.n] ? `+${add[c.n]}s` : ""}</span></div>`).join("")}</div>`
        : `<div class="muted small">Nobody would lose a place right now — the gaps behind are bigger than the penalties.</div>`;
    }
  }

  const penRow = (p) => `<div class="stw-pen ${p.served ? "served" : ""}">
      <span>${bar(v.rows.find((r) => r.n === p.n) ?? { colour: "#888" })}<b>${esc(tla(v, p.n))}</b></span>
      <span class="tag ${p.served ? "" : "pen"}">${esc(p.label)}</span>
      <span class="small">${esc(lower(p.reason))}${p.lap ? ` <span class="muted">· lap ${p.lap}</span>` : ""}</span>
      <span class="muted small">${p.served ? "served" : p.kind === "time" ? "added to their time unless served at a stop" : "must be served within 3 laps"}</span>
    </div>`;

  const tl = Object.entries(st.trackLimits).filter(([, t]) => t.strikes > 0).sort((a, b) => b[1].strikes - a[1].strikes);
  const tlHtml = tl.length ? `<div class="stw-tl">${tl.map(([n, t]) => {
      const r = v.rows.find((x) => x.n === n) ?? { colour: "#888" };
      const next = t.strikes >= 4 ? "penalty territory" : t.strikes === 3 || t.flagged ? "next one is a penalty" : t.strikes === 2 ? "one more = black and white flag" : "";
      return `<div class="stw-tlrow"><span>${bar(r)}<b>${esc(tla(v, n))}</b></span>
        <span class="strikes">${[1, 2, 3, 4].map((k) => `<i class="${k <= t.strikes ? (k >= 4 ? "pen" : k === 3 ? "bw" : "on") : ""}"></i>`).join("")}</span>
        <span class="mono">${t.strikes}</span><span class="muted small">${t.flagged ? "black and white flag shown · " : ""}${next}</span></div>`;
    }).join("")}</div>` : `<div class="muted small">No lap times deleted for track limits yet.</div>`;

  const inv = st.open.filter((i) => i.status !== "noted");
  const noted = st.open.filter((i) => i.status === "noted").slice(-5);
  const invRow = (i) => `<div class="stw-inv"><span><b>${i.cars.map((n) => esc(tla(v, n))).join(" & ")}</b></span><span class="small">${esc(lower(i.reason))}</span><span class="badge ${i.status === "investigating" ? "sc" : ""}">${esc(i.status === "after the race" ? "after the race" : i.status === "investigating" ? "under investigation" : "noted")}</span></div>`;

  return `<div class="stw">
    <h3 class="sub">Penalties to serve</h3>
    ${pending.length ? pending.map(penRow).join("") : `<div class="muted small">None right now.</div>`}
    ${corrected ? `<h3 class="sub">If it finished now, with penalties</h3>${corrected}` : ""}
    <h3 class="sub">Investigations</h3>
    ${inv.length ? inv.map(invRow).join("") : `<div class="muted small">Nothing under investigation.</div>`}
    ${noted.length ? `<details class="stw-more"><summary class="muted small">${noted.length} incident${noted.length > 1 ? "s" : ""} noted</summary>${noted.map(invRow).join("")}</details>` : ""}
    <h3 class="sub">Track limits</h3>
    <p class="muted small">Every deleted lap time is a strike: the third brings a black and white flag, the fourth a 5-second penalty.</p>
    ${tlHtml}
    ${st.warnings.length ? `<h3 class="sub">Warnings</h3>${st.warnings.slice(-6).map((w) => `<div class="stw-inv"><span><b>${esc(tla(v, w.n))}</b></span><span class="small">${esc(lower(w.reason))}</span><span class="badge">${w.flag ? "black and white flag" : "warning"}</span></div>`).join("")}` : ""}
    ${served.length ? `<details class="stw-more"><summary class="muted small">${served.length} penalt${served.length > 1 ? "ies" : "y"} already served</summary>${served.map(penRow).join("")}</details>` : ""}
  </div>`;
}

// ---------------- pit window: undercut / overcut ----------------
// Fresh tyres are worth roughly (how much the old set is fading per lap × its age) per lap.
// An undercut works if that gain over the out-lap and the next lap beats the gap.
function tyreGain(r) {
  const age = Number(r.tyreAge) || 0;
  const f = fade(r.hist);
  const perLap = f != null && f > 0 ? f : 0.04;
  return { gain: Math.max(0.3, Math.min(3, perLap * age)), perLap, known: f != null, age };
}

export function renderPitWindow(v, pitLoss) {
  if (!v.rows.length) return `<div class="muted small">Waiting for timing data…</div>`;
  if (!isRace(v)) return `<div class="muted small">Undercuts and overcuts are for races — in qualifying everyone runs on their own.</div>`;
  if (v.lap < 3) return `<div class="muted small">Pit window calls start after a couple of laps, once there's tyre data to go on.</div>`;
  const caution = ["4", "6", "7"].includes(v.track.code);
  const rows = v.rows.filter((r) => r.pos < 99 && !r.out);
  const cards = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const gap = num(b.int);
    if (gap == null || gap > 3.5 || a.inPit || b.inPit || a.pitOut || b.pitOut) continue;
    const ga = tyreGain(a), gb = tyreGain(b);
    const undercut = 1.6 * ga.gain - 0.4;            // what B gains by stopping first
    const margin = undercut - gap;
    const m = computeModel(v, b.n, pitLoss);
    const traffic = m?.pit?.ahead && m.pit.ahead.by < 1.5 ? m.pit.ahead : null;
    let call, cls;
    if (margin > 0.3) { call = `Undercut ON for ${esc(b.tla)}`; cls = "on"; }
    else if (margin > -0.3) { call = "Undercut borderline"; cls = "maybe"; }
    else { call = "Undercut off"; cls = "off"; }
    const overcut = gb.known && gb.perLap < 0.03 && gap < 1.5 && gb.age >= 8;
    const why = [
      `${esc(a.tla)}'s ${a.tyre === "S" ? "softs" : a.tyre === "M" ? "mediums" : a.tyre === "H" ? "hards" : "tyres"} are ${ga.age} laps old${ga.known ? `, losing ${ga.perLap.toFixed(2)}s a lap` : ""}`,
      `fresh tyres worth ~${undercut.toFixed(1)}s over two laps vs a ${gap.toFixed(1)}s gap`,
    ];
    cards.push(`<div class="pw ${cls}">
      <div class="pw-head"><span>${bar(b)}<b>${esc(b.tla)}</b> <span class="muted">P${b.pos}</span> <span class="muted">→</span> ${bar(a)}<b>${esc(a.tla)}</b> <span class="muted">P${a.pos}</span></span><span class="mono">${gap.toFixed(1)}s</span></div>
      <div class="pw-call">${call}${cls !== "off" ? ` <span class="mono small">${margin >= 0 ? "+" : "−"}${Math.abs(margin).toFixed(1)}s</span>` : ""}${overcut ? ` · <span class="pw-over">overcut possible for ${esc(b.tla)}</span>` : ""}</div>
      <div class="muted small">${why.join(" · ")}${traffic ? ` · would rejoin ${traffic.by.toFixed(1)}s behind ${esc(traffic.tla)} — traffic` : ""}</div>
    </div>`);
  }
  const head = caution
    ? `<div class="pw-sc">Under the ${v.track.code === "4" ? "safety car" : "VSC"} a stop costs about ${lossFor(pitLoss, v.track.code).toFixed(0)}s instead of ${lossFor(pitLoss, "1").toFixed(0)}s — a cheap stop for anyone who needs one.</div>` : "";
  return `${head}${cards.length ? cards.join("") : `<div class="muted small">No car is close enough to the one ahead for an undercut right now.</div>`}
    <p class="muted small">Estimate: fresh tyres' advantage comes from how fast the car ahead's tyres are fading and how old they are. Out-laps on cold tyres and traffic can still spoil it.</p>`;
}
