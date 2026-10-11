// Technical tab: car upgrades (FIA car presentation submissions), power unit usage (FIA
// technical delegate's report) and crash cost estimates. Data files come from the hourly job.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}k`);

// fallback team colours (2026) for when no timing data is loaded
const TEAM = {
  "McLaren": "#FF8000", "Mercedes": "#27F4D2", "Red Bull Racing": "#3671C6", "Ferrari": "#E8002D", "Williams": "#1868DB",
  "Racing Bulls": "#6692FF", "Aston Martin": "#229971", "Haas": "#B6BABD", "Alpine": "#FF87BC", "Audi": "#F50537", "Cadillac": "#AAAAAD",
};
export function teamKey(name) {
  const t = String(name ?? "").toLowerCase();
  for (const k of Object.keys(TEAM)) if (t.startsWith(k.toLowerCase())) return k;
  if (/racing bulls|rb\b|vcarb/.test(t)) return "Racing Bulls";
  if (/red bull/.test(t)) return "Red Bull Racing";
  for (const k of Object.keys(TEAM)) if (t.includes(k.toLowerCase().split(" ")[0])) return k;
  return name;
}
const colourOf = (team) => TEAM[teamKey(team)] ?? "#6B7383";

const cache = {};
async function json(path, maxAge = 10 * 60e3) {
  const c = cache[path];
  if (c && Date.now() - c.at < maxAge) return c.data;
  try { const r = await fetch(`${path}?t=${Math.floor(Date.now() / maxAge)}`); const data = r.ok ? await r.json() : null; cache[path] = { at: Date.now(), data }; return data; }
  catch { return null; }
}
export const loadTechnical = () => json("data/fia/technical.json");
export const loadCrashCost = () => json("data/crashcost.json");

// ---------------- car upgrades ----------------
export function renderUpgrades(tech, pick) {
  if (!tech?.upgrades) return `<section class="card"><h2>Car upgrades</h2><div class="muted small">Upgrade lists appear here once the hourly job has read this season's FIA car presentation documents.</div></section>`;
  const rounds = tech.rounds;
  const teams = new Map();
  for (const u of tech.upgrades) {
    const t = teamKey(u.team);
    const row = teams.get(t) ?? { team: t, total: 0, byRound: {} };
    row.total++; row.byRound[u.round] = (row.byRound[u.round] ?? 0) + 1;
    teams.set(t, row);
  }
  for (const t of Object.keys(TEAM)) if (!teams.has(t)) teams.set(t, { team: t, total: 0, byRound: {} });
  const rows = [...teams.values()].sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...rows.flatMap((r) => Object.values(r.byRound)));
  const checked = new Set(tech.upgradesChecked);
  const sel = pick ?? { round: rounds.at(-1)?.round ?? null, team: null };
  const head = rounds.map((r) => `<th title="${esc(r.name)}"><button class="up-col ${sel.round === r.round && !sel.team ? "on" : ""}" data-up-round="${r.round}">R${r.round}</button></th>`).join("");
  const body = rows.map((r) => `<tr>
      <th class="up-team"><i class="team" style="background:${colourOf(r.team)}"></i><span>${esc(r.team)}</span><span class="muted small">${r.total}</span></th>
      ${rounds.map((rd) => {
        const n = r.byRound[rd.round] ?? 0;
        const on = sel.round === rd.round && sel.team === r.team;
        if (!checked.has(rd.round)) return `<td><span class="up-cell none" title="No document yet">·</span></td>`;
        return `<td><button class="up-cell ${n ? "" : "zero"} ${on ? "on" : ""}" data-up-round="${rd.round}" data-up-team="${esc(r.team)}" style="--k:${n ? 0.18 + 0.82 * (n / max) : 0}" aria-label="${esc(r.team)}, ${esc(rd.name)}: ${n} update${n === 1 ? "" : "s"}">${n || ""}</button></td>`;
      }).join("")}
    </tr>`).join("");
  const list = tech.upgrades.filter((u) => (sel.round == null || u.round === sel.round) && (!sel.team || teamKey(u.team) === sel.team));
  const roundName = rounds.find((r) => r.round === sel.round)?.name ?? "";
  const detail = list.length ? list.map((u) => `<tr>
      <td><i class="team" style="background:${colourOf(u.team)}"></i>${esc(teamKey(u.team))}</td>
      <td><b>${esc(u.component)}</b>${u.geometry ? `<div class="muted small">${esc(u.geometry)}</div>` : ""}</td>
      <td><span class="up-type ${esc(u.type.toLowerCase().replace(/\s+/g, "-"))}">${esc(u.type)}</span><div class="muted small">${esc(u.reason)}</div></td>
      <td class="small">${esc(u.description)}${u.source ? ` <a href="${esc(u.source)}" target="_blank" rel="noopener" class="muted">FIA document</a>` : ""}</td>
    </tr>`).join("") : `<tr><td colspan="4" class="muted small">No upgrades ${sel.team ? `from ${esc(sel.team)} ` : ""}at this event.</td></tr>`;
  return `<section class="card">
      <div class="card-head"><h2>Car upgrades</h2><span class="muted small">${tech.upgrades.length} updated parts this season · tap a square for the list</span></div>
      <div class="scroll"><table class="up-grid"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <h3 class="sub">${esc(sel.team ? `${sel.team} · ` : "")}${esc(roundName)}</h3>
      <div class="scroll"><table class="timing compact up-list"><thead><tr><th>TEAM</th><th>PART</th><th>WHY</th><th>WHAT IT DOES</th></tr></thead><tbody>${detail}</tbody></table></div>
      <p class="muted small">From each weekend's FIA “Car Presentation Submissions”. Descriptions are the teams' own words; some long cells in the FIA tables can get split oddly, so the FIA document link has the original.</p>
    </section>`;
}

// ---------------- power units ----------------
export function renderPowerUnits(tech, open) {
  const pu = tech?.pu;
  if (!pu) return `<section class="card"><h2>Power unit elements</h2><div class="muted small">Appears once the hourly job has read the FIA technical delegate's report.</div></section>`;
  const els = pu.elements, allow = pu.allowance;
  const total = els.reduce((a, e) => a + allow[e], 0);
  const cell = (used, cap) => {
    const left = cap - used;
    const cls = left < 0 ? "over" : left === 0 ? "limit" : "ok";
    return `<td class="pu ${cls}" title="${used} used of ${cap} allowed"><b>${used}</b><span>/${cap}</span>${left < 0 ? `<em>+${-left}</em>` : ""}</td>`;
  };
  const drivers = [...pu.drivers].sort((a, b) => teamKey(a.team).localeCompare(teamKey(b.team)));
  const rows = drivers.map((d) => {
    const used = els.reduce((a, e) => a + d.used[e], 0);
    const over = els.reduce((a, e) => a + Math.max(0, d.used[e] - allow[e]), 0);
    const isOpen = open === d.n;
    return `<tr class="pu-row ${isOpen ? "open" : ""}" data-pu="${esc(d.n)}" tabindex="0" aria-expanded="${isOpen}">
        <th><i class="team" style="background:${colourOf(d.team)}"></i>${esc(d.driver)}<span class="muted small"> ${esc(teamKey(d.team))}</span></th>
        <td class="pu total ${over ? "over" : ""}"><b>${used}</b><span>/${total}</span>${over ? `<em>${over} over</em>` : ""}</td>
        ${els.map((e) => cell(d.used[e], allow[e])).join("")}
      </tr>${isOpen ? `<tr class="pu-hist"><td colspan="${els.length + 2}">${d.history.length ? d.history.map((h) => `<span><b>R${h.round}</b> ${esc(h.event.replace(/ Grand Prix$/, ""))}: ${esc(h.parts.join(", "))}</span>`).join("") : "No new parts recorded yet."}</td></tr>` : ""}`;
  }).join("");
  return `<section class="card">
      <div class="card-head"><h2>Power unit elements</h2><span class="muted small">after the ${esc(pu.event)} (round ${pu.round}) · tap a driver for when each part was fitted</span></div>
      <div class="scroll"><table class="pu-table"><thead><tr><th>DRIVER</th><th>TOTAL</th>${els.map((e) => `<th title="${esc(EL[e] ?? e)}">${esc(e)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="pu-legend small muted"><span><i class="ok"></i>within the allowance</span><span><i class="limit"></i>used them all — the next one is a grid penalty</span><span><i class="over"></i>over the allowance (penalties taken)</span></div>
      <p class="muted small">Each driver may use ${els.map((e) => `${allow[e]} ${e}`).join(", ")} per season; every extra element means a grid penalty. ${pu.source ? `<a href="${esc(pu.source)}" target="_blank" rel="noopener">FIA report</a>.` : ""}</p>
    </section>`;
}
const EL = { ICE: "Internal combustion engine", TC: "Turbocharger", EXH: "Exhaust set", "MGU-K": "Motor generator unit – kinetic", ES: "Energy store (battery)", "PU-CE": "Control electronics", "PU-ANC": "Power unit ancillaries" };

// ---------------- crash costs ----------------
export function renderCrashCost(cc, ui) {
  if (!cc?.crashes) return `<section class="card"><h2>Crash costs</h2><div class="muted small">Appears once archived races have been analysed.</div></section>`;
  const by = ui.ccBy ?? "driver";
  const real = cc.crashes;
  const group = new Map();
  for (const c of real) {
    const k = by === "driver" ? c.tla : teamKey(c.team);
    const g = group.get(k) ?? { name: k, sub: by === "driver" ? teamKey(c.team) : "", colour: by === "driver" ? c.colour : colourOf(c.team), cost: 0, n: 0 };
    g.cost += c.cost; g.n++; group.set(k, g);
  }
  const standings = [...group.values()].sort((a, b) => b.cost - a.cost);
  const top = standings[0]?.cost || 1;
  const parts = {};
  for (const c of real) for (const p of c.parts) parts[p.part] = (parts[p.part] ?? 0) + p.cost;
  const partRows = Object.entries(parts).sort((a, b) => b[1] - a[1]);
  const partMax = partRows[0]?.[1] || 1;
  // by Grand Prix, in date order
  const gps = new Map();
  for (const c of [...real].sort((a, b) => a.date.localeCompare(b.date))) {
    const g = gps.get(c.meeting) ?? { name: c.meeting, cost: 0 };
    g.cost += c.cost; gps.set(c.meeting, g);
  }
  let run = 0;
  const gpRows = [...gps.values()].map((g) => ({ ...g, cum: (run += g.cost) }));
  const cum = ui.ccCum;
  const gpMax = Math.max(1, ...gpRows.map((g) => (cum ? g.cum : g.cost)));
  const worst = [...real].sort((a, b) => b.cost - a.cost).slice(0, 12);
  const total = real.reduce((a, c) => a + c.cost, 0);
  return `<div class="cc">
    <section class="card">
      <div class="card-head"><h2>Crash cost standings</h2>
        <div class="filters" id="ccBy"><button data-by="driver" class="${by === "driver" ? "on" : ""}">Drivers</button><button data-by="team" class="${by === "team" ? "on" : ""}">Teams</button></div></div>
      <div class="hbars">${standings.map((g, i) => `<div class="hbar"><span class="muted num">${i + 1}</span><span class="hbar-name"><i class="team" style="background:${esc(g.colour)}"></i>${esc(g.name)} <span class="muted small">${g.n} incident${g.n > 1 ? "s" : ""}</span></span><span class="hbar-track"><i style="width:${(g.cost / top) * 100}%;background:${esc(g.colour)}"></i></span><span class="num mono">${money(g.cost)}</span></div>`).join("")}</div>
    </section>
    <div class="stack">
      <section class="card">
        <div class="card-head"><h2>Cost by part</h2><span class="muted small">${money(total)} in total</span></div>
        <div class="hbars">${partRows.map(([p, v]) => `<div class="hbar"><span class="hbar-name">${esc(p)}</span><span class="hbar-track"><i style="width:${(v / partMax) * 100}%"></i></span><span class="num mono">${money(v)}</span></div>`).join("")}</div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Cost by Grand Prix</h2>
          <div class="filters" id="ccCum"><button data-cum="0" class="${cum ? "" : "on"}">Each race</button><button data-cum="1" class="${cum ? "on" : ""}">Running total</button></div></div>
        <div class="vbars">${gpRows.map((g) => `<div class="vbar" title="${esc(g.name)}: ${money(cum ? g.cum : g.cost)}"><span class="mono small">${money(cum ? g.cum : g.cost)}</span><i style="height:${((cum ? g.cum : g.cost) / gpMax) * 100}%"></i><span class="muted small">${esc(g.name.slice(0, 3).toUpperCase())}</span></div>`).join("")}</div>
      </section>
    </div>
    <section class="card">
      <h2>Most expensive incidents</h2>
      <div class="worst">${worst.map((c) => `<div class="worst-item"><div><i class="team" style="background:${esc(c.colour)}"></i><b>${esc(c.tla)}</b> <span class="muted small">${esc(c.meeting)} ${esc(c.session)} · lap ${c.lap}</span></div><div class="small">${esc(c.label)} — <span class="muted">${esc(c.evidence)}</span></div><div class="mono">${money(c.cost)}</div></div>`).join("")}</div>
    </section>
    <section class="card cc-method">
      <h2>How this is worked out</h2>
      <p class="small">Teams don't publish repair bills, so these are estimates. Each incident is judged from the timing data: a car that stopped for good just before a red flag counts as a big crash, before a safety car a medium one; a collision followed by a pit stop within 3 laps is a new front wing and nose; a collision followed by retirement is wing, nose, suspension and floor; other noted contact is minor bodywork. Parts are priced from rough public figures:</p>
      <div class="cc-prices">${Object.entries(cc.prices).map(([p, v]) => `<span>${esc(p)} <b class="mono">${money(v)}</b></span>`).join("")}</div>
      <p class="muted small">Covers the ${cc.sessions} sessions in the replay archive.</p>
    </section>
  </div>`;
}
