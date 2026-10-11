// Downloads finished F1 sessions from F1's public timing archive and saves them as
// replay files the site can play. Runs on GitHub Actions (see .github/workflows/archive.yml).
//
//   node scripts/archive.mjs              this season, newest few race weekends
//   node scripts/archive.mjs 2026 10      this season, up to 10 race weekends back
//
// Output (served by GitHub Pages):
//   public/data/schedule.json            every session this season, with UTC start times
//   public/data/sessions/index.json      archived sessions + spoiler-free "worth watching" score
//   public/data/sessions/<key>.jsonl.gz  the replay itself (same format as our recordings)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { LiveState } from "../public/lib/state.js";
import { Race } from "../public/lib/race.js";

const YEAR = Number(process.argv[2]) || new Date().getUTCFullYear();
const MEETINGS_BACK = Number(process.argv[3]) || 4;
const BASES = process.env.ARCHIVE_BASE ? [process.env.ARCHIVE_BASE] : ["https://livetiming.formula1.com/static/", "https://livetiming-mirror.fastf1.dev/static/"];
const OUT = "public/data";
const KEEP_TYPES = /^(Race|Qualifying|Sprint|Sprint Qualifying|Sprint Shootout)$/;
const TOPICS = ["SessionInfo", "SessionStatus", "SessionData", "ExtrapolatedClock", "TrackStatus", "LapCount", "DriverList",
  "TimingData", "TimingAppData", "TimingStats", "RaceControlMessages", "WeatherData", "TeamRadio", "PitLaneTimeCollection", "Heartbeat"];

const log = (...a) => console.log(...a);

// Only rewrite a JSON file when something other than its "updated" stamp changed,
// so the hourly job doesn't commit (and redeploy the site) for nothing.
function writeIfChanged(path, obj) {
  const strip = (o) => JSON.stringify({ ...o, updated: undefined });
  if (existsSync(path)) {
    try { if (strip(JSON.parse(readFileSync(path, "utf8"))) === strip(obj)) return false; } catch { /* rewrite */ }
  }
  writeFileSync(path, JSON.stringify({ ...obj, updated: new Date().toISOString() }, null, 1));
  return true;
}

async function get(path) {
  for (const base of BASES) {
    try {
      const r = await fetch(base + path, { headers: { "User-Agent": "undercut-archive/1.0" } });
      if (r.ok) return (await r.text()).replace(/^﻿/, "");
    } catch { /* try the mirror */ }
  }
  return null;
}

// "+08:00:00" / "-05:00:00" -> milliseconds
function offsetMs(s) {
  const m = String(s ?? "").match(/^(-)?(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  return (m[1] ? -1 : 1) * ((+m[2]) * 3600 + (+m[3]) * 60 + (+m[4])) * 1000;
}
const toUtc = (local, gmt) => new Date(Date.parse(local + "Z") - offsetMs(gmt)).toISOString();

// "01:23:45.678" -> milliseconds
function tsMs(ts) {
  const m = ts.match(/^(\d+):(\d+):(\d+)\.(\d+)$/);
  return m ? ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + Number(m[4].padEnd(3, "0").slice(0, 3)) : null;
}

function parseStream(text) {
  const out = [];
  for (const rec of text.split("\r\n")) {
    if (rec.length < 13) continue;
    const ms = tsMs(rec.slice(0, 12));
    const body = rec.slice(12);
    if (ms == null || body[0] !== "{") continue;
    try { out.push({ ms, data: JSON.parse(body) }); } catch { /* skip broken line */ }
  }
  return out;
}

// Spoiler-free rating: replays the session through the same logic the site uses and
// counts what made it exciting, without saying who won.
function rate(lines, type) {
  const state = new LiveState();
  const race = new Race(state);
  let simNow = 0;
  race.now = () => simNow;
  let leader = null, leadChanges = -1, red = false, sc = 0, lastTrack = null;
  for (const l of lines) {
    simNow = Date.parse(l.t);
    state.apply(l.topic, l.data);
    race.update();
    if (l.topic === "TrackStatus") {
      const s = String(state.data.TrackStatus?.Status ?? "");
      if (s !== lastTrack && (s === "4" || s === "6")) sc++;
      if (s === "5") red = true;
      lastTrack = s;
    }
    if (l.topic === "TimingData") {
      const lead = Object.entries(state.data.TimingData?.Lines ?? {}).find(([, x]) => x.Position === "1")?.[0];
      if (lead && lead !== leader) { leader = lead; leadChanges++; }
    }
  }
  const v = race.view();
  const overtakes = race.story.filter((e) => e.type === "overtake").length;
  const retirements = v.rows.filter((r) => r.out).length;
  const p2 = v.rows.find((r) => r.pos === 2);
  const closeFinish = p2 && parseFloat(String(p2.int).replace("+", "")) < 3;
  let score = 1;
  const reasons = [];
  if (/Race|Sprint$/.test(type)) {
    if (overtakes >= 30) { score += 2; reasons.push("lots of overtaking"); } else if (overtakes >= 12) { score += 1; reasons.push("some good passing"); } else reasons.push("not much passing");
    if (sc) { score += 0.75; reasons.push(sc > 1 ? "safety cars" : "a safety car"); }
    if (red) { score += 0.75; reasons.push("a red flag"); }
    if (leadChanges >= 2) { score += 0.75; reasons.push("changes for the lead"); }
    if (closeFinish) { score += 0.75; reasons.push("a close finish"); }
    if (retirements >= 3) reasons.push("several retirements");
  } else {
    const p1 = v.rows.find((r) => r.pos === 1), p3 = v.rows.find((r) => r.pos === 3);
    const spread = p1 && p3 ? (lapSecs(p3.best) - lapSecs(p1.best)) : null;
    if (spread != null && spread < 0.15) { score += 2; reasons.push("incredibly tight at the top"); } else if (spread != null && spread < 0.35) { score += 1; reasons.push("close at the top"); }
    if (red) { score += 1; reasons.push("a red flag"); }
    if (leadChanges >= 4) { score += 1; reasons.push("provisional pole kept changing"); }
  }
  return { score: Math.max(1, Math.min(5, Math.round(score))), reasons, laps: v.totalLaps || null };
}
function lapSecs(v) {
  const m = String(v ?? "").match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN;
}

async function archiveSession(meeting, ses) {
  const streams = {};
  for (const topic of TOPICS) {
    const text = await get(`${ses.Path}${topic}.jsonStream`);
    if (text) streams[topic] = parseStream(text);
  }
  if (!streams.TimingData?.length) return null;

  // Line the stream clock up with real time using the Heartbeat's UTC stamps
  const hb = streams.Heartbeat?.find((x) => x.data?.Utc);
  const base = hb ? Date.parse(hb.data.Utc) - hb.ms : Date.parse(ses.startUtc) - 3600000;
  const lines = [];
  for (const [topic, recs] of Object.entries(streams)) {
    if (topic === "Heartbeat") continue;
    for (const r of recs) lines.push({ ms: r.ms, topic, data: r.data });
  }
  lines.sort((a, b) => a.ms - b.ms);
  const out = lines.map((l) => ({ t: new Date(base + l.ms).toISOString(), topic: l.topic, data: l.data }));
  const body = out.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const file = `${ses.Key}.jsonl.gz`;
  writeFileSync(`${OUT}/sessions/${file}`, gzipSync(body, { level: 9 }));
  const rating = rate(out, ses.Type === "Race" && /Sprint/.test(ses.Name) ? "Sprint" : ses.Name);
  return {
    key: ses.Key, year: YEAR, meeting: meeting.Name, country: meeting.Country?.Name ?? "", location: meeting.Location ?? "",
    name: ses.Name, type: ses.Type, startUtc: ses.startUtc, file, messages: out.length,
    sizeKb: Math.round(gzipSync(body, { level: 1 }).length / 1024), ...rating,
  };
}

async function main() {
  mkdirSync(`${OUT}/sessions`, { recursive: true });
  const indexText = await get(`${YEAR}/Index.json`);
  if (!indexText) throw new Error(`Couldn't download the ${YEAR} season index`);
  const meetings = JSON.parse(indexText).Meetings ?? [];

  // Season schedule (in UTC — the site converts to your own time zone)
  const schedule = meetings.map((m) => ({
    meeting: m.Name, official: m.OfficialName, country: m.Country?.Name ?? "", location: m.Location ?? "",
    circuit: m.Circuit?.ShortName ?? "", round: m.Number ?? null,
    sessions: (m.Sessions ?? []).filter((s) => s.Name).map((s) => ({
      key: s.Key, name: s.Name, type: s.Type,
      startUtc: s.StartDate ? toUtc(s.StartDate, s.GmtOffset) : null,
      endUtc: s.EndDate ? toUtc(s.EndDate, s.GmtOffset) : null,
    })),
  }));
  writeIfChanged(`${OUT}/schedule.json`, { year: YEAR, meetings: schedule });
  log(`Schedule: ${schedule.length} meetings`);

  const idxPath = `${OUT}/sessions/index.json`;
  const index = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, "utf8")) : { sessions: [] };
  const have = new Set(index.sessions.map((s) => s.key));

  // finished sessions we want, newest race weekends first
  const now = Date.now();
  const recent = meetings.filter((m) => (m.Sessions ?? []).some((s) => s.EndDate && Date.parse(toUtc(s.EndDate, s.GmtOffset)) < now)).slice(-MEETINGS_BACK);
  let added = 0;
  for (const m of recent.reverse()) {
    for (const s of m.Sessions ?? []) {
      if (!s.Path || s.Key === -1 || have.has(s.Key) || !KEEP_TYPES.test(s.Name)) continue;
      const end = s.EndDate ? Date.parse(toUtc(s.EndDate, s.GmtOffset)) : 0;
      if (!end || end + 45 * 60000 > now) continue; // give F1 time to finish publishing
      s.startUtc = toUtc(s.StartDate, s.GmtOffset);
      log(`Archiving ${m.Name} — ${s.Name} …`);
      try {
        const entry = await archiveSession(m, s);
        if (entry) { index.sessions.push(entry); added++; log(`  saved ${entry.file} (${entry.messages} messages, worth watching ${entry.score}/5)`); }
        else log("  no timing data published (yet)");
      } catch (e) {
        log(`  failed: ${e.message}`);
      }
    }
  }
  index.sessions.sort((a, b) => (b.startUtc ?? "").localeCompare(a.startUtc ?? ""));
  writeIfChanged(idxPath, { sessions: index.sessions });
  log(`Done: ${added} new session(s), ${index.sessions.length} archived in total`);
}

main().catch((e) => { console.error(e); process.exit(1); });
