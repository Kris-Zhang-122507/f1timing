// undercut server: F1 live feed (or a recording) -> browser over WebSocket.
//
//   npm start                                         live, also records to recordings/
//   npm run replay -- recordings/xyz.jsonl --speed 10 replay a recording
//
// Then open http://localhost:3000
import http from "node:http";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { inflateRawSync } from "node:zlib";
import { LiveState } from "./public/lib/state.js";
import { Race } from "./public/lib/race.js";
import { connectLive } from "./f1feed.js";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const args = process.argv.slice(2);
const replayFile = args[0] === "--replay" ? args[1] : null;
const speed = args.includes("--speed") ? Number(args[args.indexOf("--speed") + 1]) || 1 : 1;

const state = new LiveState({ inflate: (b64) => inflateRawSync(Buffer.from(b64, "base64")).toString("utf8") });
const race = new Race(state);
let mode = replayFile ? "replay" : "live";
let status = replayFile ? `Replaying ${replayFile} at ${speed}x` : "Connecting to F1…";
let replayTime = null;

function apply(topic, data) {
  try {
    state.apply(topic, data);
    race.update();
  } catch (e) {
    console.error(`Couldn't apply ${topic}:`, e.message);
  }
}
function applySnapshot(snapshot) {
  for (const [topic, data] of Object.entries(snapshot || {})) apply(topic, data);
}

// ---------- web server ----------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let path = normalize(join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
  if (!path.startsWith(PUBLIC) || !existsSync(path) || statSync(path).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(path).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/ws" });
let lastSent = "";
function payload() {
  return JSON.stringify({ mode, status, replayTime, ...race.view() });
}
wss.on("connection", (socket) => socket.send(payload()));
setInterval(() => {
  if (!wss.clients.size) return;
  const p = payload();
  if (p === lastSent) return;
  lastSent = p;
  for (const c of wss.clients) if (c.readyState === 1) c.send(p);
}, 500);

server.listen(PORT, () => console.log(`Undercut running → http://localhost:${PORT}`));

// ---------- data source ----------
if (replayFile) {
  const lines = readFileSync(replayFile, "utf8").split("\n").filter(Boolean);
  let prevT = null;
  (async () => {
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const t = Date.parse(msg.t);
      if (prevT !== null && t > prevT) await new Promise((r) => setTimeout(r, Math.min(5000, (t - prevT) / speed)));
      prevT = t;
      replayTime = msg.t;
      if (msg.snapshot) applySnapshot(msg.snapshot);
      else if (msg.topic) apply(msg.topic, msg.data);
    }
    status = "Replay finished";
  })();
} else {
  mkdirSync("recordings", { recursive: true });
  const file = `recordings/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  const rec = createWriteStream(file, { flags: "a" });
  const record = (obj) => rec.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");
  connectLive({
    onSnapshot: (snapshot) => { record({ snapshot }); applySnapshot(snapshot); status = `Live · recording to ${file}`; },
    onMessage: (topic, data) => { record({ topic, data }); apply(topic, data); },
    log: (m) => { console.log(m); if (/lost|reconnect/i.test(m)) status = m; },
  }).catch((e) => {
    status = `Couldn't connect to F1: ${e.message}`;
    console.error(status);
    console.error("If it's 401/403, F1 may now need a login for this feed. Replays still work.");
  });
  process.on("SIGINT", () => { rec.end(); console.log(`\nSaved ${state.messages} messages to ${file}`); process.exit(0); });
}
