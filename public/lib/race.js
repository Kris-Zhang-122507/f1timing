import { stewards, driverStewarding } from "./stewards.js?v=mv4vow45";
// Turns raw timing state into what the page shows: a tidy driver list, battles,
// a "what just happened" story and race control messages with plain-English notes.

const TRACK = {
  1: { label: "Track clear", tone: "green" },
  2: { label: "Yellow flag", tone: "yellow" },
  4: { label: "Safety car", tone: "amber" },
  5: { label: "Red flag", tone: "red" },
  6: { label: "Virtual safety car", tone: "amber" },
  7: { label: "VSC ending", tone: "amber" },
};

const num = (v) => {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace("+", ""));
  return Number.isFinite(n) ? n : null;
};

// "1:37.623" -> 97.623
export function lapSeconds(v) {
  const m = String(v ?? "").match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? (Number(m[1] ?? 0) * 60 + Number(m[2])) : null;
}

// How long a lap is taking right now: the median of every running car's most recent lap.
// Using the latest lap (not a "best" pace) means it slows down automatically under a
// safety car or in the rain; a few in/out laps don't move the median.
function referenceLap(rows) {
  const laps = rows.filter((r) => !r.out && !r.inPit).map((r) => lapSeconds(r.last)).filter((s) => s && s > 40 && s < 400).sort((a, b) => a - b);
  if (!laps.length) return null;
  return laps[Math.floor(laps.length / 2)];
}

const list = (v) => (Array.isArray(v) ? v : Object.values(v ?? {}));

// ---------- plain-English notes for FIA race control messages ----------
const RULES = [
  [/CHEQUERED FLAG/, "That's the end of the session."],
  [/VIRTUAL SAFETY CAR ENDING|VSC ENDING/, "Racing resumes in a few seconds — watch for drivers who timed their restart well."],
  [/VIRTUAL SAFETY CAR DEPLOYED|VSC DEPLOYED/, "Everyone slows to a set pace. Pit stops cost roughly half the usual time, so expect a rush into the pits."],
  [/VIRTUAL SAFETY CAR ENDING/, "Racing resumes in a few seconds — watch for drivers who timed their restart well."],
  [/SAFETY CAR DEPLOYED/, "The safety car bunches the field up. Gaps disappear and pit stops become much cheaper."],
  [/SAFETY CAR IN THIS LAP/, "Restart at the end of this lap. The leader controls the pace until then."],
  [/\bRED FLAG/, "Session stopped. Cars return to the pit lane and teams can usually change tyres for free."],
  [/DOUBLE YELLOW/, "Serious hazard: drivers must slow right down, can't overtake, and must be ready to stop."],
  [/YELLOW/, "Hazard on track: no overtaking in that sector."],
  [/CLEAR IN TRACK SECTOR|GREEN LIGHT/, "Hazard cleared — normal racing in that part of the track."],
  [/BLUE FLAG/, "About to be lapped — must let the faster car through."],
  [/DELETED - TRACK LIMITS/, "Lap time removed for going off track. Repeat offenders get a penalty."],
  [/BLACK AND WHITE/, "Final warning for track limits or driving standards. Next one is a penalty."],
  [/(\d+) SECOND TIME PENALTY/, (m) => `${m[1]} seconds added at their next pit stop, or to their race time if they don't stop again.`],
  [/DRIVE THROUGH/, "Must drive through the pit lane without stopping — costs around 20 seconds."],
  [/STOP AND GO/, "Must stop in their pit box for the penalty time without any work on the car."],
  [/UNDER INVESTIGATION/, "Stewards are investigating — a penalty may follow."],
  [/WILL BE INVESTIGATED AFTER THE RACE/, "Decision comes after the chequered flag, so positions could still change."],
  [/NOTED/, "Stewards have seen it. They may or may not investigate."],
  [/NO FURTHER (ACTION|INVESTIGATION)/, "No penalty."],
  [/REVIEWED/, "Stewards looked at it."],
  [/PIT EXIT CLOSED/, "Cars can't leave the pit lane right now."],
  [/PIT EXIT OPEN/, "Cars can leave the pit lane."],
  [/CHEQUERED FLAG/, "That's the end of the session."],
  [/DRS ENABLED/, "Overtaking aids are now allowed."],
  [/DRS DISABLED/, "Overtaking aids switched off — usually for rain or a hazard."],
  [/OVERTAKE ENABLED/, "Overtake mode is switched on: a car within a second of the one ahead gets extra electric power to attack."],
  [/OVERTAKE DISABLED/, "Overtake mode is switched off for now — usually at the start, behind a safety car or for a hazard."],
  [/PIT LANE ENTRY CLOSED/, "Nobody can come in for a pit stop right now."],
  [/PIT LANE ENTRY OPEN/, "Pit stops are allowed again."],
  [/TRACK SURFACE SLIPPERY/, "Oil, water or debris on track — expect drivers to back off there."],
  [/RACE START|SESSION STARTED/, "And they're off."],
  [/RISK OF RAIN/, "Rain expected — tyre choices are about to get interesting."],
];

export function explain(message = "") {
  for (const [re, note] of RULES) {
    const m = message.match(re);
    if (m) return typeof note === "function" ? note(m) : note;
  }
  return "";
}

function categoryOf(m) {
  const t = m.Message ?? "";
  if (/PENALTY|DRIVE THROUGH|STOP AND GO/.test(t)) return "penalty";
  if (/INVESTIGAT|NOTED|REVIEWED/.test(t)) return "investigation";
  if (/TRACK LIMITS|BLACK AND WHITE/.test(t)) return "limits";
  if (m.Category === "Flag" || m.Category === "SafetyCar" || /FLAG|SAFETY CAR|\bVSC\b/.test(t)) return "flag";
  return "other";
}

function flagColour(m) {
  const t = `${m.Flag ?? ""} ${m.Message ?? ""}`;
  if (/CHEQUERED/.test(t)) return "chequered";
  if (/\bRED\b/.test(t)) return "red";
  if (/DOUBLE YELLOW|YELLOW/.test(t)) return "yellow";
  if (/SAFETY CAR|\bVSC\b/.test(t)) return "amber";
  if (/BLUE/.test(t)) return "blue";
  if (/GREEN|CLEAR/.test(t)) return "green";
  if (/PENALTY/.test(t)) return "penalty";
  if (/CHEQUERED/.test(t)) return "chequered";
  return "grey";
}

// ---------- the race model ----------
export class Race {
  constructor(state) {
    this.state = state;
    this.story = [];          // newest last
    this.prev = null;         // previous per-driver snapshot, for change detection
    this.intervalHist = {};   // driver -> interval at end of each of their last laps
    this.lapEvents = {};      // lap -> "sc" | "yellow" | "pits"
    this.pitsThisLap = {};
    this.lastTrack = null;
    this.fastest = null;
    this.now = () => Date.now(); // replays swap this for the recording's clock
    this.lapStart = {};          // driver -> time they last crossed the line
    this.lapHist = {};           // driver -> [{ lap, s (seconds), tyre }]
    this.watchingSince = null;
    this.radioLap = {};          // clip path -> lap it arrived on
    this.pitTimes = {};          // driver -> [{ lap, dur }] pit lane times seen
    this.posHist = {};           // driver -> [{ lap, pos }] position at the end of each lap
    this.pendingOvertakes = [];  // waiting to be sure they weren't just a pit stop
    this.pitAt = {};             // driver -> last time seen in or leaving the pits
    this.secBest = {};           // driver -> [s1, s2, s3] personal bests seen so far
    this.officialOvertakes = false; // replays from OpenF1 carry a list of real overtakes
    this.seenOvertakes = new Set();
    this.seenStops = new Set();
  }

  get lap() {
    return Number(this.state.data.LapCount?.CurrentLap) || 0;
  }

  driverName(n) {
    return this.state.data.DriverList?.[n]?.Tla ?? n;
  }

  add(type, head, body = "", lap = this.lap) {
    // skip duplicates of a recent event (the feed sometimes repeats itself)
    const t = this.now();
    if (this.story.slice(-5).some((e) => e.head === head && t - e.t < 60000)) return;
    this.story.push({ type, head, body, lap, t });
    if (this.story.length > 80) this.story.shift();
  }

  // Call after every message so we can spot what changed.
  update() {
    const d = this.state.data;
    const lines = d.TimingData?.Lines ?? {};
    const track = String(d.TrackStatus?.Status ?? "");
    const lap = this.lap;
    if (this.watchingSince === null && lap > 0) this.watchingSince = lap;

    // pit lane times (PitLaneTimeCollection only holds each driver's latest, so keep a log)
    for (const [n, pt] of Object.entries(d.PitLaneTimeCollection?.PitTimes ?? {})) {
      const dur = parseFloat(pt?.Duration);
      if (!Number.isFinite(dur)) continue;
      const log = (this.pitTimes[n] ??= []);
      const lapNo = Number(pt.Lap) || lap;
      if (!log.some((x) => x.lap === lapNo)) log.push({ lap: lapNo, dur });
    }

    // stationary pit stop times (F1's PitStopSeries topic; replays get it from OpenF1)
    for (const [n, byIdx] of Object.entries(d.PitStopSeries?.PitTimes ?? {})) {
      for (const [k, e] of Object.entries(byIdx ?? {})) {
        const ps = e?.PitStop, stop = parseFloat(ps?.PitStopTime);
        const id = `${n}:${k}`;
        if (!ps || !Number.isFinite(stop) || this.seenStops.has(id)) continue;
        this.seenStops.add(id);
        const lapNo = Number(ps.Lap) || lap;
        const log = (this.pitTimes[n] ??= []);
        const row = log.find((x) => x.lap === lapNo);
        if (row) row.stop = stop; else log.push({ lap: lapNo, dur: parseFloat(ps.PitLaneTime) || null, stop });
      }
    }

    // official overtakes (replays): still held back briefly so pit stop swaps are filtered out
    for (const [k, o] of Object.entries(d.Overtakes?.Overtakes ?? {})) {
      if (this.seenOvertakes.has(k) || !o) continue;
      this.seenOvertakes.add(k);
      this.officialOvertakes = true;
      if (lap > 1) this.pendingOvertakes.push({ a: o.Overtaking, b: o.Overtaken, pos: o.Position, t: this.now(), lap });
    }

    // remember which lap each team radio clip arrived on (the feed only gives a time)
    for (const c of list(d.TeamRadio?.Captures)) if (c?.Path && !(c.Path in this.radioLap)) this.radioLap[c.Path] = lap || null;

    // Track status changes
    if (track && track !== this.lastTrack) {
      if (this.lastTrack !== null) {
        const info = TRACK[track];
        if (track === "4") this.add("sc", "Safety car deployed", "The field bunches up behind the safety car. A pit stop now costs much less time than usual.");
        else if (track === "6") this.add("sc", "Virtual safety car", "Everyone has to slow to a set pace. Cheap pit stop window — watch who dives in.");
        else if (track === "5") this.add("red", "Red flag — session stopped", "Cars head to the pit lane. Teams can usually change tyres without losing places.");
        else if (track === "1" && ["4", "5", "6", "7"].includes(this.lastTrack)) this.add("green", "Green flag — racing resumes", "");
        else if (info && track === "2") this.lapEvents[lap] ??= "yellow";
      }
      if (["4", "6", "7", "5"].includes(track) && lap) this.lapEvents[lap] = "sc";
      this.lastTrack = track;
    }

    // A car slowing into the pit lane loses places a few seconds before it's marked as
    // pitting, so an "overtake" only counts if neither car pits within 25 seconds of it.
    const tNow = this.now();
    for (const [n, l] of Object.entries(lines)) if (l.InPit || l.PitOut) this.pitAt[n] = tNow;
    this.pendingOvertakes = this.pendingOvertakes.filter((o) => {
      if (tNow - o.t < 25000) return true;
      const pitted = [o.a, o.b].some((n) => this.pitAt[n] != null && this.pitAt[n] >= o.t - 30000);
      if (!pitted) this.add("overtake", `${this.driverName(o.a)} passes ${this.driverName(o.b)} for P${o.pos}`, "", o.lap);
      return false;
    });

    // personal best sector times as they happen (F1's own table only arrives now and then)
    for (const [n, l] of Object.entries(lines)) {
      list(l.Sectors).forEach((sec, i) => {
        const v = parseFloat(sec?.Value);
        if (v > 0 && v < 200) { const b = (this.secBest[n] ??= []); if (!(b[i] <= v)) b[i] = v; }
      });
    }

    const now = {};
    for (const [n, l] of Object.entries(lines)) {
      now[n] = {
        pos: Number(l.Position) || 99,
        inPit: !!l.InPit,
        pitOut: !!l.PitOut,
        out: !!(l.Retired || l.Stopped),
        laps: Number(l.NumberOfLaps) || 0,
        stops: Number(l.NumberOfPitStops) || 0,
        lastFastest: !!l.LastLapTime?.OverallFastest,
        last: l.LastLapTime?.Value ?? "",
        interval: num(l.IntervalToPositionAhead?.Value),
      };
    }

    if (this.prev && Object.keys(now).length) {
      const isRace = /Race|Sprint/i.test(d.SessionInfo?.Type ?? d.SessionInfo?.Name ?? "Race") && !/Qualifying/i.test(d.SessionInfo?.Name ?? "");
      for (const [n, c] of Object.entries(now)) {
        const p = this.prev[n];
        if (!p) continue;
        const name = this.driverName(n);

        if (c.inPit && !p.inPit) {
          this.add("pit", `${name} pits from P${p.pos}`, "");
          this.pitsThisLap[lap] = (this.pitsThisLap[lap] ?? 0) + 1;
          if (this.pitsThisLap[lap] >= 3 && !this.lapEvents[lap]) this.lapEvents[lap] = "pits";
        }
        if (c.pitOut && !p.pitOut) {
          const stint = this.currentStint(n);
          const tyre = stint ? `${stint.New === "true" || stint.New === true ? "new" : "used"} ${String(stint.Compound ?? "").toLowerCase()}s` : "new tyres";
          const st = (this.pitTimes[n] ?? []).find((x) => x.stop && Math.abs(x.lap - lap) <= 1)?.stop;
          this.add("pit", `${name} rejoins P${c.pos} on ${tyre}${st ? ` · ${st.toFixed(1)}s stop` : ""}`, "");
        }
        if (c.out && !p.out) this.add("out", `${name} is out of the race`, "");
        if (c.lastFastest && (c.last !== p.last || !p.lastFastest) && c.last && c.last !== this.fastest) {
          this.fastest = c.last;
          this.add("fastest", `Fastest lap: ${name} ${c.last}`, "");
        }
        // Interval history at each lap completion (for battle trends)
        if (c.laps > p.laps) {
          this.lapStart[n] = this.now();
          const ph = (this.posHist[n] ??= []);
          ph.push({ lap: c.laps, pos: c.pos });
          if (ph.length > 90) ph.shift();
          const secs = lapSeconds(c.last);
          if (secs) {
            const hist = (this.lapHist[n] ??= []);
            hist.push({ lap: c.laps, s: secs, tyre: (this.currentStint(n)?.Compound ?? "?").charAt(0) });
            if (hist.length > 80) hist.shift();
          }
        }
        if (c.laps > p.laps && c.interval != null) {
          const h = (this.intervalHist[n] ??= []);
          h.push(c.interval);
          if (h.length > 6) h.shift();
        }
      }

      // Overtakes. F1 sends the two drivers' new positions in separate messages, so we
      // only compare when every position is unique again, against the last such moment.
      const positions = Object.values(now).filter((c) => c.pos < 99).map((c) => c.pos);
      const consistent = new Set(positions).size === positions.length;
      if (consistent) {
        const before = this.lastOrder;
        if (before && isRace && lap > 1) {
          const busy = (n) => now[n].inPit || now[n].pitOut || now[n].out || before[n]?.busy;
          for (const a of Object.keys(now)) {
            for (const b of Object.keys(now)) {
              if (a === b || !before[a] || !before[b] || busy(a) || busy(b)) continue;
              if (!this.officialOvertakes && before[a].pos > before[b].pos && now[a].pos < now[b].pos && now[a].pos === now[b].pos - 1) {
                this.pendingOvertakes.push({ a, b, pos: now[a].pos, t: this.now(), lap });
              }
            }
          }
        }
        this.lastOrder = Object.fromEntries(
          Object.entries(now).map(([n, c]) => [n, { pos: c.pos, busy: c.inPit || c.pitOut || c.out }])
        );
      }
    }
    this.prev = now;
  }

  // What happened on each lap. Rebuilt from race control's full message history (F1 sends
  // all of it when you connect), so a refresh doesn't lose safety cars from earlier laps.
  lapHistory() {
    const out = { ...this.lapEvents };
    const msgs = list(this.state.data.RaceControlMessages?.Messages);
    const total = Number(this.state.data.LapCount?.TotalLaps) || 0;
    const now = this.lap || total;
    let scFrom = null, redFrom = null;
    const mark = (from, to, kind) => { for (let l = Math.max(1, from); l <= Math.min(to, total || to); l++) if (out[l] !== "red") out[l] = kind; };
    for (const m of msgs) {
      const t = String(m?.Message ?? "").toUpperCase();
      const lap = Number(m?.Lap) || null;
      if (!lap) continue;
      if (/SAFETY CAR DEPLOYED|\bVSC DEPLOYED/.test(t)) scFrom ??= lap;
      else if (scFrom != null && /SAFETY CAR IN THIS LAP|VIRTUAL SAFETY CAR ENDING|VSC ENDING|TRACK CLEAR|GREEN LIGHT/.test(t)) { mark(scFrom, lap, "sc"); scFrom = null; }
      if (/\bRED FLAG/.test(t) && !/CHEQUERED/.test(t)) redFrom ??= lap;
      else if (redFrom != null && /GREEN LIGHT|PIT EXIT OPEN|RESUME/.test(t)) { mark(redFrom, lap, "red"); redFrom = null; }
      if (/YELLOW/.test(t) && !/CLEAR/.test(t) && !out[lap]) out[lap] = "yellow";
    }
    if (scFrom != null) mark(scFrom, now, "sc");
    if (redFrom != null) mark(redFrom, now, "red");
    return out;
  }

  currentStint(n) {
    const stints = list(this.state.data.TimingAppData?.Lines?.[n]?.Stints);
    return stints[stints.length - 1];
  }

  // ---------- the compact view sent to browsers ----------
  view() {
    const d = this.state.data;
    const lines = d.TimingData?.Lines ?? {};
    const drivers = d.DriverList ?? {};
    const best = d.TimingStats?.Lines ?? {};

    // Qualifying: which part (Q1/Q2/Q3) and how many cars go through from this part
    const part = Number(d.TimingData?.SessionPart) || 0;
    const noEntries = list(d.TimingData?.NoEntries).map(Number);
    const isQuali = /Qualifying|Shootout/i.test(`${d.SessionInfo?.Type ?? ""} ${d.SessionInfo?.Name ?? ""}`);

    const stewarding = stewards(list(d.RaceControlMessages?.Messages));
    const rows = Object.entries(lines).map(([n, l]) => {
      const info = drivers[n] ?? {};
      const stats = list(l.Stats);
      const partStats = part ? stats[part - 1] : stats[0];
      const partBest = part ? list(l.BestLapTimes)[part - 1]?.Value : null;
      const ts = best[n] ?? {};
      const stints = list(d.TimingAppData?.Lines?.[n]?.Stints);
      const stint = stints[stints.length - 1] ?? {};
      const sectors = list(l.Sectors).map((s) => ({
        v: s?.Value ?? "",
        c: s?.OverallFastest ? "p" : s?.PersonalFastest ? "g" : "",
        seg: list(s?.Segments).map((g) => g?.Status ?? 0),
      }));
      const st = l.Speeds?.ST ?? {};
      return {
        n,
        pos: Number(l.Position) || 99,
        tla: info.Tla ?? n,
        name: info.FullName ?? info.LastName ?? n,
        team: info.TeamName ?? "",
        colour: info.TeamColour ? `#${info.TeamColour}` : "#888",
        gap: l.GapToLeader ?? partStats?.TimeDiffToFastest ?? "",
        int: l.IntervalToPositionAhead?.Value ?? partStats?.TimeDifftoPositionAhead ?? "",
        catching: !!l.IntervalToPositionAhead?.Catching,
        last: l.LastLapTime?.Value ?? "",
        lastC: l.LastLapTime?.OverallFastest ? "p" : l.LastLapTime?.PersonalFastest ? "g" : "",
        best: partBest || l.BestLapTime?.Value || "",
        bestC: best[n]?.PersonalBestLapTime?.Position === 1 ? "p" : "",
        sectors,
        speed: st.Value ?? "",
        speedC: st.OverallFastest ? "p" : st.PersonalFastest ? "g" : "",
        laps: Number(l.NumberOfLaps) || 0,
        stops: Number(l.NumberOfPitStops) || 0,
        inPit: !!l.InPit,
        pitOut: !!l.PitOut,
        out: !!(l.Retired || l.Stopped || d.SessionResult?.Results?.[n]?.Dnf),
        knockedOut: !!l.KnockedOut,
        grid: Number(d.TimingAppData?.Lines?.[n]?.GridPos) || null,
        dsq: !!d.SessionResult?.Results?.[n]?.Dsq,
        tyre: (stint.Compound ?? "").charAt(0) || "?",
        tyreAge: stint.TotalLaps ?? "",
        tyreNew: stint.New === "true" || stint.New === true,
        lapStart: this.lapStart[n] ?? null,
        intHist: this.intervalHist[n] ?? [],
        pitTimes: this.pitTimes[n] ?? [],
        stw: driverStewarding(stewarding, n),
        hist: this.lapHist[n] ?? [],
        posHist: this.posHist[n] ?? [],
        // whole-session bests from TimingStats
        bestSectors: [0, 1, 2].map((i) => list(ts.BestSectors)[i]?.Value || (this.secBest[n]?.[i] ? this.secBest[n][i].toFixed(3) : "")),
        bestSpeeds: { i1: ts.BestSpeeds?.I1?.Value ?? "", i2: ts.BestSpeeds?.I2?.Value ?? "", fl: ts.BestSpeeds?.FL?.Value ?? "", st: ts.BestSpeeds?.ST?.Value ?? "" },
        // laps run in this race on each set = current tyre age minus its age when fitted
        stints: stints.map((s) => ({ c: (s.Compound ?? "?").charAt(0), laps: Math.max(0, (Number(s.TotalLaps) || 0) - (Number(s.StartLaps) || 0)), age: Number(s.TotalLaps) || 0, isNew: s.New === "true" || s.New === true })),
      };
    }).sort((a, b) => a.pos - b.pos);

    // Battles: consecutive cars within a second of each other
    const battles = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const gap = num(b.int);
      if (gap == null || gap >= 1 || a.inPit || b.inPit || a.out || b.out) continue;
      const h = this.intervalHist[b.n] ?? [];
      const trend = h.length >= 2 ? (h[h.length - 1] - h[0]) / (h.length - 1) : null;
      battles.push({ pos: a.pos, chaser: b.tla, chaserColour: b.colour, ahead: a.tla, aheadColour: a.colour, gap, trend, hist: h });
    }

    // Team radio clips are public audio files next to the session's timing data
    const base = d.SessionInfo?.Path ? `https://livetiming.formula1.com/static/${d.SessionInfo.Path}` : null;
    // (replays built from OpenF1 already carry the full address)
    const radio = list(d.TeamRadio?.Captures).filter((c) => /^https?:/.test(c?.Path ?? "") || base).slice(-40).reverse().map((c) => {
      const info = drivers[c.RacingNumber] ?? {};
      return { url: /^https?:/.test(c.Path) ? c.Path : base + c.Path, t: (c.Utc ?? "").slice(11, 19), lap: this.radioLap[c.Path] ?? null, n: c.RacingNumber, tla: info.Tla ?? c.RacingNumber, name: info.FullName ?? "", colour: info.TeamColour ? `#${info.TeamColour}` : "#888" };
    });

    const rcm = list(d.RaceControlMessages?.Messages).slice(-40).reverse().map((m) => ({
      t: (m.Utc ?? "").slice(11, 19),
      lap: m.Lap ?? "",
      text: m.Message ?? "",
      cat: categoryOf(m),
      flag: flagColour(m),
      note: explain(m.Message ?? ""),
    }));

    const clock = d.ExtrapolatedClock ?? {};
    const w = d.WeatherData ?? {};
    const track = String(d.TrackStatus?.Status ?? "1");
    return {
      session: {
        meeting: d.SessionInfo?.Meeting?.Name ?? "",
        name: d.SessionInfo?.Name ?? "",
        type: d.SessionInfo?.Type ?? "",
        status: d.SessionStatus?.Status ?? "",
        circuit: d.SessionInfo?.Meeting?.Circuit?.ShortName ?? "",
      },
      lap: this.lap,
      totalLaps: Number(d.LapCount?.TotalLaps) || 0,
      track: { code: track, ...(TRACK[track] ?? { label: d.TrackStatus?.Message ?? "", tone: "grey" }) },
      clock: { remaining: clock.Remaining ?? "", utc: clock.Utc ?? "", running: !!clock.Extrapolating },
      weather: { air: w.AirTemp ?? "", track: w.TrackTemp ?? "", humidity: w.Humidity ?? "", wind: w.WindSpeed ?? "", rain: w.Rainfall === "1" || w.Rainfall === 1 },
      lapEvents: this.lapHistory(),
      rows,
      battles,
      story: this.story.slice(-40).reverse(),
      stewards: stewarding,
      rcm,
      radio,
      messages: this.state.messages,
      now: this.now(),
      watchingSince: this.watchingSince,
      refLap: referenceLap(rows),
      quali: isQuali ? { part, advance: noEntries[part] ?? null, entries: noEntries } : null,
    };
  }
}
