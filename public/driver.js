// My driver: one driver's race at a glance — built for a phone next to the TV.
import { computeModel } from "./circle.js?v=mv4kitnd";
import { fade } from "./tyres.js?v=mv4kitnd";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = parseFloat(String(v ?? "").replace("+", "")); return Number.isFinite(n) ? n : null; };
const TYRE = { S: "soft", M: "medium", H: "hard", I: "intermediate", W: "wet" };
const BADGE = { pit: "Pit", overtake: "Overtake", fastest: "Fastest lap", sc: "Safety car", red: "Red flag", green: "Green flag", out: "Retired" };

function trendText(h) {
  if (!h || h.length < 2) return "";
  const r = (h[h.length - 1] - h[0]) / (h.length - 1);
  if (r < -0.05) return `closing ${(-r).toFixed(2)}s/lap`;
  if (r > 0.05) return `pulling away ${r.toFixed(2)}s/lap`;
  return "steady";
}

export function renderDriver(v, n, pitLoss) {
  const rows = v.rows.filter((r) => r.pos < 99);
  if (!rows.length) return `<div class="muted empty">Waiting for timing data…</div>`;
  const me = rows.find((r) => r.n === n) ?? rows[0];
  const idx = rows.indexOf(me);
  const ahead = rows[idx - 1], behind = rows[idx + 1];
  const opts = rows.map((r) => `<option value="${esc(r.n)}" ${r.n === me.n ? "selected" : ""}>${esc(r.tla)} — ${esc(r.name)}</option>`).join("");

  const gapAhead = num(me.int);
  const gapBehind = behind ? num(behind.int) : null;
  const m = computeModel(v, me.n, pitLoss);
  const f = fade(me.hist);
  const events = v.story.filter((e) => e.head.includes(me.tla)).slice(0, 4);
  const radio = (v.radio ?? []).filter((c) => c.n === me.n).slice(0, 3);
  const laps = me.hist.slice(-5).reverse();

  const card = (label, value, sub, hot) => `<div class="dv-tile ${hot ? "hot" : ""}"><div class="muted small">${label}</div><div class="dv-val">${value}</div><div class="small ${hot ? "warn" : "muted"}">${sub}</div></div>`;

  return `<div class="dv">
    <label class="dv-pick">Following <select id="dvSel">${opts}</select></label>
    <section class="card dv-main" style="border-top:4px solid ${esc(me.colour)}">
      <div class="dv-head">
        <span class="dv-pos">${me.out ? "OUT" : "P" + me.pos}</span>
        <div><div class="dv-name">${esc(me.name)}</div><div class="muted small">${[esc(me.team), `${esc(TYRE[me.tyre] ?? me.tyre)}s, ${esc(me.tyreAge)} laps old`, me.inPit ? "IN THE PITS" : ""].filter(Boolean).join(" · ")}</div></div>
      </div>
      <div class="dv-tiles">
        ${ahead ? card(`To ${esc(ahead.tla)} ahead`, gapAhead != null ? gapAhead.toFixed(1) + "s" : esc(me.int), trendText(me.intHist) || "&nbsp;", gapAhead != null && gapAhead < 1) : card("Leading", "—", "nobody ahead", false)}
        ${behind ? card(`${esc(behind.tla)} behind`, gapBehind != null ? gapBehind.toFixed(1) + "s" : esc(behind.int), trendText(behind.intHist) || "&nbsp;", gapBehind != null && gapBehind < 1) : card("Last on the road", "—", "nobody behind", false)}
        ${card("Last lap", esc(me.last) || "—", me.best ? `best ${esc(me.best)}` : "&nbsp;", false)}
        ${card("Tyre fade", f == null ? "—" : `${f >= 0 ? "+" : "−"}${Math.abs(f).toFixed(2)}s`, f == null ? "needs a few laps" : "slower each lap", f != null && f > 0.12)}
      </div>
    </section>
    ${m?.pit ? `<section class="card"><div class="muted small caps">If ${esc(me.tla)} pits now</div>
      <div class="dv-call">P${m.pit.pos}</div>
      <div class="small">${[m.pit.ahead ? `${m.pit.ahead.by.toFixed(1)}s behind ${esc(m.pit.ahead.tla)}` : "", m.pit.behind ? `${m.pit.behind.by.toFixed(1)}s ahead of ${esc(m.pit.behind.tla)}` : ""].filter(Boolean).join(" · ")}</div>
      <div class="small muted">pit stop ≈ ${m.pit.loss.toFixed(0)}s${m.pit.caution ? " (cheap — caution period)" : ""}</div></section>` : ""}
    <section class="card"><h2>${esc(me.tla)}'s race</h2>
      ${events.length ? events.map((e) => `<div class="item"><div class="when">L${e.lap ?? ""}</div><div class="what"><span class="badge ${e.type}">${BADGE[e.type] ?? e.type}</span><div class="head">${esc(e.head)}</div></div></div>`).join("") : `<div class="muted small">Nothing yet since you opened the page.</div>`}
      ${radio.length ? `<div class="dv-radio">${radio.map((c) => `<button class="btn" data-url="${esc(c.url)}">▶ Radio ${c.lap ? "L" + c.lap : esc(c.t)}</button>`).join("")}</div>` : ""}
    </section>
    <section class="card"><h2>Last laps</h2>
      ${laps.length ? `<table class="timing compact"><tbody>${laps.map((h) => `<tr><td class="num">L${h.lap}</td><td class="num">${Math.floor(h.s / 60)}:${(h.s % 60).toFixed(3).padStart(6, "0")}</td><td class="muted small">${esc(TYRE[h.tyre] ?? h.tyre)}</td></tr>`).join("")}</tbody></table>` : `<div class="muted small">Builds up while the page is open.</div>`}
    </section>
  </div>`;
}
