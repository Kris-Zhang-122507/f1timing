// Head to head: any two drivers this season (teammates or not) — qualifying and race battles,
// points, wins, podiums, poles, finishes, and round by round. From Jolpica's season results.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const API = "https://api.jolpi.ca/ergast/f1/current";

async function pages(kind, key) {
  const out = [];
  for (let offset = 0; offset < 3000; offset += 100) {
    const r = await fetch(`${API}/${kind}.json?limit=100&offset=${offset}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    for (const race of d.MRData?.RaceTable?.Races ?? []) for (const row of race[key] ?? []) out.push({ round: Number(race.round), race: race.raceName, row });
    if (offset + 100 >= Number(d.MRData?.total ?? 0)) break;
  }
  return out;
}

let cache = null;
export async function loadSeason() {
  if (cache && Date.now() - cache.at < 30 * 60e3) return cache;
  const [results, quali, sprint] = await Promise.all([pages("results", "Results"), pages("qualifying", "QualifyingResults"), pages("sprint", "SprintResults").catch(() => [])]);
  const drivers = new Map();
  const rounds = new Map();
  const get = (row) => {
    const code = row.Driver?.code ?? row.Driver?.driverId;
    if (!drivers.has(code)) drivers.set(code, { code, name: `${row.Driver?.givenName ?? ""} ${row.Driver?.familyName ?? ""}`.trim(), team: row.Constructor?.name ?? "", byRound: {} });
    const d = drivers.get(code);
    if (row.Constructor?.name) d.team = row.Constructor.name;
    return d;
  };
  for (const { round, race, row } of results) {
    rounds.set(round, race);
    const d = get(row);
    const finished = /^(Finished|Lapped|\+\d+ Laps?)$/i.test(row.status ?? "") || /^\d+$/.test(row.positionText ?? "") && !/Retired|Did not|Disqualified/i.test(row.status ?? "");
    Object.assign((d.byRound[round] ??= {}), { race: Number(row.position), raceText: row.positionText, finished, status: row.status, points: Number(row.points) || 0, grid: Number(row.grid) || null });
  }
  for (const { round, race, row } of quali) {
    rounds.set(round, race);
    Object.assign((get(row).byRound[round] ??= {}), { quali: Number(row.position) });
  }
  for (const { round, row } of sprint) {
    const r = (get(row).byRound[round] ??= {});
    r.sprintPoints = Number(row.points) || 0;
    r.sprint = Number(row.position);
  }
  cache = { at: Date.now(), drivers: [...drivers.values()], rounds: [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([round, name]) => ({ round, name })) };
  return cache;
}

function stats(d) {
  const rs = Object.values(d.byRound);
  const fin = rs.filter((r) => r.finished && r.race);
  const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  return {
    points: rs.reduce((a, r) => a + (r.points ?? 0) + (r.sprintPoints ?? 0), 0),
    wins: rs.filter((r) => r.race === 1).length,
    podiums: rs.filter((r) => r.race && r.race <= 3).length,
    poles: rs.filter((r) => r.quali === 1).length,
    best: Math.min(...rs.map((r) => r.race || 99)),
    avgFinish: avg(fin.map((r) => r.race)),
    avgQuali: avg(rs.filter((r) => r.quali).map((r) => r.quali)),
    dnfs: rs.filter((r) => r.race && !r.finished).length,
    starts: rs.filter((r) => r.race).length,
  };
}

// colour for a team name, from the live timing data if we have it, else a fallback table
const TEAM = { mclaren: "#FF8000", mercedes: "#27F4D2", "red bull": "#3671C6", ferrari: "#E8002D", williams: "#1868DB", "racing bulls": "#6692FF", rb: "#6692FF", "aston martin": "#229971", haas: "#B6BABD", alpine: "#FF87BC", audi: "#F50537", sauber: "#F50537", cadillac: "#AAAAAD" };
const teamColour = (team) => { const t = String(team).toLowerCase(); for (const [k, c] of Object.entries(TEAM)) if (t.includes(k)) return c; return "#6B7383"; };

export function renderH2H(season, a, b) {
  if (!season) return `<section class="card"><h2>Head to head</h2><div class="muted small">Loading the season's results…</div></section>`;
  const ds = [...season.drivers].sort((x, y) => stats(y).points - stats(x).points);
  const A = ds.find((d) => d.code === a) ?? ds[0], B = ds.find((d) => d.code === b && d !== A) ?? ds.find((d) => d !== A);
  if (!A || !B) return `<section class="card"><h2>Head to head</h2><div class="muted small">Not enough results yet this season.</div></section>`;
  const opts = (sel) => ds.map((d) => `<option value="${esc(d.code)}" ${d === sel ? "selected" : ""}>${esc(d.code)} — ${esc(d.name)}</option>`).join("");
  const ca = teamColour(A.team), cb = teamColour(B.team);
  const sa = stats(A), sb = stats(B);
  // battles: rounds where both took part
  let qa = 0, qb = 0, ra = 0, rb = 0, both = 0;
  const rows = season.rounds.map(({ round, name }) => {
    const x = A.byRound[round], y = B.byRound[round];
    if (!x && !y) return "";
    let qWin = "", rWin = "";
    if (x?.quali && y?.quali) { if (x.quali < y.quali) { qa++; qWin = "a"; } else { qb++; qWin = "b"; } }
    if (x?.finished && y?.finished) { both++; if (x.race < y.race) { ra++; rWin = "a"; } else { rb++; rWin = "b"; } }
    else if (x?.race && y?.race) rWin = x.finished ? "a" : y.finished ? "b" : "";
    const cell = (r, who, win, kind) => {
      if (!r) return `<td class="muted">—</td>`;
      const v = kind === "q" ? (r.quali ? `P${r.quali}` : "—") : r.race ? (r.finished ? `P${r.race}` : `<span title="${esc(r.status)}">DNF</span>`) : "—";
      return `<td class="num ${win === who ? "h2h-win" : ""}">${v}</td>`;
    };
    return `<tr><td class="muted small">R${round}</td><td class="small">${esc(name.replace(/ Grand Prix$/, ""))}</td>
      ${cell(x, "a", qWin, "q")}${cell(y, "b", qWin, "q")}${cell(x, "a", rWin, "r")}${cell(y, "b", rWin, "r")}</tr>`;
  }).join("");
  const duel = (label, x, y, lowerBetter = false, fmt = (n) => n) => {
    const nx = x ?? 0, ny = y ?? 0;
    const winA = lowerBetter ? (x != null && (y == null || x < y)) : nx > ny;
    const winB = lowerBetter ? (y != null && (x == null || y < x)) : ny > nx;
    const total = lowerBetter ? 1 : Math.max(1, nx + ny);
    const wa = lowerBetter ? (x != null && y != null ? (y / (x + y)) * 100 : 50) : (nx / total) * 100;
    return `<div class="h2h-stat">
        <span class="mono ${winA ? "h2h-win" : ""}">${x == null ? "—" : fmt(x)}</span>
        <div class="h2h-bar"><i style="width:${wa}%;background:${ca}"></i><i style="width:${100 - wa}%;background:${cb}"></i></div>
        <span class="mono ${winB ? "h2h-win" : ""}">${y == null ? "—" : fmt(y)}</span>
        <span class="h2h-label muted small">${label}</span>
      </div>`;
  };
  const one = (n) => n.toFixed(1);
  return `<section class="card h2h">
      <div class="card-head"><h2>Head to head</h2><span class="muted small">any two drivers, this season</span></div>
      <div class="h2h-pick">
        <label><span class="sr">First driver</span><i class="team" style="background:${ca}"></i><select id="h2hA">${opts(A)}</select></label>
        <span class="muted">vs</span>
        <label><span class="sr">Second driver</span><i class="team" style="background:${cb}"></i><select id="h2hB">${opts(B)}</select></label>
      </div>
      <div class="h2h-names"><div><b>${esc(A.name)}</b><span class="muted small">${esc(A.team)}</span></div><div><b>${esc(B.name)}</b><span class="muted small">${esc(B.team)}</span></div></div>
      <div class="h2h-stats">
        ${duel("Qualifying battles", qa, qb)}
        ${duel(`Race battles (both finished, ${both})`, ra, rb)}
        ${duel("Points", sa.points, sb.points)}
        ${duel("Wins", sa.wins, sb.wins)}
        ${duel("Podiums", sa.podiums, sb.podiums)}
        ${duel("Poles", sa.poles, sb.poles)}
        ${duel("Average finish", sa.avgFinish, sb.avgFinish, true, one)}
        ${duel("Average qualifying", sa.avgQuali, sb.avgQuali, true, one)}
        ${duel("Best finish", sa.best < 99 ? sa.best : null, sb.best < 99 ? sb.best : null, true, (n) => `P${n}`)}
        ${duel("Retirements", sa.dnfs, sb.dnfs, true)}
      </div>
      <div class="scroll"><table class="timing compact h2h-rounds"><thead><tr><th></th><th>GRAND PRIX</th><th class="r">${esc(A.code)} QUALI</th><th class="r">${esc(B.code)} QUALI</th><th class="r">${esc(A.code)} RACE</th><th class="r">${esc(B.code)} RACE</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">From Jolpica's official results, updated a few hours after each race. Race battles count only races both drivers finished.</p>
    </section>`;
}
