// Works out how much time a pit stop really costs at each circuit, from the archived races:
// (in-lap + out-lap) minus two normal laps. Stops under a safety car or VSC are measured
// against the cars that stayed out on those same laps, because everyone is slow then.
// Writes public/data/pitloss.json — the site uses it so nobody has to type the number in.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const DIR = "public/data/sessions";
const OUT = "public/data/pitloss.json";
const HIST = "public/data/pitloss-history.json";
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const secs = (s) => { const m = String(s ?? "").match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null; };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export function stopsFromLines(lines) {
  const status = [];               // [ms, code]
  const laps = {};                 // n -> { lap -> { end, t } }
  const pits = {};                 // n -> [{ in, out }]
  for (const l of lines) {
    const ms = Date.parse(l.t);
    if (l.topic === "TrackStatus" && l.data?.Status) status.push([ms, String(l.data.Status)]);
    if (l.topic !== "TimingData") continue;
    for (const [n, d] of Object.entries(l.data?.Lines ?? {})) {
      if (d.NumberOfLaps != null && d.LastLapTime?.Value) {
        const t = secs(d.LastLapTime.Value);
        if (t) (laps[n] ??= {})[d.NumberOfLaps] = { end: ms, t };
      }
      if (d.InPit === true) (pits[n] ??= []).push({ in: ms, out: null });
      if (d.PitOut === true && pits[n]?.length) pits[n][pits[n].length - 1].out ??= ms;
    }
  }
  status.sort((a, b) => a[0] - b[0]);
  // every status seen between two times (including the one already active at the start)
  const during = (a, b) => {
    const seen = new Set();
    let cur = "1";
    for (const [ms, c] of status) { if (ms <= a) cur = c; else if (ms <= b) seen.add(c); else break; }
    seen.add(cur);
    return seen;
  };
  const kindOf = (set) => (set.has("5") ? "red" : set.has("4") ? "sc" : set.has("6") || set.has("7") ? "vsc" : "green");
  // The pit-in moment and the lap line don't line up the same way everywhere (the line can be
  // before or after the pit box), so measure three laps: the one before the stop starts at the
  // last line crossing before entering, and the stop is always inside those three.
  const W = 3;
  const lapsOf = (n) => Object.entries(laps[n] ?? {}).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
  const pitLaps = {};
  for (const [n, list] of Object.entries(pits)) for (const p of list) {
    p.lap = lapsOf(n).filter(([, v]) => v.end <= p.in + 3000).pop()?.[0] ?? null;
    if (p.lap != null) for (let k = 0; k < W; k++) (pitLaps[n] ??= new Set()).add(p.lap + k);
  }
  const span = (n, L) => { const xs = []; for (let k = 0; k < W; k++) { const x = laps[n]?.[L + k]; if (!x) return null; xs.push(x); } return xs; };
  const out = [];
  for (const [n, list] of Object.entries(pits)) for (const p of list) {
    const L = p.lap, xs = L == null ? null : span(n, L), start = laps[n]?.[L];
    if (!xs || L < 2) continue;
    if (list.some((q) => q !== p && Math.abs(q.in - p.in) < 4 * 60000)) continue; // two stops close together
    if (L < 4) continue; // opening laps: changing conditions, no settled pace to compare with
    // a "caution stop" means the whole pit lane visit happened under the SC / VSC
    const window = kindOf(during(start.end, xs[W - 1].end));
    const inLane = during(p.in, p.out ?? p.in + 25000);
    const kind = window === "green" ? "green" : inLane.has("4") && inLane.size === 1 ? "sc" : [...inLane].every((c) => c === "6") ? "vsc" : null;
    if (!kind) continue;
    const mine = xs.reduce((a, x) => a + x.t, 0);
    let ref;
    if (kind === "green") {
      const near = [];
      for (let k = L - 6; k <= L + W + 5; k++) {
        const x = laps[n]?.[k], prev = laps[n]?.[k - 1];
        if (!x || !prev || k < 2 || pitLaps[n]?.has(k)) continue;
        if (kindOf(during(prev.end, x.end)) === "green") near.push(x.t);
      }
      if (near.length < 3) continue;
      ref = W * median(near);
    } else {
      // everyone is slow under a safety car / VSC: compare with cars that stayed out over the same time
      const others = [];
      for (const m of Object.keys(laps)) {
        if (m === n) continue;
        for (const [k, x] of lapsOf(m)) {
          if (Math.abs(x.end - start.end) > 30000) continue;
          const ys = span(m, k);
          if (!ys || [...Array(W).keys()].some((j) => pitLaps[m]?.has(k + j))) continue;
          others.push(ys.reduce((a, y) => a + y.t, 0));
        }
      }
      if (others.length < 3) continue;
      ref = median(others);
    }
    const loss = mine - ref;
    if (loss < 8 || loss > 60) continue; // penalties, damage, drive-throughs…
    out.push({ n, lap: L, kind, loss: r1(loss) });
  }
  return out;
}

// Last season's races (from OpenF1, three small requests each) so circuits that haven't been
// raced yet this year still get a real number. Cached in pitloss-history.json, fetched once.
async function fetchHistory(year, maxRaces) {
  const { openf1, trackFromMessage } = await import("../public/lib/openf1.js");
  const wait = () => new Promise((r) => setTimeout(r, Number(process.env.OPENF1_WAIT ?? 2200)));
  const hist = existsSync(HIST) ? JSON.parse(readFileSync(HIST, "utf8")) : { done: {}, circuits: {} };
  const sessions = [...await openf1(`sessions?year=${year}&session_name=Race`), ...await openf1(`sessions?year=${year}&session_name=Sprint`)]
    .filter((s) => Date.parse(s.date_end) < Date.now() - 3 * 3600e3 && !hist.done[s.session_key]);
  await wait();
  let n = 0;
  for (const s of sessions) {
    if (n++ >= maxRaces) break;
    try {
      const q = `session_key=${s.session_key}`;
      const laps = await openf1(`laps?${q}`); await wait();
      const pits = await openf1(`pit?${q}`); await wait();
      const rcm = await openf1(`race_control?${q}`); await wait();
      const lines = [];
      for (const m of rcm) { const st = trackFromMessage(m.message); if (st) lines.push({ t: m.date, topic: "TrackStatus", data: { Status: st } }); }
      for (const l of laps) if (l.lap_duration && l.date_start) {
        lines.push({ t: new Date(Date.parse(l.date_start) + l.lap_duration * 1000).toISOString(), topic: "TimingData",
          data: { Lines: { [l.driver_number]: { NumberOfLaps: l.lap_number, LastLapTime: { Value: String(l.lap_duration) } } } } });
      }
      for (const p of pits) {
        const at = Date.parse(p.date), dur = (p.pit_duration ?? p.lane_duration ?? 22) * 1000;
        lines.push({ t: p.date, topic: "TimingData", data: { Lines: { [p.driver_number]: { InPit: true } } } });
        lines.push({ t: new Date(at + dur).toISOString(), topic: "TimingData", data: { Lines: { [p.driver_number]: { PitOut: true } } } });
      }
      lines.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      const stops = stopsFromLines(lines);
      const c = (hist.circuits[slug(s.circuit_short_name)] ??= { circuit: s.circuit_short_name, stops: [], sessions: [] });
      c.stops.push(...stops.map((x) => [x.kind, x.loss]));
      c.sessions.push(`${year} ${s.session_name}`);
      hist.done[s.session_key] = true;
      console.log(`${year} ${s.circuit_short_name} ${s.session_name}: ${stops.length} stops`);
    } catch (e) { console.log(`  ${s.circuit_short_name}: ${e.message}`); }
  }
  writeFileSync(HIST, JSON.stringify(hist));
}

function main() {
  const hist = existsSync(HIST) ? JSON.parse(readFileSync(HIST, "utf8")) : { circuits: {} };
  const index = JSON.parse(readFileSync(`${DIR}/index.json`, "utf8"));
  const byCircuit = {};
  for (const s of index.sessions) {
    if (!/^(Race|Sprint)$/.test(s.name)) continue;
    const file = `${DIR}/${s.key}.jsonl.gz`;
    if (!existsSync(file)) continue;
    const lines = gunzipSync(readFileSync(file)).toString("utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x));
    const stops = stopsFromLines(lines);
    const c = (byCircuit[slug(s.circuit)] ??= { circuit: s.circuit, stops: { green: [], sc: [], vsc: [] }, sessions: [] });
    for (const st of stops) c.stops[st.kind].push(st.loss);
    c.sessions.push(`${s.year ?? ""} ${s.name}`.trim());
    console.log(`${s.circuit} ${s.name}: ${stops.length} stops`, Object.fromEntries(["green", "sc", "vsc"].map((k) => [k, r1(median(stops.filter((x) => x.kind === k).map((x) => x.loss)))])));
  }
  // this season's stops come first; last season's fill in where there are only a few
  for (const [k, h] of Object.entries(hist.circuits ?? {})) {
    const c = (byCircuit[k] ??= { circuit: h.circuit, stops: { green: [], sc: [], vsc: [] }, sessions: [] });
    for (const kind of ["green", "sc", "vsc"]) {
      if (c.stops[kind].length >= 8) continue;
      c.stops[kind].push(...h.stops.filter((x) => x[0] === kind).map((x) => x[1]));
    }
    c.sessions.push(...h.sessions);
  }
  const circuits = {};
  for (const [k, c] of Object.entries(byCircuit)) {
    const green = median(c.stops.green);
    if (green == null) continue;
    circuits[k] = {
      circuit: c.circuit, green: r1(green), sc: r1(median(c.stops.sc)), vsc: r1(median(c.stops.vsc)),
      samples: { green: c.stops.green.length, sc: c.stops.sc.length, vsc: c.stops.vsc.length }, sessions: c.sessions,
    };
  }
  // the share of a green-flag stop that a caution stop costs, across every circuit (for tracks with no example yet)
  const ratio = (kind) => {
    const rs = Object.values(circuits).filter((c) => c[kind] && c.samples[kind] >= 2).map((c) => c[kind] / c.green);
    return rs.length >= 3 ? Math.round(median(rs) * 100) / 100 : null;
  };
  // a caution value from one or two stops is too noisy to trust
  for (const c of Object.values(circuits)) for (const kind of ["sc", "vsc"]) if (c.samples[kind] < 3) c[kind] = null;
  const data = { circuits, scRatio: ratio("sc") ?? 0.55, vscRatio: ratio("vsc") ?? 0.65 };
  const prev = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  const next = JSON.stringify(data, null, 1);
  if (prev !== next) writeFileSync(OUT, next);
  console.log(`Pit loss for ${Object.keys(circuits).length} circuits (SC ×${data.scRatio}, VSC ×${data.vscRatio})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const h = process.argv.indexOf("--history");
  if (h > 0) await fetchHistory(Number(process.argv[h + 1]) || new Date().getUTCFullYear() - 1, Number(process.argv[h + 2]) || 30).catch((e) => console.log(`history: ${e.message}`));
  main();
}
