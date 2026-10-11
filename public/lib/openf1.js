// Builds a replay (the same message format as F1's live feed, so the whole site works on it)
// from OpenF1's free historical API. Runs in Node (the archive job) and in browsers.
//
// OpenF1 gives per-lap and per-event data rather than F1's raw stream, so we rebuild the
// stream: positions, gaps, lap and sector times, minisectors, tyres, pit stops, race control
// messages, team radio and weather, each at the moment it happened.

const API = (typeof process !== "undefined" && process.env?.OPENF1_API) || "https://api.openf1.org/v1/";

export async function openf1(path, fetchFn = fetch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetchFn(API + path);
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 2500 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`OpenF1 ${path.split("?")[0]}: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`OpenF1 ${path.split("?")[0]}: rate limited`);
}

const lapStr = (s) => {
  if (s == null || !Number.isFinite(s)) return "";
  const m = Math.floor(s / 60), r = s - m * 60;
  return m ? `${m}:${r.toFixed(3).padStart(6, "0")}` : r.toFixed(3);
};
const gapStr = (g) => {
  if (g == null) return "";
  if (typeof g === "string") { const m = g.match(/(\d+)\s*LAP/i); return m ? `${m[1]} L` : g; }
  return `+${g.toFixed(3)}`;
};
const iso = (ms) => new Date(ms).toISOString();

function trackFromMessage(msg) {
  const t = String(msg ?? "").toUpperCase();
  if (/RED FLAG/.test(t)) return "5";
  if (/VIRTUAL SAFETY CAR ENDING|VSC ENDING/.test(t)) return "7";
  if (/VIRTUAL SAFETY CAR DEPLOYED|VSC DEPLOYED/.test(t)) return "6";
  if (/SAFETY CAR DEPLOYED/.test(t)) return "4";
  if (/TRACK CLEAR|GREEN LIGHT|ALL CLEAR/.test(t)) return "1";
  return null;
}

// fetchFn lets the archive job add its own headers/retries; `wait` spaces requests out
// to stay inside OpenF1's free limit (30 requests a minute).
export async function buildReplay(sessionKey, { fetchFn = fetch, wait = (typeof process !== "undefined" && process.env?.OPENF1_WAIT ? Number(process.env.OPENF1_WAIT) : 2200), log = () => {} } = {}) {
  const pause = () => new Promise((r) => setTimeout(r, wait));
  const get = async (ep, extra = "") => { const d = await openf1(`${ep}?session_key=${sessionKey}${extra}`, fetchFn); await pause(); return d; };

  const [session] = await get("sessions");
  if (!session) throw new Error(`No session ${sessionKey}`);
  log(`  ${session.country_name} ${session.session_name}`);
  const drivers = await get("drivers");
  const laps = await get("laps");
  const positions = await get("position");
  const isRace = /Race/i.test(session.session_type);
  const intervals = isRace ? await get("intervals") : [];
  const stints = await get("stints");
  const pits = await get("pit");
  const rcm = await get("race_control");
  const radio = await get("team_radio");
  const weather = await get("weather");

  const start = Date.parse(session.date_start), end = Date.parse(session.date_end);
  const ev = []; // { ms, topic, data }
  const at = (ms, topic, data) => { if (Number.isFinite(ms)) ev.push({ ms, topic, data }); };

  // --- who's driving ---
  const driverList = {};
  for (const d of drivers) {
    driverList[d.driver_number] = { RacingNumber: String(d.driver_number), Tla: d.name_acronym, FullName: d.full_name, LastName: d.last_name, TeamName: d.team_name, TeamColour: d.team_colour ?? "888888" };
  }
  const totalLaps = isRace ? Math.max(0, ...laps.map((l) => l.lap_number || 0)) : 0;
  at(start - 60000, "SessionInfo", { Meeting: { Name: session.meeting_name ?? `${session.country_name} Grand Prix`, Circuit: { ShortName: session.circuit_short_name } }, Name: session.session_name, Type: session.session_type, Path: "" });
  at(start - 60000, "DriverList", driverList);
  at(start - 60000, "TrackStatus", { Status: "1", Message: "AllClear" });
  at(start - 60000, "SessionStatus", { Status: "Inactive" });
  if (isRace) at(start - 60000, "LapCount", { CurrentLap: 1, TotalLaps: totalLaps });
  at(start, "SessionStatus", { Status: "Started" });
  at(end, "SessionStatus", { Status: "Finished" });

  // --- positions and gaps ---
  for (const p of positions) at(Date.parse(p.date), "TimingData", { Lines: { [p.driver_number]: { Position: String(p.position) } } });
  for (const g of intervals) {
    at(Date.parse(g.date), "TimingData", { Lines: { [g.driver_number]: {
      GapToLeader: g.gap_to_leader === 0 ? "" : gapStr(g.gap_to_leader),
      IntervalToPositionAhead: { Value: g.interval === 0 || g.interval == null ? "" : gapStr(g.interval) },
    } } });
  }

  // --- laps: sector times as they're completed, then the lap time at the line ---
  const bestLap = {}, bestSec = {}, overallSec = [Infinity, Infinity, Infinity];
  let overallLap = Infinity, leaderLap = 0;
  const lapsSorted = [...laps].filter((l) => l.date_start).sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
  for (const l of lapsSorted) {
    const n = l.driver_number, t0 = Date.parse(l.date_start);
    const secs = [l.duration_sector_1, l.duration_sector_2, l.duration_sector_3];
    const segs = [l.segments_sector_1, l.segments_sector_2, l.segments_sector_3];
    let acc = 0;
    secs.forEach((s, i) => {
      if (s == null) return;
      acc += s;
      const pb = !(bestSec[n]?.[i] <= s), ob = s < overallSec[i];
      if (pb) (bestSec[n] ??= [])[i] = s;
      if (ob) overallSec[i] = s;
      const sector = { Value: s.toFixed(3), PersonalFastest: pb, OverallFastest: ob };
      if (Array.isArray(segs[i])) sector.Segments = segs[i].map((st) => ({ Status: st ?? 0 }));
      // at the start of a new lap the other sectors' minisectors reset
      const update = { Sectors: { [i]: sector } };
      if (i === 0) update.Sectors = { 0: sector, 1: { Value: "", Segments: (segs[1] ?? []).map(() => ({ Status: 0 })) }, 2: { Value: "", Segments: (segs[2] ?? []).map(() => ({ Status: 0 })) } };
      at(t0 + acc * 1000, "TimingData", { Lines: { [n]: update } });
    });
    if (l.lap_duration) {
      const tEnd = t0 + l.lap_duration * 1000;
      const pb = !(bestLap[n] <= l.lap_duration), ob = l.lap_duration < overallLap;
      if (pb) bestLap[n] = l.lap_duration;
      if (ob) overallLap = l.lap_duration;
      const line = { NumberOfLaps: l.lap_number, LastLapTime: { Value: lapStr(l.lap_duration), PersonalFastest: pb, OverallFastest: ob } };
      if (pb) line.BestLapTime = { Value: lapStr(l.lap_duration), Lap: l.lap_number };
      const speeds = {};
      if (l.i1_speed) speeds.I1 = { Value: String(l.i1_speed) };
      if (l.i2_speed) speeds.I2 = { Value: String(l.i2_speed) };
      if (l.st_speed) speeds.ST = { Value: String(l.st_speed) };
      if (Object.keys(speeds).length) line.Speeds = speeds;
      at(tEnd, "TimingData", { Lines: { [n]: line } });
      if (isRace && l.lap_number >= leaderLap) {
        leaderLap = l.lap_number;
        at(tEnd + 1, "LapCount", { CurrentLap: Math.min(totalLaps, l.lap_number + 1), TotalLaps: totalLaps });
      }
    } else if (l.lap_number) {
      at(t0, "TimingData", { Lines: { [n]: { NumberOfLaps: l.lap_number - 1 } } });
    }
  }
  // session bests for the Compare tab / timing insights (sent once at the end; good enough for replays)
  const stats = {};
  for (const [n, s] of Object.entries(bestSec)) stats[n] = { BestSectors: s.map((x) => ({ Value: x != null ? x.toFixed(3) : "" })), PersonalBestLapTime: { Value: lapStr(bestLap[n]) } };
  at(end, "TimingStats", { Lines: stats });

  // --- tyres: each stint appears when it starts, and ages lap by lap ---
  const lapEnd = {};
  for (const l of lapsSorted) if (l.lap_duration) (lapEnd[l.driver_number] ??= {})[l.lap_number] = Date.parse(l.date_start) + l.lap_duration * 1000;
  for (const s of stints) {
    const n = s.driver_number, k = (s.stint_number ?? 1) - 1;
    const startAge = s.tyre_age_at_start ?? 0;
    const firstLap = s.lap_start ?? 1;
    const t = k === 0 ? start - 30000 : (lapEnd[n]?.[firstLap - 1] ?? start);
    at(t, "TimingAppData", { Lines: { [n]: { Stints: { [k]: { Compound: s.compound ?? "UNKNOWN", New: startAge === 0 ? "true" : "false", StartLaps: startAge, TotalLaps: startAge } } } } });
    for (let lap = firstLap; lap <= (s.lap_end ?? firstLap); lap++) {
      const te = lapEnd[n]?.[lap];
      if (te) at(te + 2, "TimingAppData", { Lines: { [n]: { Stints: { [k]: { TotalLaps: startAge + (lap - firstLap + 1) } } } } });
    }
  }

  // --- pit stops ---
  const stopCount = {};
  for (const p of [...pits].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    const n = p.driver_number, t = Date.parse(p.date);
    stopCount[n] = (stopCount[n] ?? 0) + 1;
    const dur = p.pit_duration ?? p.lane_duration ?? 22;
    at(t, "TimingData", { Lines: { [n]: { InPit: true, PitOut: false, NumberOfPitStops: stopCount[n] } } });
    at(t + dur * 1000, "TimingData", { Lines: { [n]: { InPit: false, PitOut: true } } });
    at(t + dur * 1000 + 15000, "TimingData", { Lines: { [n]: { PitOut: false } } });
    at(t + dur * 1000, "PitLaneTimeCollection", { PitTimes: { [n]: { RacingNumber: String(n), Duration: String(dur), Lap: String(p.lap_number ?? "") } } });
  }

  // --- race control, and the track status that goes with it ---
  rcm.forEach((m, i) => {
    const t = Date.parse(m.date);
    at(t, "RaceControlMessages", { Messages: { [i]: { Utc: m.date, Lap: m.lap_number, Category: m.category, Flag: m.flag, Scope: m.scope, Sector: m.sector, RacingNumber: m.driver_number ? String(m.driver_number) : undefined, Message: m.message } } });
    const s = trackFromMessage(m.message);
    if (s) at(t, "TrackStatus", { Status: s, Message: m.message });
    if (/RETIRED|STOPPED/i.test(m.message ?? "") && m.driver_number) at(t, "TimingData", { Lines: { [m.driver_number]: { Retired: true } } });
  });

  // --- team radio (OpenF1 gives the full audio address) ---
  radio.forEach((c, i) => at(Date.parse(c.date), "TeamRadio", { Captures: { [i]: { Utc: c.date, RacingNumber: String(c.driver_number), Path: c.recording_url } } }));

  // --- weather ---
  for (const w of weather) {
    at(Date.parse(w.date), "WeatherData", { AirTemp: String(w.air_temperature), TrackTemp: String(w.track_temperature), Humidity: String(w.humidity), WindSpeed: String(w.wind_speed), Rainfall: w.rainfall ? "1" : "0" });
  }

  ev.sort((a, b) => a.ms - b.ms);
  return {
    session,
    laps,
    lines: ev.map((e) => ({ t: iso(e.ms), topic: e.topic, data: e.data })),
  };
}

// Each driver's fastest lap, as { driver, lap, start (ms), seconds }.
export function fastestLaps(laps) {
  const best = {};
  for (const l of laps) {
    if (!l.lap_duration || !l.date_start || l.is_pit_out_lap) continue;
    if (!best[l.driver_number] || l.lap_duration < best[l.driver_number].seconds) {
      best[l.driver_number] = { driver: l.driver_number, lap: l.lap_number, start: Date.parse(l.date_start), seconds: l.lap_duration };
    }
  }
  return Object.values(best);
}

const range = (a, b) => `&date>=${new Date(a).toISOString()}&date<=${new Date(b).toISOString()}`;

// Circuit outline from one clean lap of car positions: [[x, y], …] starting at the line.
export async function trackOutline(sessionKey, lap, { fetchFn = fetch } = {}) {
  const pts = await openf1(`location?session_key=${sessionKey}&driver_number=${lap.driver}${range(lap.start, lap.start + lap.seconds * 1000)}`, fetchFn);
  const xy = pts.filter((p) => p.x || p.y).map((p) => [p.x, p.y]);
  if (xy.length < 50) return null;
  // thin to ~400 points and normalise into a 0–1000 box, keeping the shape's proportions
  const step = Math.max(1, Math.floor(xy.length / 400));
  const thin = xy.filter((_, i) => i % step === 0);
  const xs = thin.map((p) => p[0]), ys = thin.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const scale = 1000 / Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
  return thin.map(([x, y]) => [Math.round((x - minX) * scale), Math.round((Math.max(...ys) - y) * scale)]);
}

// Speed / throttle / brake / gear along a driver's fastest lap, ~250 samples, with distance.
export async function lapTelemetry(sessionKey, lap, { fetchFn = fetch } = {}) {
  const rows = await openf1(`car_data?session_key=${sessionKey}&driver_number=${lap.driver}${range(lap.start, lap.start + lap.seconds * 1000)}`, fetchFn);
  if (rows.length < 20) return null;
  let dist = 0, prev = null;
  const all = rows.map((r) => {
    const t = Date.parse(r.date);
    if (prev) dist += ((prev.speed + r.speed) / 2 / 3.6) * ((t - prev.t) / 1000);
    prev = { t, speed: r.speed };
    return { d: Math.round(dist), speed: r.speed, throttle: r.throttle, brake: r.brake ? 1 : 0, gear: r.n_gear };
  });
  const step = Math.max(1, Math.floor(all.length / 250));
  const s = all.filter((_, i) => i % step === 0);
  return { lap: lap.lap, time: lap.seconds, d: s.map((x) => x.d), speed: s.map((x) => x.speed), throttle: s.map((x) => x.throttle), brake: s.map((x) => x.brake), gear: s.map((x) => x.gear) };
}
