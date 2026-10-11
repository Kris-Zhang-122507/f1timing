// Builds replay files for finished sessions from OpenF1's free historical data, so the
// site can replay them. Runs hourly on GitHub Actions (see .github/workflows/archive.yml).
//
//   node scripts/archive.mjs              this season, newest few race weekends
//   node scripts/archive.mjs 2026 10      this season, up to 10 race weekends back
//
// Output (served by GitHub Pages):
//   public/data/sessions/index.json      archived sessions + spoiler-free "worth watching" score
//   public/data/sessions/<key>.jsonl.gz  the replay itself (same format as our live recordings)
//
// Note: OpenF1 locks its free API while any session is live, so runs during a session
// just skip and try again next hour.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { LiveState } from "../public/lib/state.js";
import { Race } from "../public/lib/race.js";
import { buildReplay, openf1, fastestLaps, trackOutline, lapTelemetry } from "../public/lib/openf1.js";
import { extractIncidents, analyseCrash } from "./incidents.mjs";

const YEAR = Number(process.argv[2]) || new Date().getUTCFullYear();
const MEETINGS_BACK = Number(process.argv[3]) || 4;
const OUT = "public/data/sessions";
const TRACKS = "public/data/tracks";
const TELEMETRY = "public/data/telemetry";
const INCIDENTS = "public/data/incidents";

// Crashes, collisions and stopped cars for one session, with a crash analysis for the
// serious ones. Saved per session; the season summary feeds the Destructors' Championship.
async function saveIncidents(entry, lines) {
  const list = extractIncidents(lines);
  for (const inc of list.filter((i) => i.kind === "crash" || i.kind === "collision").slice(0, 8)) {
    try { inc.analysis = await analyseCrash(entry.key, inc); } catch (e) { log(`  no crash data for ${inc.tla}: ${e.message}`); }
    await pause(WAIT);
  }
  writeFileSync(`${INCIDENTS}/${entry.key}.json`, JSON.stringify({ key: entry.key, meeting: entry.meeting, name: entry.name, startUtc: entry.startUtc, incidents: list }));
  entry.incidents = list.length;
  return list.length;
}
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT = process.env.OPENF1_WAIT ? Number(process.env.OPENF1_WAIT) : 2200;
const KEEP = /^(Race|Qualifying|Sprint|Sprint Qualifying|Sprint Shootout)$/;
// Bump when the replay builder changes in a way worth rebuilding old files for.
// 2: lap counter never goes backwards; chequered flag no longer read as a red flag.
const FORMAT = 2;

// On GitHub Actions, "::notice::" / "::error::" lines show up as annotations on the run.
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const log = (...a) => console.log(...a);

// Only rewrite when something other than the "updated" stamp changed,
// so the hourly job doesn't commit (and redeploy the site) for nothing.
function writeIfChanged(path, obj) {
  const strip = (o) => JSON.stringify({ ...o, updated: undefined });
  if (existsSync(path)) {
    try { if (strip(JSON.parse(readFileSync(path, "utf8"))) === strip(obj)) return false; } catch { /* rewrite */ }
  }
  writeFileSync(path, JSON.stringify({ ...obj, updated: new Date().toISOString() }, null, 1));
  return true;
}

function lapSecs(v) {
  const m = String(v ?? "").match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN;
}

// Spoiler-free rating: replays the session through the same logic the site uses and
// counts what made it exciting, without saying who won.
export function rate(lines, isRace) {
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
    if (l.topic === "TimingData" && race.lap > 1) {
      const lead = Object.entries(state.data.TimingData?.Lines ?? {}).find(([, x]) => x.Position === "1")?.[0];
      if (lead && lead !== leader) { leader = lead; leadChanges++; }
    }
  }
  const v = race.view();
  const overtakes = race.story.filter((e) => e.type === "overtake").length;
  let score = 1;
  const reasons = [];
  if (isRace) {
    const p2 = v.rows.find((r) => r.pos === 2);
    const closeFinish = p2 && parseFloat(String(p2.int).replace("+", "")) < 3;
    if (overtakes >= 30) { score += 2; reasons.push("lots of overtaking"); } else if (overtakes >= 12) { score += 1; reasons.push("some good passing"); } else reasons.push("not much passing");
    if (sc) { score += 0.75; reasons.push(sc > 1 ? "safety cars" : "a safety car"); }
    if (red) { score += 0.75; reasons.push("a red flag"); }
    if (leadChanges >= 2) { score += 0.75; reasons.push("changes for the lead"); }
    if (closeFinish) { score += 0.75; reasons.push("a close finish"); }
    if (v.rows.filter((r) => r.out).length >= 3) reasons.push("several retirements");
  } else {
    const p1 = v.rows.find((r) => r.pos === 1), p3 = v.rows.find((r) => r.pos === 3);
    const spread = p1 && p3 ? lapSecs(p3.best) - lapSecs(p1.best) : NaN;
    if (spread < 0.15) { score += 2; reasons.push("incredibly tight at the top"); } else if (spread < 0.35) { score += 1; reasons.push("close at the top"); }
    if (red) { score += 1; reasons.push("a red flag"); }
    if (leadChanges >= 4) { score += 1; reasons.push("provisional pole kept changing"); }
  }
  return { score: Math.max(1, Math.min(5, Math.round(score))), reasons, laps: v.totalLaps || null };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(TRACKS, { recursive: true });
  mkdirSync(TELEMETRY, { recursive: true });
  mkdirSync(INCIDENTS, { recursive: true });
  const idxPath = `${OUT}/index.json`;
  const index = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, "utf8")) : { sessions: [] };
  const have = new Set(index.sessions.map((s) => s.key));

  let sessions;
  try {
    sessions = await openf1(`sessions?year=${YEAR}`);
  } catch (e) {
    if (/401/.test(e.message)) { notice("OpenF1 is locked while a session is live — will try again next hour."); return; }
    throw e;
  }

  // finished sessions we want, from the newest few race weekends
  const now = Date.now();
  const done = sessions.filter((s) => KEEP.test(s.session_name) && Date.parse(s.date_end) + 30 * 60000 < now);
  const meetings = [...new Set(done.map((s) => s.meeting_key))].slice(-MEETINGS_BACK);
  const stale = new Set(index.sessions.filter((e) => (e.v ?? 1) < FORMAT).map((e) => e.key));
  const todo = done.filter((s) => (meetings.includes(s.meeting_key) && !have.has(s.session_key)) || stale.has(s.session_key))
    .sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start));
  log(`${todo.length} session(s) to archive (${stale.size} rebuilt in the newer format)`);

  let added = 0;
  for (const s of todo) {
    log(`Archiving ${s.country_name} — ${s.session_name} (${s.session_key}) …`);
    try {
      const { lines, laps } = await buildReplay(s.session_key, { log });
      if (lines.length < 100) { log("  not enough data yet"); continue; }
      const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
      const file = `${s.session_key}.jsonl.gz`;
      const gz = gzipSync(body, { level: 9 });
      writeFileSync(`${OUT}/${file}`, gz);
      const isRace = /Race/i.test(s.session_type);
      const rating = rate(lines, isRace);
      const old = index.sessions.find((e) => e.key === s.session_key);
      const fresh = {
        key: s.session_key, year: YEAR, meeting: s.country_name, location: s.location, circuit: s.circuit_short_name,
        name: s.session_name, type: s.session_type, startUtc: s.date_start, file, sizeKb: Math.round(gz.length / 1024), ...rating, v: FORMAT,
      };
      if (old) {
        // rebuilding an older file: keep its telemetry, redo its incidents
        Object.assign(old, fresh);
        await saveIncidents(old, lines);
        notice(`Rebuilt ${s.country_name} ${s.session_name}`);
        await pause(WAIT);
        continue;
      }
      index.sessions.push(fresh);
      added++;

      // circuit outline (once per circuit) and everyone's fastest-lap telemetry
      const best = fastestLaps(laps).sort((a, b) => a.seconds - b.seconds);
      const trackFile = `${TRACKS}/${slug(s.circuit_short_name)}.json`;
      if (best.length && !existsSync(trackFile)) {
        try {
          const outline = await trackOutline(s.session_key, best[0]);
          if (outline) writeFileSync(trackFile, JSON.stringify({ circuit: s.circuit_short_name, points: outline }));
        } catch (e) { log(`  no track outline: ${e.message}`); }
        await pause(WAIT);
      }
      const tele = { key: s.session_key, circuit: s.circuit_short_name, drivers: {} };
      for (const lap of best) {
        try { const t = await lapTelemetry(s.session_key, lap); if (t) tele.drivers[lap.driver] = t; } catch (e) { log(`  no telemetry for ${lap.driver}: ${e.message}`); }
        await pause(WAIT);
      }
      if (Object.keys(tele.drivers).length) writeFileSync(`${TELEMETRY}/${s.session_key}.json`, JSON.stringify(tele));
      const entry = index.sessions[index.sessions.length - 1];
      entry.telemetry = Object.keys(tele.drivers).length > 0;
      await saveIncidents(entry, lines);

      notice(`Saved ${s.country_name} ${s.session_name}: ${lines.length} messages, ${Math.round(gz.length / 1024)} KB, worth watching ${rating.score}/5`);
    } catch (e) {
      if (/401/.test(e.message)) { notice("OpenF1 locked (a session went live) — stopping for now."); break; }
      notice(`Couldn't archive ${s.country_name} ${s.session_name}: ${e.message}`);
    }
  }
  index.sessions.sort((a, b) => (b.startUtc ?? "").localeCompare(a.startUtc ?? ""));

  // circuits still missing a track map (the outline request can fail when OpenF1 is busy)
  let tries = 0;
  for (const entry of index.sessions) {
    const trackFile = `${TRACKS}/${slug(entry.circuit)}.json`;
    if (existsSync(trackFile) || tries >= 8) continue;
    tries++;
    try {
      const laps = await openf1(`laps?session_key=${entry.key}`);
      await pause(WAIT);
      const best = fastestLaps(laps).sort((a, b) => a.seconds - b.seconds);
      for (const lap of best.slice(0, 3)) {
        const outline = await trackOutline(entry.key, lap);
        await pause(WAIT);
        if (outline) { writeFileSync(trackFile, JSON.stringify({ circuit: entry.circuit, points: outline })); log(`Track map for ${entry.circuit}`); break; }
      }
    } catch (e) {
      if (/401/.test(e.message)) break;
      log(`  no track map for ${entry.circuit}: ${e.message}`);
    }
  }

  // older archived sessions that don't have incident data yet: work it out from the saved replay
  for (const entry of index.sessions) {
    if (existsSync(`${INCIDENTS}/${entry.key}.json`) || !existsSync(`${OUT}/${entry.file}`)) continue;
    try {
      const lines = gunzipSync(readFileSync(`${OUT}/${entry.file}`)).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const n = await saveIncidents(entry, lines);
      log(`Incidents for ${entry.meeting} ${entry.name}: ${n}`);
    } catch (e) {
      if (/401/.test(e.message)) break;
      log(`Couldn't work out incidents for ${entry.key}: ${e.message}`);
    }
  }

  // season summary for the Destructors' Championship
  const season = index.sessions.filter((e) => existsSync(`${INCIDENTS}/${e.key}.json`)).map((e) => {
    const d = JSON.parse(readFileSync(`${INCIDENTS}/${e.key}.json`, "utf8"));
    return { key: e.key, meeting: e.meeting, name: e.name, startUtc: e.startUtc, incidents: d.incidents.map(({ analysis, ...rest }) => ({ ...rest, peakG: analysis?.peakG ?? null })) };
  });
  writeIfChanged(`${INCIDENTS}/index.json`, { sessions: season });

  writeIfChanged(idxPath, { sessions: index.sessions });
  notice(`Done: ${added} new session(s), ${index.sessions.length} archived in total`);
}

main().catch((e) => {
  console.log(process.env.GITHUB_ACTIONS ? `::error::${e.message}` : e);
  process.exit(1);
});
