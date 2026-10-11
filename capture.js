// undercut — step 1: connect to F1's live timing feed, record it, and show a terminal board.
//
//   npm install
//   npm run live                         -> connect live, record to recordings/<time>.jsonl
//   npm run replay recordings/xyz.jsonl  -> play a recording back (add --speed 10 to go faster)
//
// Unofficial project, not associated with Formula 1. Data from livetiming.formula1.com.
import * as signalR from "@microsoft/signalr";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { LiveState } from "./public/lib/state.js";

const BASE = "https://livetiming.formula1.com/signalrcore";

// Free (no login) topics are the important ones. The .z ones (car telemetry and
// track positions) need an F1 TV login since 2025, so expect them to stay empty.
const TOPICS = [
  "Heartbeat", "SessionInfo", "SessionStatus", "SessionData", "ExtrapolatedClock",
  "TrackStatus", "LapCount", "DriverList", "TimingData", "TimingAppData",
  "TimingStats", "TopThree", "RaceControlMessages", "WeatherData", "TeamRadio",
  "PitLaneTimeCollection", "ChampionshipPrediction", "CarData.z", "Position.z",
];

const state = new LiveState({ inflate: (b64) => inflateRawSync(Buffer.from(b64, "base64")).toString("utf8") });
const args = process.argv.slice(2);

// ---------- terminal board ----------
const TRACK_STATUS = { 1: "GREEN", 2: "YELLOW", 4: "SAFETY CAR", 5: "RED FLAG", 6: "VSC", 7: "VSC ENDING" };
const TYRE = { SOFT: "\x1b[31mS\x1b[0m", MEDIUM: "\x1b[33mM\x1b[0m", HARD: "\x1b[37mH\x1b[0m", INTERMEDIATE: "\x1b[32mI\x1b[0m", WET: "\x1b[34mW\x1b[0m" };

function colourBlock(hex) {
  const n = parseInt(hex, 16);
  if (Number.isNaN(n)) return "  ";
  return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m \x1b[0m`;
}

function pad(s, n, right = false) {
  s = String(s ?? "");
  return right ? s.padStart(n) : s.padEnd(n);
}

export function render(st, note = "") {
  const info = st.data.SessionInfo ?? {};
  const lap = st.data.LapCount;
  const track = TRACK_STATUS[st.data.TrackStatus?.Status] ?? st.data.TrackStatus?.Message ?? "?";
  const w = st.data.WeatherData ?? {};
  const out = [];
  out.push(`\x1b[1m${info.Meeting?.Name ?? "Waiting for session…"}  ·  ${info.Name ?? ""}\x1b[0m   ${note}`);
  out.push(
    `Lap ${lap?.CurrentLap ?? "-"}/${lap?.TotalLaps ?? "-"}   Track: ${track}   ` +
    `Air ${w.AirTemp ?? "-"}°  Track ${w.TrackTemp ?? "-"}°  Rain ${w.Rainfall === "1" ? "YES" : "no"}   ` +
    `msgs ${st.messages}`
  );
  out.push("");
  out.push(`  P  ${pad("DRV", 4)}${pad("GAP", 10, true)}${pad("INT", 10, true)}${pad("LAST", 11, true)}${pad("BEST", 11, true)}  TYRE  PIT`);
  for (const r of st.leaderboard()) {
    const flag = r.out ? " OUT" : r.pit ? " IN PIT" : "";
    out.push(
      `${colourBlock(r.colour)}${pad(r.pos === 99 ? "-" : r.pos, 2, true)} ${pad(r.tla, 4)}` +
      `${pad(r.gap, 10, true)}${pad(r.interval, 10, true)}${pad(r.last, 11, true)}${pad(r.best, 11, true)}` +
      `  ${TYRE[r.tyre] ?? "?"} ${pad(r.tyreAge, 3, true)}  ${r.pitStops}${flag}`
    );
  }
  const rcm = st.data.RaceControlMessages?.Messages ?? [];
  if (rcm.length) {
    out.push("", "\x1b[1mRace control\x1b[0m");
    for (const m of rcm.slice(-4)) out.push(`  ${m.Utc?.slice(11, 19) ?? ""}  ${m.Message}`);
  }
  return out.join("\n");
}

function draw(note) {
  process.stdout.write("\x1b[2J\x1b[H" + render(state, note) + "\n");
}

// ---------- live mode ----------
async function live() {
  mkdirSync("recordings", { recursive: true });
  const file = `recordings/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  const rec = createWriteStream(file, { flags: "a" });
  const record = (obj) => rec.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");

  // F1's load balancer wants its AWSALBCORS cookie sent back to it.
  const headers = { "User-Agent": "undercut/0.1" };
  try {
    const pre = await fetch(`${BASE}/negotiate`, { method: "OPTIONS" });
    const cookie = pre.headers.get("set-cookie")?.match(/AWSALBCORS=[^;]+/)?.[0];
    if (cookie) headers.Cookie = cookie;
  } catch (e) {
    console.error("Couldn't reach livetiming.formula1.com:", e.message);
  }

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(BASE, { headers, transport: signalR.HttpTransportType.WebSockets })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  connection.on("feed", (topic, data, timestamp) => {
    record({ topic, data, ts: timestamp });
    try { state.apply(topic, data); } catch (e) { record({ error: String(e), topic }); }
  });

  async function subscribe() {
    const snapshot = await connection.invoke("Subscribe", TOPICS);
    record({ snapshot });
    state.applySnapshot(snapshot);
  }
  connection.onreconnected(() => subscribe().catch((e) => console.error("Resubscribe failed:", e.message)));

  try {
    await connection.start();
    await subscribe();
  } catch (e) {
    console.error("\nConnection failed:", e.message);
    console.error("If this says 401/403, F1 now requires a login for the free feed too — tell Claude and we'll switch to replay data.");
    process.exit(1);
  }

  setInterval(() => {
    const quiet = state.lastMessageAt ? Math.round((Date.now() - state.lastMessageAt) / 1000) : null;
    draw(`\x1b[2m● LIVE  recording → ${file}${quiet > 30 ? `  (no data for ${quiet}s)` : ""}\x1b[0m`);
  }, 1000);

  process.on("SIGINT", async () => {
    rec.end();
    await connection.stop().catch(() => {});
    console.log(`\nSaved ${state.messages} messages to ${file}`);
    process.exit(0);
  });
}

// ---------- replay mode ----------
async function replay(path, speed) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let prevT = null;
  let lastDraw = 0;
  for (const msg of lines) {
    const t = Date.parse(msg.t);
    if (prevT !== null) await new Promise((r) => setTimeout(r, Math.min(5000, (t - prevT) / speed)));
    prevT = t;
    if (msg.snapshot) state.applySnapshot(msg.snapshot);
    else if (msg.topic) state.apply(msg.topic, msg.data);
    if (Date.now() - lastDraw > 250) {
      draw(`\x1b[2m▶ REPLAY ${speed}x  ${msg.t.slice(11, 19)} UTC\x1b[0m`);
      lastDraw = Date.now();
    }
  }
  draw("\x1b[2m■ replay finished\x1b[0m");
}

if (args[0] === "--replay") {
  const speedIdx = args.indexOf("--speed");
  replay(args[1], speedIdx > -1 ? Number(args[speedIdx + 1]) : 1);
} else {
  live();
}
