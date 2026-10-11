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

const list = (v) => (Array.isArray(v) ? v : Object.values(v ?? {}));

// ---------- plain-English notes for FIA race control messages ----------
const RULES = [
  [/VIRTUAL SAFETY CAR DEPLOYED/, "Everyone slows to a set pace. Pit stops cost roughly half the usual time, so expect a rush into the pits."],
  [/VIRTUAL SAFETY CAR ENDING/, "Racing resumes in a few seconds — watch for drivers who timed their restart well."],
  [/SAFETY CAR DEPLOYED/, "The safety car bunches the field up. Gaps disappear and pit stops become much cheaper."],
  [/SAFETY CAR IN THIS LAP/, "Restart at the end of this lap. The leader controls the pace until then."],
  [/RED FLAG/, "Session stopped. Cars return to the pit lane and teams can usually change tyres for free."],
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
  if (m.Category === "Flag" || m.Category === "SafetyCar" || /FLAG|SAFETY CAR/.test(t)) return "flag";
  return "other";
}

function flagColour(m) {
  const t = `${m.Flag ?? ""} ${m.Message ?? ""}`;
  if (/RED/.test(t)) return "red";
  if (/DOUBLE YELLOW|YELLOW/.test(t)) return "yellow";
  if (/SAFETY CAR/.test(t)) return "amber";
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
  }

  get lap() {
    return Number(this.state.data.LapCount?.CurrentLap) || 0;
  }

  driverName(n) {
    return this.state.data.DriverList?.[n]?.Tla ?? n;
  }

  add(type, head, body = "") {
    // skip duplicates of a recent event (the feed sometimes repeats itself)
    if (this.story.slice(-5).some((e) => e.head === head && Date.now() - e.t < 60000)) return;
    this.story.push({ type, head, body, lap: this.lap, t: Date.now() });
    if (this.story.length > 80) this.story.shift();
  }

  // Call after every message so we can spot what changed.
  update() {
    const d = this.state.data;
    const lines = d.TimingData?.Lines ?? {};
    const track = String(d.TrackStatus?.Status ?? "");
    const lap = this.lap;

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
          this.add("pit", `${name} rejoins P${c.pos} on ${tyre}`, "");
        }
        if (c.out && !p.out) this.add("out", `${name} is out of the race`, "");
        if (c.lastFastest && (c.last !== p.last || !p.lastFastest) && c.last && c.last !== this.fastest) {
          this.fastest = c.last;
          this.add("fastest", `Fastest lap: ${name} ${c.last}`, "");
        }
        // Interval history at each lap completion (for battle trends)
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
              if (before[a].pos > before[b].pos && now[a].pos < now[b].pos && now[a].pos === now[b].pos - 1) {
                this.add("overtake", `${this.driverName(a)} passes ${this.driverName(b)} for P${now[a].pos}`, "");
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

    const rows = Object.entries(lines).map(([n, l]) => {
      const info = drivers[n] ?? {};
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
        gap: l.GapToLeader ?? l.Stats?.[0]?.TimeDiffToFastest ?? "",
        int: l.IntervalToPositionAhead?.Value ?? l.Stats?.[0]?.TimeDifftoPositionAhead ?? "",
        catching: !!l.IntervalToPositionAhead?.Catching,
        last: l.LastLapTime?.Value ?? "",
        lastC: l.LastLapTime?.OverallFastest ? "p" : l.LastLapTime?.PersonalFastest ? "g" : "",
        best: l.BestLapTime?.Value ?? "",
        bestC: best[n]?.PersonalBestLapTime?.Position === 1 ? "p" : "",
        sectors,
        speed: st.Value ?? "",
        speedC: st.OverallFastest ? "p" : st.PersonalFastest ? "g" : "",
        laps: Number(l.NumberOfLaps) || 0,
        stops: Number(l.NumberOfPitStops) || 0,
        inPit: !!l.InPit,
        pitOut: !!l.PitOut,
        out: !!(l.Retired || l.Stopped),
        knockedOut: !!l.KnockedOut,
        tyre: (stint.Compound ?? "").charAt(0) || "?",
        tyreAge: stint.TotalLaps ?? "",
        tyreNew: stint.New === "true" || stint.New === true,
        stints: stints.map((s) => ({ c: (s.Compound ?? "?").charAt(0), laps: Number(s.TotalLaps) || 0, isNew: s.New === "true" || s.New === true })),
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
      lapEvents: this.lapEvents,
      rows,
      battles,
      story: this.story.slice(-40).reverse(),
      rcm,
      messages: this.state.messages,
    };
  }
}
