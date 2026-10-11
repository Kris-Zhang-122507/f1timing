// Championship standings from Jolpica, live "if it finished now" projections, and the
// (unofficial) Destructors' Championship: crashes, collisions and damage retirements.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const API = "https://api.jolpi.ca/ergast/f1/current";
const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

// How much each kind of retirement counts in the Destructors' Championship
const DESTRUCTION = [
  [/accident|crash/i, 10, "crash"],
  [/collision/i, 6, "collision"],
  [/damage|debris|spun off|spin/i, 4, "damage / spin"],
];

let cache = null;
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// Jolpica returns at most 100 results per request, so page through
async function allRaces(kind) {
  const races = new Map();
  for (let offset = 0; offset < 2000; offset += 100) {
    const d = await getJson(`${API}/${kind}.json?limit=100&offset=${offset}`);
    for (const r of d.MRData?.RaceTable?.Races ?? []) {
      const key = r.round;
      const prev = races.get(key);
      const rows = r.Results ?? r.SprintResults ?? [];
      if (prev) prev.rows.push(...rows); else races.set(key, { round: Number(r.round), name: r.raceName, rows: [...rows] });
    }
    if (offset + 100 >= Number(d.MRData?.total ?? 0)) break;
  }
  return [...races.values()];
}

export async function loadStandings() {
  if (cache && Date.now() - cache.at < 10 * 60e3) return cache;
  const [ds, cs] = await Promise.all([getJson(`${API}/driverStandings.json`), getJson(`${API}/constructorStandings.json`)]);
  const dl = ds.MRData?.StandingsTable?.StandingsLists?.[0];
  const cl = cs.MRData?.StandingsTable?.StandingsLists?.[0];
  let incidents = [];
  // Preferred source: incidents found in race control messages of archived sessions
  // (this season's official results only say "Retired", not why)
  try {
    const r = await fetch(`data/incidents/index.json?t=${Math.floor(Date.now() / 3e5)}`);
    const idx = r.ok ? await r.json() : null;
    for (const s of idx?.sessions ?? []) for (const i of s.incidents) {
      if (i.kind === "stopped" && !i.likely) continue; // a car stopping on its own is usually a failure, not a crash
      incidents.push({ where: `${s.meeting} ${s.name}`, code: i.tla, driver: i.tla, team: i.team, teamId: i.team, colour: i.colour, status: i.message, pts: i.points, kind: i.likely ? "likely crash" : i.kind });
    }
    if (incidents.length) incidents.source = `${idx.sessions.length} archived sessions`;
  } catch { /* fall back to official results */ }
  if (!incidents.length) try {
    const races = [...await allRaces("results"), ...(await allRaces("sprint").catch(() => []))];
    for (const race of races) for (const res of race.rows) {
      const rule = DESTRUCTION.find(([re]) => re.test(res.status ?? ""));
      if (rule) incidents.push({ where: `R${race.round}`, round: race.round, race: race.name, code: res.Driver?.code, driver: `${res.Driver?.givenName ?? ""} ${res.Driver?.familyName ?? ""}`.trim(), team: res.Constructor?.name, teamId: res.Constructor?.constructorId, status: res.status, pts: rule[1], kind: rule[2] });
    }
  } catch { incidents = null; }
  let drivers = (dl?.DriverStandings ?? []).map((d) => ({
    pos: Number(d.position || d.positionText) || null, points: Number(d.points), wins: Number(d.wins),
    code: d.Driver?.code, name: `${d.Driver?.givenName ?? ""} ${d.Driver?.familyName ?? ""}`.trim(),
    team: d.Constructors?.[d.Constructors.length - 1]?.name ?? "", teamId: d.Constructors?.[d.Constructors.length - 1]?.constructorId ?? "",
  }));
  let teams = (cl?.ConstructorStandings ?? []).map((c) => ({ pos: Number(c.position || c.positionText) || null, points: Number(c.points), wins: Number(c.wins), name: c.Constructor?.name, id: c.Constructor?.constructorId }));
  let after = `round ${Number(dl?.round) || 0}`, source = "Jolpica";
  // OpenF1 has the championship minutes after a race; Jolpica takes a few hours. Use whichever
  // is newer (more points handed out = more races counted).
  try {
    const r = await fetch(`data/championship.json?t=${Math.floor(Date.now() / 3e5)}`);
    const ch = r.ok ? await r.json() : null;
    const sum = (xs) => xs.reduce((a, x) => a + (Number(x.points) || 0), 0);
    if (ch?.drivers?.length && sum(ch.drivers) > sum(drivers)) {
      const slugT = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const winsOf = Object.fromEntries(drivers.map((d) => [d.code, d.wins]));
      const teamWins = Object.fromEntries(teams.map((t) => [slugT(t.name), t.wins]));
      const winnerTeam = ch.drivers.find((d) => d.code === ch.winner)?.team;
      drivers = ch.drivers.map((d) => ({ pos: d.pos, points: d.points, wins: (winsOf[d.code] ?? 0) + (d.code === ch.winner ? 1 : 0), code: d.code, name: d.name, team: d.team, teamId: slugT(d.team), colour: d.colour ? `#${d.colour}` : null }));
      teams = ch.teams.map((t) => ({ pos: t.pos, points: t.points, wins: (teamWins[slugT(t.name)] ?? 0) + (t.name === winnerTeam ? 1 : 0), name: t.name, id: slugT(t.name) }));
      after = `the ${ch.meeting} GP`; source = "OpenF1";
    }
  } catch { /* Jolpica only */ }
  cache = {
    at: Date.now(), after, source,
    round: (Number(dl?.round) || 0) + (source === "OpenF1" ? 1 : 0),
    drivers, teams,
    incidents,
  };
  return cache;
}

// Points each driver would score if the session finished right now
function projection(v) {
  if (!v || !v.totalLaps || v.quali) return null;
  const sprint = /sprint/i.test(v.session.name);
  const table = sprint ? SPRINT_POINTS : RACE_POINTS;
  const pts = {};
  for (const r of v.rows) if (r.pos < 99 && !r.out) pts[r.tla] = table[r.pos - 1] ?? 0;
  return { pts, label: sprint ? "sprint" : "race" };
}

export function renderStandings(st, v, { live = false, currentRound = null } = {}) {
  if (!st) return `<section class="card"><div class="muted small">Loading standings…</div></section>`;
  const colourOf = (code) => v?.rows?.find((r) => r.tla === code)?.colour ?? st.drivers.find((d) => d.code === code)?.colour ?? "#6B7383";
  const teamColour = (teamId) => {
    const d = st.drivers.find((x) => x.teamId === teamId);
    return d ? colourOf(d.code) : "#6B7383";
  };
  // only project when this weekend's result isn't in the standings yet
  const proj = live && (currentRound == null || st.round < currentRound) ? projection(v) : null;

  let drivers = st.drivers.map((d) => ({ ...d, add: proj?.pts[d.code] ?? 0 }));
  let teams = st.teams.map((t) => ({ ...t, add: drivers.filter((d) => d.teamId === t.id).reduce((a, d) => a + d.add, 0) }));
  if (proj) {
    const rank = (arr) => [...arr].sort((a, b) => b.points + b.add - (a.points + a.add)).forEach((x, i) => { x.live = i + 1; });
    rank(drivers); rank(teams);
  }
  const move = (x) => {
    if (!proj) return "";
    const d = x.pos - x.live;
    return d > 0 ? `<span class="up">▲${d}</span>` : d < 0 ? `<span class="down">▼${-d}</span>` : `<span class="muted">–</span>`;
  };
  const leader = drivers[0]?.points ?? 0;
  const dRows = drivers.map((d) => `<tr>
      <td class="num pos">${d.pos ?? "–"}</td>
      <td><i class="team" style="background:${esc(colourOf(d.code))}"></i><span class="drv">${esc(d.code ?? "")}</span> <span class="muted small">${esc(d.name)}</span></td>
      <td class="muted small">${esc(d.team)}</td>
      <td class="num">${d.wins || ""}</td>
      <td class="num"><b>${d.points}</b></td>
      <td class="num muted">${d.pos > 1 ? `−${leader - d.points}` : ""}</td>
      ${proj ? `<td class="num ${d.add ? "good" : "muted"}">${d.add ? "+" + d.add : "–"}</td><td class="num">${move(d)}</td>` : ""}
    </tr>`).join("");
  const tRows = teams.map((t) => `<tr>
      <td class="num pos">${t.pos ?? "–"}</td>
      <td><i class="team" style="background:${esc(teamColour(t.id))}"></i><span class="drv">${esc(t.name)}</span></td>
      <td class="num">${t.wins || ""}</td>
      <td class="num"><b>${t.points}</b></td>
      ${proj ? `<td class="num ${t.add ? "good" : "muted"}">${t.add ? "+" + t.add : "–"}</td><td class="num">${move(t)}</td>` : ""}
    </tr>`).join("");
  const projHead = proj ? `<th class="r">IF IT ENDED NOW</th><th></th>` : "";

  // Destructors: group incidents by team
  let destructors;
  if (st.incidents == null) destructors = `<div class="muted small">Couldn't load this season's results.</div>`;
  else {
    const byTeam = new Map();
    for (const i of st.incidents) {
      const t = byTeam.get(i.teamId) ?? { name: i.team, id: i.teamId, colour: i.colour, pts: 0, list: [] };
      t.pts += i.pts; t.list.push(i); byTeam.set(i.teamId, t);
    }
    const ranked = [...byTeam.values()].sort((a, b) => b.pts - a.pts);
    destructors = ranked.length ? `<table class="timing compact"><tbody>${ranked.map((t, i) => `<tr>
        <td class="num pos">${i + 1}</td>
        <td><i class="team" style="background:${esc(t.colour ?? teamColour(t.id))}"></i><span class="drv">${esc(t.name)}</span></td>
        <td class="small muted">${t.list.map((x) => `${esc(x.code ?? x.driver)} · ${esc(x.where)} (${esc(x.kind)})`).join("<br>")}</td>
        <td class="num"><b>${t.pts}</b></td>
      </tr>`).join("")}</tbody></table>`
      : `<div class="muted small">No incidents found yet — this fills in as sessions are archived (the first full-season run is in progress).</div>`;
  }

  return `${proj ? `<div class="card proj-note"><span class="badge red">LIVE</span> “If it ended now” adds the points each driver would get for their current position in this ${proj.label}.</div>` : ""}
    <div class="standings">
      <section class="card">
        <div class="card-head"><h2>Drivers' Championship</h2><span class="muted small">after ${esc(st.after)}</span></div>
        <div class="scroll"><table class="timing compact"><thead><tr><th class="r">P</th><th>DRIVER</th><th>TEAM</th><th class="r">WINS</th><th class="r">PTS</th><th class="r">GAP</th>${projHead}</tr></thead><tbody>${dRows}</tbody></table></div>
      </section>
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Constructors' Championship</h2><span class="muted small">after ${esc(st.after)}</span></div>
          <table class="timing compact"><thead><tr><th class="r">P</th><th>TEAM</th><th class="r">WINS</th><th class="r">PTS</th>${projHead}</tr></thead><tbody>${tRows}</tbody></table>
        </section>
        <section class="card">
          <div class="card-head"><h2>Destructors' Championship</h2><span class="muted small">unofficial · just for fun</span></div>
          <p class="muted small">Crashes score 10, a stopped car right before a safety car 8, collisions 6 — found in race control messages${st.incidents?.source ? ` from ${esc(st.incidents.source)}` : ""}. Real repair bills aren't published, so this is the honest version.</p>
          ${destructors}
        </section>
      </div>
    </div>
    <p class="muted small">Standings from ${st.source === "OpenF1" ? "OpenF1 (available minutes after a race; wins from Jolpica)" : "Jolpica (the community-run successor to Ergast) — they update a few hours after each race"}.</p>`;
}
