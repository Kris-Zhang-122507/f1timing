// Replay player: plays a recording (ours or an archived session) through the same timing
// engine as live data, with pause, speed, seeking, stream sync and a spoiler shield.

export function parseRecording(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let m;
    try { m = JSON.parse(raw); } catch { continue; }
    const ms = Date.parse(m.t);
    if (!Number.isFinite(ms)) continue;
    // older recordings start with one combined snapshot line — split it into topics
    if (m.snapshot) { for (const [topic, data] of Object.entries(m.snapshot)) lines.push({ ms, topic, data }); }
    else if (m.topic) lines.push({ ms, topic: m.topic, data: m.data });
  }
  lines.sort((a, b) => a.ms - b.ms);
  spreadMinisectors(lines);
  qualiParts(lines);
  // Clean up two quirks in older replay files: a lap counter that briefly goes backwards,
  // and the chequered flag being mistaken for a red flag.
  let maxLap = 0;
  return lines.filter((l) => {
    if (l.topic === "LapCount" && l.data?.CurrentLap != null) {
      if (l.data.CurrentLap < maxLap) return false;
      maxLap = l.data.CurrentLap;
    }
    if (l.topic === "TrackStatus" && String(l.data?.Status) === "5" && /CHEQUERED/i.test(l.data?.Message ?? "")) return false;
    return true;
  });
}

// Archived replays (built from OpenF1) only know each sector's minisectors once the sector is
// finished, so they'd all light up at once. Live F1 fills them in one by one as the car goes
// round — so spread them out across the sector's time. Recordings of live sessions already
// have them one by one (sent as small updates), and are left alone.
function spreadMinisectors(lines) {
  const live = lines.some((l) => l.topic === "TimingData" && Object.values(l.data?.Lines ?? {}).some((d) =>
    Object.values(d?.Sectors ?? {}).some((sec) => sec?.Segments && !Array.isArray(sec.Segments))));
  if (live) return;
  const extra = [];
  for (const l of lines) {
    if (l.topic !== "TimingData") continue;
    for (const [n, d] of Object.entries(l.data?.Lines ?? {})) {
      for (const [i, sec] of Object.entries(d?.Sectors ?? {})) {
        const v = parseFloat(sec?.Value);
        const segs = sec?.Segments;
        if (!Array.isArray(segs) || !segs.length || !(v > 0) || segs.every((g) => !g?.Status)) continue;
        const start = l.ms - v * 1000, k = segs.length;
        // this sector's minisectors start empty, then fill in left to right
        extra.push({ ms: start + 1, topic: "TimingData", data: { Lines: { [n]: { Sectors: { [i]: { Segments: segs.map(() => ({ Status: 0 })) } } } } } });
        for (let j = 0; j < k - 1; j++) {
          extra.push({ ms: start + ((j + 1) / k) * v * 1000, topic: "TimingData", data: { Lines: { [n]: { Sectors: { [i]: { Segments: { [j]: { Status: segs[j]?.Status ?? 0 } } } } } } } });
        }
      }
    }
  }
  if (!extra.length) return;
  lines.push(...extra);
  lines.sort((a, b) => a.ms - b.ms);
}

// Archived qualifying replays don't say which part (Q1/Q2/Q3) is running or who was knocked
// out, so the knockout zone can't be drawn. Work it out: each part ends with a chequered flag
// and the next starts at the following green light; the slowest cars in a part are out.
function qualiParts(lines) {
  const info = lines.find((l) => l.topic === "SessionInfo")?.data;
  if (!/Qualifying|Shootout/i.test(`${info?.Type ?? ""} ${info?.Name ?? ""}`)) return;
  if (lines.some((l) => l.topic === "TimingData" && l.data?.SessionPart != null)) return; // already there (live recording)
  const drivers = new Set();
  for (const l of lines) if (l.topic === "DriverList") for (const n of Object.keys(l.data ?? {})) drivers.add(n);
  const N = drivers.size || 20;
  const advance = N >= 22 ? [N, 16, 10] : N >= 20 ? [N, 15, 10] : [N, Math.round(N * 0.75), 10];
  const time = (v) => { const m = String(v ?? "").match(/^(?:(\d+):)?(\d+\.\d+)$/); return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null; };
  const extra = [];
  const first = lines.find((l) => l.topic === "SessionInfo")?.ms ?? lines[0].ms;
  extra.push({ ms: first + 1, topic: "TimingData", data: { SessionPart: 1, NoEntries: advance } });
  let part = 1, flagged = false, out = new Set();
  let best = {}; // driver -> best lap in this part
  for (const l of lines) {
    if (l.topic === "RaceControlMessages") {
      for (const m of Object.values(l.data?.Messages ?? {})) {
        const msg = String(m?.Message ?? "").toUpperCase();
        if (/CHEQUERED FLAG/.test(msg)) flagged = true;
        else if (flagged && /GREEN LIGHT/.test(msg) && part < 3) {
          // the next part begins: everyone outside the top places in this part is out
          const ranked = [...drivers].filter((n) => !out.has(n)).sort((a, b) => (best[a] ?? Infinity) - (best[b] ?? Infinity));
          const keep = advance[part];
          const knocked = ranked.slice(keep);
          part++; flagged = false; best = {};
          const update = { SessionPart: part, Lines: {} };
          for (const n of knocked) { out.add(n); update.Lines[n] = { KnockedOut: true }; }
          extra.push({ ms: l.ms, topic: "TimingData", data: update });
        }
      }
    }
    if (l.topic !== "TimingData") continue;
    for (const [n, d] of Object.entries(l.data?.Lines ?? {})) {
      const t = time(d?.LastLapTime?.Value);
      if (t && !out.has(n) && (best[n] == null || t < best[n])) {
        best[n] = t;
        extra.push({ ms: l.ms + 1, topic: "TimingData", data: { Lines: { [n]: { BestLapTimes: { [part - 1]: { Value: d.LastLapTime.Value } } } } } });
      }
    }
  }
  lines.push(...extra);
  lines.sort((a, b) => a.ms - b.ms);
}

// Things worth marking on the timeline, found by skimming the recording once.
function findMarks(lines) {
  const marks = [];
  let lastTrack = null, start = null, lap = 0;
  const laps = [];
  const inPit = {};
  for (const l of lines) {
    if (l.topic === "SessionStatus" && l.data?.Status === "Started" && start == null) start = l.ms;
    if (l.topic === "LapCount" && l.data?.CurrentLap && l.data.CurrentLap !== lap) { lap = l.data.CurrentLap; laps.push({ ms: l.ms, lap }); }
    if (l.topic === "TrackStatus") {
      const s = String(l.data?.Status ?? "");
      if (s !== lastTrack) {
        if (s === "4") marks.push({ ms: l.ms, kind: "sc", label: "Safety car" });
        if (s === "6") marks.push({ ms: l.ms, kind: "sc", label: "Virtual safety car" });
        if (s === "5") marks.push({ ms: l.ms, kind: "red", label: "Red flag" });
        lastTrack = s;
      }
    }
    if (l.topic === "TimingData") {
      for (const [n, x] of Object.entries(l.data?.Lines ?? {})) {
        if (x?.InPit === true && !inPit[n]) marks.push({ ms: l.ms, kind: "pit", label: `Pit stop (car ${n})` });
        if (x?.InPit !== undefined) inPit[n] = !!x.InPit;
      }
    }
  }
  return { marks, start, laps };
}

export class Player {
  constructor({ reset, apply, onChange }) {
    this.reset = reset;       // () => start a fresh engine whose clock reads player.now
    this.apply = apply;       // (topic, data) => feed one message into the engine
    this.onChange = onChange; // () => redraw controls
    this.lines = [];
    this.idx = 0;
    this.now = 0;
    this.playing = false;
    this.speed = 1;
    this.timer = setInterval(() => this.tick(), 100);
    this.last = performance.now();
  }

  load(lines, name) {
    this.lines = lines;
    this.name = name;
    this.first = lines[0]?.ms ?? 0;
    this.end = lines[lines.length - 1]?.ms ?? 0;
    Object.assign(this, findMarks(lines));
    this.idx = 0;
    this.now = this.first;
    this.reset();
    // archived races begin long before the start — jump to two minutes before lights out
    if (this.start && this.start - this.first > 5 * 60000) this.seek(this.start - 120000);
    this.playing = true;
    this.onChange();
  }

  tick() {
    const t = performance.now();
    const dt = t - this.last;
    this.last = t;
    if (!this.playing || !this.lines.length) return;
    this.now += dt * this.speed;
    this.catchUp();
    if (this.idx >= this.lines.length) { this.playing = false; }
    this.onChange();
  }

  catchUp() {
    while (this.idx < this.lines.length && this.lines[this.idx].ms <= this.now) {
      const l = this.lines[this.idx++];
      this.apply(l.topic, l.data);
    }
  }

  seek(ms) {
    ms = Math.max(this.first, Math.min(this.end, ms));
    if (ms < this.now) { this.reset(); this.idx = 0; }
    this.now = ms;
    this.catchUp();
    this.onChange();
  }

  toggle() { this.playing = !this.playing; this.last = performance.now(); this.onChange(); }

  lapAt(ms) {
    let lap = null;
    for (const l of this.laps) { if (l.ms <= ms) lap = l.lap; else break; }
    return lap;
  }
}
