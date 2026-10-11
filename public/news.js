// News headlines and the Technical tab (upgrades, power units, crash analysis).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const cache = {};
async function json(path, maxAge = 5 * 60e3) {
  const c = cache[path];
  if (c && Date.now() - c.at < maxAge) return c.data;
  try {
    const r = await fetch(`${path}?t=${Math.floor(Date.now() / maxAge)}`);
    const data = r.ok ? await r.json() : null;
    cache[path] = { at: Date.now(), data };
    return data;
  } catch { return null; }
}
export const loadNews = () => json("data/news.json");
export const loadIncidentIndex = () => json("data/incidents/index.json");
export const loadIncidents = (key) => json(`data/incidents/${key}.json`, 60 * 60e3);

function ago(iso) {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
const headline = (n) => `<a class="news-item" href="${esc(n.link)}" target="_blank" rel="noopener">
    <span class="news-title">${esc(n.title)}</span>
    <span class="muted small">${esc(n.source)} · ${ago(n.date)}${n.tags.length ? " · " + n.tags.map(esc).join(", ") : ""}</span>
  </a>`;

export function renderNews(news, filter) {
  if (!news?.items?.length) return `<section class="card"><h2>Latest news</h2><div class="muted small">Headlines appear here once the hourly job has collected them.</div></section>`;
  const tags = ["all", "upgrades", "power unit", "crashes", "technical"];
  const items = news.items.filter((n) => filter === "all" || n.tags.includes(filter));
  return `<section class="card">
      <div class="card-head"><h2>Latest news</h2>
        <div class="filters" id="newsFilters">${tags.map((t) => `<button data-f="${t}" class="${t === filter ? "on" : ""}">${t === "all" ? "All" : t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div></div>
      <div class="news-list">${items.length ? items.map(headline).join("") : `<div class="muted small">No ${esc(filter)} stories right now.</div>`}</div>
      <div class="muted small">Headlines from Formula 1, Motorsport.com, Autosport and RaceFans — tap one to read it on their site. Updated hourly.</div>
    </section>`;
}

// little speed trace leading into a crash: [seconds relative to the hit, km/h, brake]
function crashTrace(trace) {
  if (!trace?.length) return "";
  const W = 320, H = 70;
  const t0 = trace[0][0], t1 = trace[trace.length - 1][0], vmax = Math.max(...trace.map((p) => p[1]), 50);
  const x = (t) => ((t - t0) / Math.max(0.1, t1 - t0)) * W, y = (v) => H - 4 - (v / vmax) * (H - 8);
  const line = trace.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const brakes = trace.filter((p) => p[2]).map((p) => `<rect x="${x(p[0]).toFixed(1)}" y="${H - 4}" width="3" height="4" fill="#FF6B6B"></rect>`).join("");
  const zero = x(0);
  return `<svg viewBox="0 0 ${W} ${H}" class="crash-svg" role="img" aria-label="Speed in the seconds before the incident">
    <line x1="${zero.toFixed(1)}" x2="${zero.toFixed(1)}" y1="0" y2="${H}" stroke="#FF6B6B" stroke-dasharray="3 3"></line>
    <polyline points="${line}" fill="none" stroke="#FFB547" stroke-width="2"></polyline>${brakes}</svg>`;
}

const KIND = { crash: "Crash", collision: "Collision", stopped: "Stopped on track", spin: "Spin" };

export function renderTechnical(news, incIndex, incSession, pickedKey) {
  const tagged = (t, n = 8) => (news?.items ?? []).filter((x) => x.tags.includes(t)).slice(0, n);
  const list = (t) => { const xs = tagged(t); return xs.length ? `<div class="news-list">${xs.map(headline).join("")}</div>` : `<div class="muted small">No ${t} stories in the latest headlines.</div>`; };

  const sessions = (incIndex?.sessions ?? []).filter((s) => s.incidents.length);
  const opts = sessions.map((s) => `<option value="${s.key}" ${s.key === incSession?.key ? "selected" : ""}>${esc(s.meeting)} · ${esc(s.name)} (${s.incidents.length})</option>`).join("");
  const incidents = (incSession?.incidents ?? []).filter((i) => i.kind !== "spin");
  const crashCards = incidents.length ? incidents.map((i) => `<article class="crash">
      <div class="crash-head"><i class="team" style="background:${esc(i.colour)}"></i><b>${esc(i.tla)}</b> <span class="badge ${i.kind === "crash" ? "red" : i.kind === "collision" ? "overtake" : ""}">${KIND[i.kind] ?? i.kind}${i.likely ? " (likely)" : ""}</span> <span class="muted small">${i.lap ? "Lap " + i.lap : ""}</span></div>
      <div class="small">${esc(i.message)}</div>
      ${i.analysis ? `<div class="crash-stats">
          <div><div class="muted small">Speed just before</div><div class="mono">${i.analysis.speedBefore} km/h</div></div>
          <div><div class="muted small">Hardest slowing (est.)</div><div class="mono">${i.analysis.peakG} g</div></div>
          <div><div class="muted small">Car came to a stop</div><div class="mono">${i.analysis.stoppedFully ? "yes" : "no"}</div></div>
        </div>${crashTrace(i.analysis.trace)}<div class="muted small">Speed in the seconds around the incident (red marks = braking).</div>` : `<div class="muted small">No speed data for this one.</div>`}
    </article>`).join("") : `<div class="muted small">${sessions.length ? "No crashes or collisions in this session." : "Crash analysis appears once sessions have been archived."}</div>`;

  return `<div class="tech">
    <section class="card tech-wide">
      <div class="card-head"><h2>Crash analysis</h2>${opts ? `<label class="muted small">Session <select id="techSession">${opts}</select></label>` : ""}</div>
      <p class="muted small">From race control reports and the car's own speed data. The speed data is only sampled about 4 times a second, so “hardest slowing” is an average over a fraction of a second — real impact peaks are far higher and only the FIA's accident data recorder sees them.</p>
      <div class="crashes">${crashCards}</div>
    </section>
    <section class="card"><h2>Car upgrades</h2>${list("upgrades")}
      <div class="muted small">Teams' official upgrade sheets are published each weekend on <a href="https://www.fia.com/documents/championships/fia-formula-one-world-championship-14" target="_blank" rel="noopener">fia.com</a> (“Car Presentation Submissions”).</div></section>
    <section class="card"><h2>Power units &amp; grid penalties</h2>${list("power unit")}
      <div class="muted small">Each driver's power unit element usage is listed in the FIA's event documents on <a href="https://www.fia.com/documents/championships/fia-formula-one-world-championship-14" target="_blank" rel="noopener">fia.com</a>.</div></section>
    <section class="card"><h2>Technical talk</h2>${list("technical")}</section>
  </div>`;
}
