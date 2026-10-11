// Finds crashes, collisions, spins and stopped cars in a session's race control messages,
// and estimates how hard each crash was from the car's speed data (OpenF1 car_data).
import { openf1 } from "../public/lib/openf1.js";

const KINDS = [
  ["crash", 10, /CRASH|ACCIDENT|HIT THE (WALL|BARRIER)|INTO THE (WALL|BARRIER)/],
  ["collision", 6, /COLLISION|CONTACT|CAUSING A COLLISION/],
  ["stopped", 4, /STOPPED|STATIONARY|RETIRED/],
  ["spin", 2, /SPUN|SPIN\b/],
];

// [{ ms, n, tla, team, colour, kind, points, lap, message }]
export function extractIncidents(lines) {
  const drivers = {};
  const caution = []; // times the track went SC / VSC / red
  const out = [];
  for (const l of lines) {
    const ms = Date.parse(l.t);
    if (l.topic === "DriverList") for (const [n, d] of Object.entries(l.data ?? {})) drivers[n] = { ...(drivers[n] ?? {}), ...d };
    if (l.topic === "TrackStatus" && ["4", "5", "6"].includes(String(l.data?.Status))) caution.push(ms);
    if (l.topic !== "RaceControlMessages") continue;
    for (const m of Object.values(l.data?.Messages ?? {})) {
      const msg = String(m?.Message ?? "").toUpperCase();
      const kind = KINDS.find(([, , re]) => re.test(msg));
      if (!kind || /NO FURTHER|NOT INVESTIGATED|REVIEWED/.test(msg) && kind[0] !== "collision") continue;
      // car numbers appear as "CAR 44 (HAM)" or "CARS 1 (VER) AND 4 (NOR)"
      const cars = [...msg.matchAll(/\b(\d{1,2}) \(([A-Z]{3})\)/g)].map((x) => x[1]);
      if (!cars.length && m?.RacingNumber) cars.push(String(m.RacingNumber));
      for (const n of cars) out.push({ ms: Date.parse(m.Utc ?? l.t) || ms, n, kind: kind[0], points: kind[1], lap: m.Lap ?? null, message: m.Message });
    }
  }
  // a car stopping right before a safety car / red flag was very likely a crash
  for (const i of out) {
    if (i.kind === "stopped" && caution.some((t) => t >= i.ms - 60000 && t <= i.ms + 120000)) { i.kind = "crash"; i.points = 8; i.likely = true; }
  }
  // the same car + kind reported several times within a few minutes counts once
  const seen = [];
  const unique = out.sort((a, b) => a.ms - b.ms).filter((i) => {
    if (seen.some((s) => s.n === i.n && s.kind === i.kind && i.ms - s.ms < 5 * 60000)) return false;
    seen.push(i);
    return true;
  });
  return unique.map((i) => {
    const d = drivers[i.n] ?? {};
    return { ...i, t: new Date(i.ms).toISOString(), tla: d.Tla ?? i.n, team: d.TeamName ?? "", colour: d.TeamColour ? `#${d.TeamColour}` : "#888888" };
  });
}

// Look at the 90 seconds before race control reported it: find where the car came to a halt
// (or slowed hardest) and estimate the peak deceleration in g.
export async function analyseCrash(sessionKey, inc) {
  const from = new Date(inc.ms - 90000).toISOString(), to = new Date(inc.ms + 5000).toISOString();
  const rows = await openf1(`car_data?session_key=${sessionKey}&driver_number=${inc.n}&date>=${from}&date<=${to}`);
  if (rows.length < 20) return null;
  const pts = rows.map((r) => ({ ms: Date.parse(r.date), v: r.speed ?? 0, brake: r.brake ? 1 : 0, throttle: r.throttle ?? 0 }));
  // where the car first sits at (nearly) zero for a couple of seconds
  let stop = pts.findIndex((p, i) => p.v < 15 && pts.slice(i, i + 8).every((q) => q.v < 15));
  if (stop < 0) stop = pts.length - 1;
  let peak = 0, at = stop;
  for (let i = Math.max(1, stop - 60); i <= stop; i++) {
    const dt = (pts[i].ms - pts[i - 1].ms) / 1000;
    if (dt <= 0 || dt > 1.5) continue;
    const decel = (pts[i - 1].v - pts[i].v) / 3.6 / dt / 9.81;
    if (decel > peak) { peak = decel; at = i; }
  }
  const window = pts.slice(Math.max(0, at - 40), Math.min(pts.length, at + 12));
  const t0 = pts[at].ms;
  return {
    peakG: Math.round(peak * 10) / 10,
    speedBefore: Math.max(...pts.slice(Math.max(0, at - 6), at + 1).map((p) => p.v)),
    stoppedFully: stop < pts.length - 1,
    trace: window.map((p) => [Math.round((p.ms - t0) / 100) / 10, p.v, p.brake]),
  };
}
