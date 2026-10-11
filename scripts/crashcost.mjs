// Crash cost estimates for the Destructors' Championship.
//
// Teams don't publish repair bills, so this is an honest estimate built from what the timing
// data shows, per incident:
//   • a car that stopped for good just before a safety car / VSC / red flag (and race control
//     reported an incident involving it, or the red flag came out) — a crash; the bigger the
//     neutralisation, the bigger the damage tier
//   • a collision race control noted, followed by a pit stop within 3 laps — front wing and nose
//   • a collision followed by retirement within 5 laps — wing, nose, suspension and floor
//   • any other noted collision — minor bodywork
// Part prices are rough public estimates (USD), listed in the output so the page can show them.
//
//   node scripts/crashcost.mjs     reads public/data/sessions, writes public/data/crashcost.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { extractIncidents } from "./incidents.mjs";

const DIR = "public/data/sessions";
const OUT = "public/data/crashcost.json";

export const PRICES = {
  "Front wing": 150000,
  "Nose": 60000,
  "Front suspension": 90000,
  "Floor": 250000,
  "Sidepod & bodywork": 60000,
  "Rear suspension": 90000,
  "Rear wing": 85000,
  "Gearbox": 400000,
  "Chassis": 650000,
};
const TIERS = {
  contact: { label: "Contact — minor bodywork", parts: { "Sidepod & bodywork": 0.5 } },
  wing: { label: "Front wing change", parts: { "Front wing": 1, "Nose": 1 } },
  damaged: { label: "Retired with damage", parts: { "Front wing": 1, "Nose": 1, "Front suspension": 1, "Floor": 1 } },
  light: { label: "Crash (VSC)", parts: { "Front wing": 1, "Nose": 1, "Front suspension": 1, "Floor": 0.5 } },
  medium: { label: "Crash (safety car)", parts: { "Front wing": 1, "Nose": 1, "Front suspension": 2, "Floor": 1, "Sidepod & bodywork": 1, "Rear wing": 0.5 } },
  heavy: { label: "Big crash (red flag)", parts: { "Front wing": 1, "Nose": 1, "Front suspension": 2, "Floor": 1, "Sidepod & bodywork": 1, "Rear suspension": 2, "Rear wing": 1, "Gearbox": 1, "Chassis": 0.5 } },
};
const RANK = ["contact", "wing", "light", "damaged", "medium", "heavy"];

function priced(tier) {
  const parts = Object.entries(TIERS[tier].parts).map(([p, k]) => ({ part: p, cost: Math.round(PRICES[p] * k) }));
  return { parts, cost: parts.reduce((a, p) => a + p.cost, 0) };
}

export function crashesFromLines(lines) {
  const drivers = {}, lapEnds = {}, pitIns = {}, retiredAt = {}, status = [], incidentMsgs = [];
  let result = null;
  for (const l of lines) {
    const ms = Date.parse(l.t);
    if (l.topic === "DriverList") for (const [n, d] of Object.entries(l.data ?? {})) drivers[n] = { ...(drivers[n] ?? {}), ...d };
    if (l.topic === "TrackStatus" && l.data?.Status) status.push([ms, String(l.data.Status)]);
    if (l.topic === "SessionResult") result = l.data?.Results ?? null;
    if (l.topic === "RaceControlMessages") for (const m of Object.values(l.data?.Messages ?? {})) {
      const msg = String(m?.Message ?? "").toUpperCase();
      if (/INCIDENT|COLLISION|CONTACT/.test(msg)) incidentMsgs.push({ ms: Date.parse(m.Utc ?? l.t) || ms, cars: [...msg.matchAll(/\b(\d{1,2}) \([A-Z]{3}\)/g)].map((x) => x[1]) });
    }
    if (l.topic !== "TimingData") continue;
    for (const [n, d] of Object.entries(l.data?.Lines ?? {})) {
      if (d.NumberOfLaps != null && d.LastLapTime?.Value) (lapEnds[n] ??= []).push({ lap: Number(d.NumberOfLaps), ms });
      if (d.InPit === true) (pitIns[n] ??= []).push(ms);
      if (d.Retired === true) retiredAt[n] ??= ms;
    }
  }
  const lapAt = (n, ms) => { let lap = 0; for (const e of lapEnds[n] ?? []) if (e.ms <= ms) lap = e.lap; return lap + 1; };
  const lastLap = (n) => (lapEnds[n] ?? []).at(-1);
  // a car "didn't finish" if it was classified DNF, or stopped well short of the winner's lap count
  const maxLap = Math.max(0, ...Object.values(lapEnds).map((xs) => xs.at(-1)?.lap ?? 0));
  const dnf = (n) => (lastLap(n)?.lap ?? 0) < maxLap - 1 && (!!(result?.[n]?.Dnf) || retiredAt[n] != null || !result);
  const out = new Map(); // n -> worst incident for that car in this session, keyed by n + time bucket
  const put = (n, ms, tier, evidence) => {
    const key = `${n}:${Math.floor(ms / 600000)}`;
    const prev = out.get(key);
    if (prev && RANK.indexOf(prev.tier) >= RANK.indexOf(tier)) return;
    out.set(key, { n, ms, tier, evidence });
  };

  // 1) cars that stopped for good right before a neutralisation
  status.forEach(([ms, code], i) => {
    const before = status[i - 1]?.[1];
    if (!["4", "5", "6"].includes(code) || ["4", "5", "6"].includes(before)) return;
    const tier = code === "5" ? "heavy" : code === "4" ? "medium" : "light";
    for (const n of Object.keys(lapEnds)) {
      const last = lastLap(n);
      if (!last || last.ms < ms - 180000 || last.ms > ms + 20000) continue;
      // it never completed another lap (or was classified as not finishing)
      const stoppedHere = !(lapEnds[n] ?? []).some((e) => e.ms > ms + 20000) && (dnf(n) || code === "5");
      if (!stoppedHere) continue;
      const reported = incidentMsgs.some((m) => m.cars.includes(n) && Math.abs(m.ms - ms) < 300000);
      if (code === "6" && !reported) continue; // a car stopping under VSC on its own is usually a failure, not a crash
      put(n, ms, tier, `${code === "5" ? "Red flag" : code === "4" ? "Safety car" : "VSC"} on lap ${lapAt(n, ms)}${reported ? " after a reported incident" : ""}, car didn't continue`);
    }
  });

  // 2) noted collisions: what happened to the car afterwards?
  for (const inc of extractIncidents(lines)) {
    if (inc.kind !== "collision" && inc.kind !== "crash") continue;
    const n = inc.n, lap = Number(inc.lap) || lapAt(n, inc.ms);
    const laterLaps = (lapEnds[n] ?? []).filter((e) => e.ms > inc.ms);
    const retiredSoon = dnf(n) && laterLaps.length <= 5;
    const pittedSoon = (pitIns[n] ?? []).some((t) => t >= inc.ms - 60000 && lapAt(n, t) <= lap + 3);
    if (retiredSoon) put(n, inc.ms, "damaged", `Collision on lap ${lap}, retired ${laterLaps.length ? `${laterLaps.length} lap${laterLaps.length > 1 ? "s" : ""} later` : "straight away"}`);
    else if (pittedSoon) put(n, inc.ms, "wing", `Collision on lap ${lap}, pitted within 3 laps`);
    else put(n, inc.ms, "contact", `Collision on lap ${lap}, carried on`);
  }

  // a car can only be wrecked once per session: keep its worst "didn't continue" incident,
  // and drop anything recorded after it
  const ended = {};
  for (const c of out.values()) if (["damaged", "light", "medium", "heavy"].includes(c.tier)) {
    const e = ended[c.n];
    if (!e || RANK.indexOf(c.tier) > RANK.indexOf(e.tier)) ended[c.n] = c;
  }
  const kept = [...out.values()].filter((c) => {
    const e = ended[c.n];
    if (!e) return true;
    if (["damaged", "light", "medium", "heavy"].includes(c.tier)) return c === e;
    return c.ms < e.ms - 60000;
  });
  return kept.map((c) => {
    const d = drivers[c.n] ?? {};
    return { n: c.n, tla: d.Tla ?? c.n, name: d.FullName ?? "", team: d.TeamName ?? "", colour: d.TeamColour ? `#${d.TeamColour}` : "#888888", t: new Date(c.ms).toISOString(), lap: lapAt(c.n, c.ms), tier: c.tier, label: TIERS[c.tier].label, evidence: c.evidence, ...priced(c.tier) };
  });
}

function main() {
  const index = JSON.parse(readFileSync(`${DIR}/index.json`, "utf8"));
  const crashes = [];
  for (const s of [...index.sessions].sort((a, b) => (a.startUtc ?? "").localeCompare(b.startUtc ?? ""))) {
    const file = `${DIR}/${s.file}`;
    if (!existsSync(file)) continue;
    const lines = gunzipSync(readFileSync(file)).toString("utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x));
    for (const c of crashesFromLines(lines)) crashes.push({ key: s.key, meeting: s.meeting, location: s.location, session: s.name, date: s.startUtc, ...c });
  }
  const data = { prices: PRICES, tiers: Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, { label: v.label, ...priced(k) }])), sessions: index.sessions.length, crashes };
  const next = JSON.stringify(data);
  if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== next) writeFileSync(OUT, next);
  const total = crashes.reduce((a, c) => a + c.cost, 0);
  console.log(`Crash cost: ${crashes.length} incidents, about $${(total / 1e6).toFixed(1)}M (${crashes.filter((c) => !["contact"].includes(c.tier)).length} with real damage)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
