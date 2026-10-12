// Undercut page: draws the race view, from the Undercut server or worked out right here.
import { LiveState } from "./lib/state.js?v=mv4zegnc";
import { Race, lapSeconds } from "./lib/race.js?v=mv4zegnc";
import { CircleView } from "./circle.js?v=mv4zegnc";
import { renderTyres } from "./tyres.js?v=mv4zegnc";
import { renderStrategy, renderPitTable } from "./strategy.js?v=mv4zegnc";
import { renderCompare } from "./compare.js?v=mv4zegnc";
import { renderRewind } from "./rewind.js?v=mv4zegnc";
import { renderDriver } from "./driver.js?v=mv4zegnc";
import { Player, parseRecording } from "./player.js?v=mv4zegnc";
import { loadSchedule, currentWeekend, renderSchedule, calendarFile } from "./schedule.js?v=mv4zegnc";
import { TrackView, loadTrack, loadGps, circuitSlug } from "./track.js?v=mv4zegnc";
import { Dashboard } from "./dash.js?v=mv4zegnc";
import { CarTelemetry } from "./telemetry.js?v=mv4zegnc";
import { renderStewards, renderPitWindow } from "./racecalls.js?v=mv4zegnc";
import * as tx from "./transcribe.js?v=mv4zegnc";
import { renderKnockout } from "./quali.js?v=mv4zegnc";
import { loadSeason, renderH2H } from "./h2h.js?v=mv4zegnc";
import { loadStandings, renderStandings } from "./standings.js?v=mv4zegnc";
import { loadNews, loadIncidentIndex, loadIncidents, renderNews, renderTechnical } from "./news.js?v=mv4zegnc";
import { loadTechnical, loadCrashCost, renderUpgrades, renderPowerUnits, renderCrashCost } from "./technical.js?v=mv4zegnc";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let view = null;
let rcFilter = "all";
let tab = "overview";
// Panels on the Live dashboard (dash.js tells us when this changes)
let dashSet = new Set();
// is this content on screen right now? (its own tab, or a panel on the Live dashboard)
const shows = (t) => tab === t || (tab === "overview" && (t === "circle" ? dashSet.has("circle") || dashSet.has("track") : dashSet.has(t)));
let lastStrategy = 0;
let lastSched = 0;
let lastStand = 0;
let lastNews = 0;
let newsFilter = "all";
let techKey = null;
let techView = "upgrades", techPick = null, puOpen = null;
const ccUi = { ccBy: "driver", ccCum: false };
let standingsOk = false; // "show anyway" past the spoiler shield
let lastSlow = 0;
let lastCalls = 0;          // stewards / pit window redraw
let lastKnock = 0;          // qualifying knockout panel          // compare / rewind / my driver redraw every 2s (their numbers change per lap)
let cmpA = null, cmpB = null, rwFocus = null, rwMark = null;
let dvSel = null;
try { dvSel = localStorage.getItem("undercut.driver"); } catch {}
let circleSel = null;
// What a pit stop costs: measured per circuit from past races (data/pitloss.json, rebuilt by the
// hourly job). If you type your own number it's remembered for that circuit only.
let pitData = null;
let pitMine = {};
try { pitMine = JSON.parse(localStorage.getItem("undercut.pitLossBy") || "{}"); } catch {}
fetch(`data/pitloss.json?t=${Math.floor(Date.now() / 36e5)}`).then((r) => (r.ok ? r.json() : null)).then((d) => { pitData = d; if (view) render(); }).catch(() => {});
let pitLoss = { green: 22 };
function pitProfile(v) {
  const slug = circuitSlug(v?.session?.circuit);
  const d = pitData?.circuits?.[slug], mine = pitMine[slug];
  const ratios = { scRatio: pitData?.scRatio ?? 0.55, vscRatio: pitData?.vscRatio ?? 0.65 };
  if (mine) return { green: mine, ...ratios, slug, source: "your number" };
  if (d) return { ...d, ...ratios, slug, source: `measured from ${d.samples.green} stops here` };
  return { green: 22, ...ratios, slug, source: "typical value — no races here yet" };
}

// Minisector status codes from the F1 feed
function segClass(s) {
  if (s === 2051) return "p";
  if (s === 2049) return "g";
  if (s === 2064) return "b";
  if (s === 2048 || s === 2052) return "y";
  return "";
}

// ---------- data sources ----------
// 1. Undercut server (npm start): the server does the work and sends us a ready-made view.
// 2. Standalone (GitHub Pages, or ?direct): this page connects to F1 itself and does the work here.
// 3. A recording file loaded with the "Load recording" button, replayed in this page.
const params = new URLSearchParams(location.search);
const standalone = location.hostname.endsWith("github.io") || params.has("direct");
let serverSocket = null;
let useServer = !standalone;

function connect() {
  if (!useServer) return;
  serverSocket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  serverSocket.onmessage = (e) => {
    if (!useServer) return;
    const v = JSON.parse(e.data);
    noteArrival(v);
    if (!tvDelay) { view = v; render(); return; }
    delayedViews.push({ at: Date.now(), v });
  };
  serverSocket.onclose = () => {
    if (!useServer) return;
    $("conn").className = "conn";
    $("connText").textContent = "Disconnected from the Undercut server — retrying…";
    setTimeout(connect, 2000);
  };
}

// Local engine: the same timing logic the server uses, running in the browser.
let engine = null;
function newEngine(mode, status) {
  const state = new LiveState();
  engine = { state, race: new Race(state), mode, status, replayTime: null };
}
function feed(topic, data) {
  try { engine.state.apply(topic, data); engine.race.update(); } catch (e) { console.warn("Couldn't apply", topic, e); }
}
setInterval(() => {
  if (!engine) return;
  view = { mode: engine.mode, status: engine.status, replayTime: engine.replayTime, ...engine.race.view() };
  render();
}, 500);

const TOPICS = ["Heartbeat", "SessionInfo", "SessionStatus", "SessionData", "ExtrapolatedClock", "TrackStatus", "LapCount",
  "DriverList", "TimingData", "TimingAppData", "TimingStats", "TopThree", "RaceControlMessages", "WeatherData", "TeamRadio", "PitLaneTimeCollection", "PitStopSeries"];
let directSocket = null;

function connectDirect() {
  if (!engine || engine.mode !== "live") newEngine("live", "Connecting to F1 from your browser…");
  engine.race.now = () => Date.now() - tvDelay * 1000; // the race clock runs as far behind as your TV
  const RS = "\x1e";
  let gotData = false;
  let ping = null;
  directSocket = new WebSocket("wss://livetiming.formula1.com/signalrcore");
  const ws = directSocket;
  ws.onopen = () => {
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    ws.send(JSON.stringify({ type: 1, target: "Subscribe", arguments: [TOPICS], invocationId: "0" }) + RS);
    ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 6 }) + RS), 15000);
  };
  ws.onmessage = (e) => {
    if (ws !== directSocket) return;
    for (const part of String(e.data).split(RS)) {
      if (!part) continue;
      let m;
      try { m = JSON.parse(part); } catch { continue; }
      if (m.type === 1 && m.target === "feed") { gotData = true; liveIn(m.arguments[0], m.arguments[1]); saveLocal(m.arguments[0], m.arguments[1]); }
      else if (m.type === 3 && m.invocationId === "0") {
        if (m.error) engine.status = `F1 refused the subscription: ${m.error}`;
        else { gotData = true; for (const [t, d] of Object.entries(m.result ?? {})) { liveIn(t, d, true); saveLocal(t, d); } engine.status = "Live · direct from F1"; }
      } else if (m.type === 7) engine.status = `F1 closed the connection${m.error ? ": " + m.error : ""}`;
    }
  };
  ws.onclose = (e) => {
    clearInterval(ping);
    if (ws !== directSocket) return;
    if (!gotData) {
      engine.status = `Your browser couldn't connect to F1 directly (code ${e.code}). Live needs the Undercut server — you can still load a recording.`;
    } else {
      engine.status = "Connection lost — reconnecting…";
      setTimeout(connectDirect, 3000);
    }
  };
}

// ---------- TV delay: hold live timing back to match your TV or stream ----------
let tvDelay = 0;
try { tvDelay = Math.max(0, Math.min(600, Number(localStorage.getItem("undercut.tvDelay")) || 0)); } catch {}
const delayedMsgs = [];   // direct-from-F1 messages waiting to be shown
// what live timing says right now, ignoring the delay (for matching against your TV)
function liveView() {
  if (useServer) return delayedViews.at(-1)?.v ?? view;
  const lapNow = Math.max(0, ...Object.keys(arrivals.laps).map(Number), Number(engine?.state?.data?.LapCount?.CurrentLap) || 0, ...delayedMsgs.filter((m) => m.topic === "LapCount").map((m) => Number(m.data?.CurrentLap) || 0));
  return lapNow ? { lap: lapNow, refLap: view?.refLap } : null;
}
const delayedViews = [];  // ready-made views from the Undercut server, waiting
const arrivals = { start: null, lap: null, laps: {} }; // when lights out / each lap change reached us (undelayed)
function noteArrival(topicOrView, data) {
  if (typeof topicOrView === "string") {
    if (topicOrView === "SessionStatus" && data?.Status === "Started") arrivals.start = Date.now();
    if (topicOrView === "LapCount" && data?.CurrentLap) { arrivals.lap = Date.now(); arrivals.laps[data.CurrentLap] ??= Date.now(); }
  } else if (topicOrView?.lap && topicOrView.lap !== noteArrival.lastLap) {
    // the first view after connecting is mid-lap: we don't know when that lap began
    if (noteArrival.lastLap != null) { arrivals.lap = Date.now(); arrivals.laps[topicOrView.lap] ??= Date.now(); }
    noteArrival.lastLap = topicOrView.lap;
  }
}
function liveIn(topic, data, snapshot = false) {
  if (!snapshot) noteArrival(topic, data);
  if (!tvDelay && !delayedMsgs.length) return feed(topic, data);
  delayedMsgs.push({ at: Date.now(), topic, data });
}
setInterval(() => {
  const due = Date.now() - tvDelay * 1000;
  while (delayedMsgs.length && delayedMsgs[0].at <= due) { const m = delayedMsgs.shift(); feed(m.topic, m.data); }
  let latest = null;
  while (delayedViews.length && delayedViews[0].at <= due) latest = delayedViews.shift().v;
  if (latest && useServer) { view = latest; render(); }
}, 100);
function setDelay(sec) {
  tvDelay = Math.round(Math.max(0, Math.min(600, sec)));
  try { localStorage.setItem("undercut.tvDelay", String(tvDelay)); } catch {}
  $("delayRange").value = Math.min(300, tvDelay);
  $("delayVal").textContent = `${tvDelay} s`;
  $("delaySum").textContent = tvDelay ? `TV delay: ${tvDelay}s` : "TV delay: off";
  $("delayMenu").classList.toggle("on", tvDelay > 0);
}
setDelay(tvDelay);
$("delayRange").addEventListener("input", (e) => setDelay(Number(e.target.value)));
$("delayMenu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-d]");
  if (b) setDelay(b.dataset.d === "0" ? 0 : tvDelay + Number(b.dataset.d));
});
function syncTo(at, what) {
  if (!at) { $("delayNote").textContent = `The timing hasn't seen ${what} yet this session — use the slider for now.`; return; }
  setDelay((Date.now() - at) / 1000);
  $("delayNote").textContent = `Matched: the site now runs ${tvDelay}s behind live timing.`;
}
$("delayLapForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const lap = Number($("delayLap").value);
  if (!lap) { $("delayLap").focus(); return; }
  const live = liveView();
  if (!live?.lap) { $("delayNote").textContent = "There's no live race running right now, so there's nothing to match yet. During a race, type the lap your TV shows the moment its lap counter changes."; return; }
  if (lap > live.lap) { $("delayNote").textContent = `Live timing is only on lap ${live.lap} — your TV can't be ahead of it. Check the lap number?`; return; }
  if (arrivals.laps[lap]) return syncTo(arrivals.laps[lap], `lap ${lap}`);
  // not seen by this page (it was opened later): estimate from the typical lap time
  const ref = live.refLap || 95;
  const sinceCurrent = arrivals.laps[live.lap] ? (Date.now() - arrivals.laps[live.lap]) / 1000 : ref / 2;
  setDelay(sinceCurrent + (live.lap - lap) * ref);
  $("delayNote").textContent = `Estimated ${tvDelay}s from lap times (this page opened after lap ${lap} began). Fine-tune with ±1, or press Match again at the next lap change for an exact match.`;
});
// suggest the lap your TV is probably on
$("delayMenu").addEventListener("toggle", () => {
  if (!$("delayMenu").open) return;
  const known = Object.keys(arrivals.laps).map(Number);
  if (known.length && !$("delayLap").value) $("delayLap").value = Math.max(...known);
});
$("syncStart").addEventListener("click", () => syncTo(arrivals.start, "the race start"));
document.addEventListener("click", (e) => { const m = $("delayMenu"); if (m.open && !m.contains(e.target)) m.open = false; });

// ---------- saving live sessions in this browser (IndexedDB) ----------
// Every live message is kept in the browser so you can replay the session straight away.
// Messages are written in small chunks every few seconds; nothing leaves your computer.
const local = { db: null, id: null, buf: [], seq: 0, meta: null };
const localOn = () => { try { return localStorage.getItem("undercut.saveLocal") !== "off"; } catch { return true; } };
function openDb() {
  if (local.db) return Promise.resolve(local.db);
  return new Promise((res, rej) => {
    const r = indexedDB.open("undercut", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("sessions", { keyPath: "id" });
      r.result.createObjectStore("chunks", { keyPath: ["id", "seq"] });
    };
    r.onsuccess = () => { local.db = r.result; res(r.result); };
    r.onerror = () => rej(r.error);
  });
}
const idbReq = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
function saveLocal(topic, data) {
  if (!localOn()) return;
  local.buf.push({ t: new Date().toISOString(), topic, data });
}
async function flushLocal() {
  if (!local.buf.length || typeof indexedDB === "undefined") return;
  const info = engine?.state?.data?.SessionInfo;
  if (!info?.Name) return; // wait until we know which session this is
  // Only keep what's recorded while the session is running. Opening the page after the
  // flag would otherwise save a "replay" that only shows the final result.
  const status = engine?.state?.data?.SessionStatus?.Status ?? "";
  if (/Finished|Finalised|Ends/i.test(status) && !local.meta) { local.buf.length = 0; return; }
  const id = `${info.Meeting?.Name ?? "Session"} · ${info.Name} · ${(info.StartDate ?? new Date().toISOString()).slice(0, 10)}`;
  try {
    const db = await openDb();
    if (local.id !== id) {
      local.id = id;
      local.meta = (await idbReq(db.transaction("sessions").objectStore("sessions").get(id))) ?? { id, meeting: info.Meeting?.Name ?? "", name: info.Name, first: local.buf[0].t, chunks: 0, count: 0 };
      local.seq = local.meta.chunks;
    }
    const lines = local.buf.splice(0);
    local.meta.chunks = ++local.seq;
    local.meta.count += lines.length;
    local.meta.last = lines[lines.length - 1].t;
    const tx = db.transaction(["sessions", "chunks"], "readwrite");
    tx.objectStore("chunks").put({ id, seq: local.seq, lines });
    tx.objectStore("sessions").put(local.meta);
  } catch (e) { console.warn("Couldn't save locally", e); }
}
setInterval(flushLocal, 5000);
if (params.has("debug")) window.undercut = { saveLocal, flushLocal, localSessions, newEngine, feed, liveIn: (t, d, s) => liveIn(t, d, s), get engine() { return engine; } };
window.addEventListener("pagehide", flushLocal);

async function localSessions() {
  try { const db = await openDb(); return (await idbReq(db.transaction("sessions").objectStore("sessions").getAll())).sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "")); }
  catch { return []; }
}
async function localLines(id) {
  const db = await openDb();
  const chunks = await idbReq(db.transaction("chunks").objectStore("chunks").getAll(IDBKeyRange.bound([id, 0], [id, Infinity])));
  return chunks.sort((a, b) => a.seq - b.seq).flatMap((c) => c.lines);
}
async function deleteLocal(id) {
  const db = await openDb();
  const tx = db.transaction(["sessions", "chunks"], "readwrite");
  tx.objectStore("sessions").delete(id);
  tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
  await new Promise((r) => { tx.oncomplete = r; tx.onerror = r; });
}

// ---------- replays ----------
// Recordings (ours, or archived sessions) play through the same engine as live data.
let player = null;
function stopLive() {
  useServer = false;
  serverSocket?.close();
  const ds = directSocket;
  directSocket = null;
  ds?.close();
}
function ensurePlayer() {
  player ??= new Player({
    reset: () => { newEngine("replay", `Replay · ${player.name}`); engine.race.now = () => player.now; },
    apply: (topic, data) => feed(topic, data),
    onChange: () => drawPlayer(),
  });
  return player;
}
function startReplay(lines, name) {
  if (!lines.length) { alert("That file doesn't contain any timing data."); return; }
  stopLive();
  const p = ensurePlayer();
  p.speed = Number($("recSpeed").value) || 1;
  p.load(lines, name);
  $("player").hidden = false;
  lastMarks = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$("recFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (f) startReplay(parseRecording(await f.text()), f.name);
});

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
let lastMarks = "";
function drawPlayer() {
  const p = player;
  if (!p || !p.lines.length) return;
  if (engine) engine.replayTime = new Date(p.now).toISOString();
  const span = Math.max(1, p.end - p.first);
  const frac = (p.now - p.first) / span;
  $("plPlay").textContent = p.playing ? "Pause" : p.idx >= p.lines.length ? "Replay ended" : "Play";
  $("plPlay").setAttribute("aria-pressed", p.playing ? "true" : "false");
  const base = p.start ?? p.first;
  const lap = p.lapAt(p.now);
  $("plTime").textContent = `${lap ? `Lap ${lap} · ` : ""}${p.now < base ? "−" + clock(base - p.now) : clock(p.now - base)} ${p.start ? "since lights out" : "in"}`;
  $("plName").textContent = p.name;
  if (document.activeElement !== $("plSeek")) $("plSeek").value = String(Math.round(frac * 1000));
  const shield = $("plShield").checked;
  $("plTrack").style.setProperty("--done", `${(frac * 100).toFixed(2)}%`);
  $("plTrack").classList.toggle("shielded", shield);
  // markers: with the spoiler shield on, only show what's already happened
  const key = `${shield}|${shield ? p.marks.filter((m) => m.ms <= p.now).length : "all"}|${p.name}`;
  if (key !== lastMarks) {
    lastMarks = key;
    $("plMarks").innerHTML = p.marks.filter((m) => !shield || m.ms <= p.now)
      .map((m) => `<button class="mark ${m.kind}" style="left:${(((m.ms - p.first) / span) * 100).toFixed(2)}%" data-ms="${m.ms}" title="${m.label} — jump here" aria-label="${m.label}"></button>`).join("");
  }
}

$("plPlay").addEventListener("click", () => player?.toggle());
$("plSeek").addEventListener("input", (e) => { if (player) player.seek(player.first + (Number(e.target.value) / 1000) * (player.end - player.first)); });
$("plMarks").addEventListener("click", (e) => { const m = e.target.closest("[data-ms]"); if (m && player) player.seek(Number(m.dataset.ms) - 5000); });
$("plLapForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const lap = Number($("plLap").value), l = player?.laps?.find((x) => x.lap === lap);
  if (l) player.seek(l.ms - 3000);
  else if (player?.laps?.length) $("plLap").value = Math.max(1, Math.min(lap || 1, player.laps.at(-1).lap));
});
$("plBack").addEventListener("click", () => player?.seek(player.now - 10000));
$("plFwd").addEventListener("click", () => player?.seek(player.now + 10000));
$("plMinus").addEventListener("click", () => player?.seek(player.now - 1000));
$("plPlus").addEventListener("click", () => player?.seek(player.now + 1000));
$("plShield").addEventListener("change", () => { lastMarks = ""; drawPlayer(); });
$("plSync").addEventListener("click", () => {
  if (!player) return;
  // you press this the moment the lights go out on your stream
  $("recSpeed").value = "1";
  player.speed = 1;
  player.seek(player.start ?? player.first);
  if (!player.playing) player.toggle();
});
$("plLive").addEventListener("click", () => { location.href = location.pathname + location.search; });
$("recSpeed").addEventListener("change", (e) => { if (player) player.speed = Number(e.target.value) || 1; });

// Past sessions archived by the GitHub job
let archive = null;
async function loadArchive() {
  if (archive) return archive;
  try {
    const r = await fetch(`data/sessions/index.json?t=${Date.now()}`);
    archive = r.ok ? await r.json() : { sessions: [] };
  } catch { archive = { sessions: [] }; }
  return archive;
}
async function renderReplays() {
  const box = $("tab-replays");
  const a = await loadArchive();
  const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const groups = new Map();
  for (const s of a.sessions) {
    const k = `${s.year}-${s.meeting}`;
    if (!groups.has(k)) groups.set(k, { title: s.meeting, items: [] });
    groups.get(k).items.push(s);
  }
  const list = [...groups.values()].map((g) => `<section class="card">
      <h2>${esc(g.title)}</h2>
      ${g.items.map((s) => `<div class="rp-item">
        <div class="rp-main"><div class="rp-name">${esc(s.name)}</div><div class="muted small">${fmtDate(s.startUtc)} · ${s.sizeKb} KB</div></div>
        <div class="rp-worth" title="How exciting it was — no results given away"><span class="dots">${"●".repeat(s.score)}${"○".repeat(5 - s.score)}</span><span class="small muted">${esc((s.reasons ?? []).join(", "))}</span></div>
        <button class="btn primary" data-file="${esc(s.file)}" data-name="${esc(`${s.meeting} ${s.name}`)}">Watch</button>
      </div>`).join("")}
    </section>`).join("");
  const saved = await localSessions();
  let usage = "";
  try { const e = await navigator.storage?.estimate?.(); if (e?.usage) usage = ` · using ${(e.usage / 1048576).toFixed(0)} MB`; } catch {}
  const fmtShort = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
  const localHtml = `<section class="card">
      <div class="card-head"><h2>Saved in this browser</h2>
        <label class="muted small shield"><input type="checkbox" id="saveLocalToggle" ${localOn() ? "checked" : ""}> Save live sessions as I watch${usage}</label></div>
      <p class="muted small">Ready to replay straight away — from whenever you opened the page. Stays on this computer only.</p>
      ${saved.length ? saved.map((s) => `<div class="rp-item">
        <div class="rp-main"><div class="rp-name">${esc(s.meeting)} · ${esc(s.name)}</div><div class="muted small">${fmtShort(s.first)} → ${fmtShort(s.last)} · ${s.count.toLocaleString()} updates</div></div>
        <div class="rp-actions"><button class="btn primary" data-local="${esc(s.id)}">Watch</button><button class="btn" data-download="${esc(s.id)}">Download</button><button class="btn" data-delete="${esc(s.id)}" aria-label="Delete ${esc(s.meeting)} ${esc(s.name)}">Delete</button></div>
      </div>`).join("") : `<div class="muted small">Nothing saved yet — open the site during a session and it starts saving automatically.</div>`}
    </section>`;
  box.innerHTML = localHtml + `<section class="card rp-intro">
      <h2>Replays</h2>
      <p class="muted small">Every race, sprint and qualifying is saved here about an hour after it ends. Results stay hidden — the dots only tell you how exciting it was. Press <b>Lights out — sync now</b> when the race starts on your stream and the timing follows your video.</p>
      <label class="btn">Open a recording file…<input type="file" id="recFile2" accept=".jsonl,.json,.txt" hidden></label>
    </section>
    ${list || `<section class="card"><div class="muted small">No sessions archived yet — the archive job runs every hour, and OpenF1 only opens up once a live session has finished.</div></section>`}`;
}
$("tab-replays").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-file]");
  if (!b) return;
  b.disabled = true;
  b.textContent = "Loading…";
  try {
    const r = await fetch(`data/sessions/${b.dataset.file}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
    startReplay(parseRecording(text), b.dataset.name);
    replayKey = Number(b.dataset.file.split(".")[0]) || null;
    $("tabs").querySelector('[data-tab="overview"]').click();
  } catch (err) {
    b.textContent = "Couldn't load";
    console.warn(err);
  }
});
$("tab-replays").addEventListener("click", async (e) => {
  const watch = e.target.closest("[data-local]"), dl = e.target.closest("[data-download]"), del = e.target.closest("[data-delete]");
  if (watch) {
    watch.textContent = "Loading…";
    const lines = await localLines(watch.dataset.local);
    startReplay(lines.map((l) => ({ ms: Date.parse(l.t), topic: l.topic, data: l.data })).sort((a, b) => a.ms - b.ms), watch.dataset.local);
    replayKey = null;
    $("tabs").querySelector('[data-tab="overview"]').click();
  }
  if (dl) {
    const lines = await localLines(dl.dataset.download);
    const blob = new Blob([lines.map((l) => JSON.stringify(l)).join("\n")], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${dl.dataset.download.replace(/[^\w-]+/g, "_")}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  if (del && confirm(`Delete "${del.dataset.delete}" from this browser?`)) { await deleteLocal(del.dataset.delete); renderReplays(); }
});
$("tab-replays").addEventListener("change", async (e) => {
  if (e.target.id === "saveLocalToggle") { try { localStorage.setItem("undercut.saveLocal", e.target.checked ? "on" : "off"); } catch {} return; }
  if (e.target.id !== "recFile2") return;
  const f = e.target.files?.[0];
  if (f) { startReplay(parseRecording(await f.text()), f.name); $("tabs").querySelector('[data-tab="overview"]').click(); }
});

function render() {
  const v = view;
  const s = v.session;
  $("sessionName").textContent = [s.meeting, s.name].filter(Boolean).join(" · ") || "Waiting for session…";
  $("sessionSub").textContent = [s.circuit, s.status].filter(Boolean).join(" · ");
  $("lap").innerHTML = v.totalLaps ? `Lap ${v.lap} <span>/ ${v.totalLaps}</span>` : "";
  $("track").className = `chip ${v.track.tone}`;
  document.body.dataset.flag = v.track.tone;
  edgeFx(v);
  $("track").textContent = v.track.label;
  const w = v.weather;
  $("weather").textContent = w.air ? `Air ${w.air}° · Track ${w.track}° · ${w.rain ? "RAIN" : "Dry"}` : "";
  $("conn").className = `conn ${v.mode === "replay" ? "replay" : v.status.startsWith("Live") ? "live" : ""}`;
  $("connText").textContent = v.mode === "replay" && v.replayTime ? `Replay · ${v.replayTime.slice(11, 19)} UTC` : v.status;
  $("delayMenu").hidden = v.mode === "replay";
  document.title = v.totalLaps ? `L${v.lap}/${v.totalLaps} · Undercut` : "Undercut — live timing";

  renderStrip(v);
  // only draw the tab you're looking at — hidden tabs cost nothing
  if (tab === "overview") {
    renderRows(v);
    renderBattles(v);
    renderStory(v);
    renderRcm(v);
  }
  handleRadio(v);
  checkGame(v);
  if (tab === "schedule" && Date.now() - lastSched > 5000) drawSchedule(v);
  if (tab === "standings" && Date.now() - lastStand > 5000) drawStandings(v);
  if ((tab === "news" || tab === "technical") && Date.now() - lastNews > 30000) drawNews();
  pitLoss = pitProfile(v);
  if (shows("circle")) updateCircle(v);
  if (shows("tyres")) $("tyres").innerHTML = renderTyres(v);
  if (tab === "overview" && Date.now() - lastCalls > 1500) {
    lastCalls = Date.now();
    if (dashSet.has("stewards") && !$("stewards").querySelector("details[open]")) $("stewards").innerHTML = renderStewards(v, pitLoss);
    if (dashSet.has("pitwin")) $("pitwin").innerHTML = renderPitWindow(v, pitLoss);
  }
  if (tab === "overview" && dashSet.has("quali") && Date.now() - lastKnock > 700) {
    lastKnock = Date.now();
    $("knockout").innerHTML = renderKnockout(v);
  }
  if (shows("strategy") && Date.now() - lastStrategy > 2000) { lastStrategy = Date.now(); $("tab-strategy").innerHTML = renderStrategy(v, pitLoss) + renderPitTable(pitData, pitLoss.slug); }
  if (["compare", "rewind", "driver"].some(shows) && Date.now() - lastSlow > 2000) drawSlow(v);
}

// Tabs that don't need twice-a-second redraws. Skipped while you're using a dropdown.
function drawSlow(v) {
  if (document.activeElement?.tagName === "SELECT") return;
  lastSlow = Date.now();
  if (shows("compare")) $("tab-compare").innerHTML = renderCompare(v, cmpA, cmpB, telemetryFor(v));
  if (shows("rewind")) $("tab-rewind").innerHTML = renderRewind(v, rwFocus, rwMark);
  if (shows("driver")) $("tab-driver").innerHTML = renderDriver(v, dvSel, pitLoss);
}

// Clock for the circle: the data's own time, carried forward smoothly between updates.
let clockBase = { now: Date.now(), at: Date.now() };
function circleNow() {
  const rate = view?.mode === "replay" ? (player?.playing ? player.speed : 0) : 1;
  return clockBase.now + (Date.now() - clockBase.at) * rate;
}

const circleView = new CircleView($("circle"), (n) => {
  circleSel = circleSel === n ? null : n;
  if (view) updateCircle(view);
});
// Circle or real track map
const trackView = new TrackView($("trackMap"), circleView, (n) => {
  circleSel = circleSel === n ? null : n;
  if (view) updateCircle(view);
});
// the circle keeps computing positions even when only the track map is showing (the map reuses them)
function syncAnimation() {
  if (shows("circle")) circleView.start(); else circleView.stop();
  if (tab === "overview" && dashSet.has("track")) trackView.start(); else trackView.stop();
}

// Telemetry for Compare: this replay's session if archived, otherwise the latest archived
// session at the same circuit (so live races show, e.g., qualifying laps).
let replayKey = null;
const teleCache = {};
function telemetryFor(v) {
  const sessions = archive?.sessions ?? [];
  let key = replayKey;
  if (!key || !sessions.some((s) => s.key === key && s.telemetry)) {
    key = sessions.filter((s) => s.telemetry && circuitSlug(s.circuit) === circuitSlug(v.session.circuit))[0]?.key ?? null;
  }
  if (!archive) loadArchive().then(() => { lastSlow = 0; });
  if (!key) return null;
  // fastest laps of the session you're replaying would give the game away
  if (key === replayKey && player && $("plShield").checked && player.idx < player.lines.length - 5) return "shielded";
  if (!(key in teleCache)) {
    teleCache[key] = null;
    fetch(`data/telemetry/${key}.json`).then((r) => (r.ok ? r.json() : null)).then((t) => { teleCache[key] = t; lastSlow = 0; }).catch(() => {});
  }
  return teleCache[key];
}

function updateCircle(v) {
  if (v.now && v.now !== clockBase.now) clockBase = { now: v.now, at: Date.now() };
  circleView.setData(v, circleSel, pitLoss, circleNow);
  if (document.activeElement !== $("pitLoss")) $("pitLoss").value = Math.round(pitLoss.green);
  $("pitSrc").textContent = `(${pitLoss.source})`;
  $("pitReset").hidden = pitLoss.source !== "your number";
  if (dashSet.has("track")) {
    // archived races have every car's real position; otherwise cars are placed by timing
    const gpsKey = v.mode === "replay" && archive?.sessions?.some((s) => s.key === replayKey && s.gps) ? replayKey : null;
    if (gpsKey) loadGps(gpsKey).then((g) => trackView.setGps(g, circleNow));
    else trackView.setGps(null);
    loadTrack(v.session.circuit).then((pts) => trackView.setPoints(pts));
  }
  const sel = v.rows.find((r) => r.n === circleSel);
  $("circleSel").textContent = sel ? `Reference: ${sel.tla} — gaps are relative to them` : "Tap a car to make it the reference";
  $("circleClear").hidden = !sel;
}

function renderStrip(v) {
  $("stripCard").hidden = !v.totalLaps;
  if (!v.totalLaps) return;
  let html = "";
  for (let i = 1; i <= v.totalLaps; i++) {
    const ev = v.lapEvents[i];
    // a lap that's happened is blue unless something happened on it; the current lap is outlined
    const cls = [ev ?? (i < v.lap ? "done" : ""), i === v.lap ? "now" : ""].join(" ");
    const label = ev === "sc" ? "safety car / VSC" : ev === "red" ? "red flag" : ev === "yellow" ? "yellow flag" : ev === "pits" ? "lots of pit stops" : "";
    html += `<span class="${cls}" title="Lap ${i}${i === v.lap ? " (now)" : ""}${label ? ": " + label : ""}"></span>`;
  }
  $("lapStrip").innerHTML = html;
}

function renderRows(v) {
  if (!v.rows.length) return;
  const q = v.quali;
  const cutRow = q?.advance ? v.rows.find((r) => r.pos === q.advance) : null;
  const cutTime = cutRow ? lapSeconds(cutRow.best) : null;
  $("rows").innerHTML = v.rows.map((r) => {
    const close = parseFloat(String(r.int).replace("+", "")) < 1;
    const cls = [r.out || r.knockedOut ? "is-out" : "", r.inPit ? "in-pit" : "", close && !q ? "close" : "", q?.advance && r.pos > q.advance && !r.knockedOut ? "dropzone" : ""].join(" ");
    // places gained or lost since the start (F1 sends the grid; replays get it from OpenF1)
    const moved = !q && r.grid && r.pos < 99 ? r.grid - r.pos : 0;
    const grid = !q && r.grid ? `<span class="gridmove ${moved > 0 ? "up" : moved < 0 ? "down" : "muted"}" title="Started P${r.grid}">${moved > 0 ? "▲" + moved : moved < 0 ? "▼" + -moved : "="}</span>` : "";
    // stewarding: pending penalties, investigations, track limits strikes
    const sw = r.stw ?? {};
    const stw = (sw.pendingSecs ? `<span class="tag pen" title="Time penalty still to serve">+${sw.pendingSecs}s</span>` : "")
      + (sw.pendingOther ?? []).map((x) => `<span class="tag pen" title="Penalty to serve">${esc(x === "Drive-through" ? "DT" : "SG")}</span>`).join("")
      + (sw.investigating ? `<span class="tag inv" title="Under investigation">INV</span>` : "")
      + (sw.tl >= 2 || sw.tlFlag ? `<span class="tag tl ${sw.tl >= 3 || sw.tlFlag ? "hot" : ""}" title="Track limits: ${sw.tl} lap time${sw.tl === 1 ? "" : "s"} deleted${sw.tlFlag ? ", black and white flag shown" : ""}">TL ${sw.tl}</span>` : "");
    let tag = r.dsq ? `<span class="tag out">DSQ</span>` : r.out ? `<span class="tag out">OUT</span>` : r.knockedOut ? `<span class="tag out">KNOCKED OUT</span>` : r.inPit ? `<span class="tag pit">IN PIT</span>` : r.pitOut ? `<span class="tag pit">${q ? "OUT LAP" : "PIT EXIT"}</span>` : "";
    if (q && cutTime && r.pos > q.advance && !r.knockedOut) {
      const mine = lapSeconds(r.best);
      if (!mine) tag += `<span class="tag need">no time yet</span>`;
      else if (mine > cutTime) tag += `<span class="tag need">needs −${(mine - cutTime + 0.001).toFixed(3)}</span>`;
    }
    const sectors = [0, 1, 2].map((i) => {
      const sec = r.sectors[i] ?? { v: "", c: "", seg: [] };
      const segs = sec.seg.map((x) => `<i class="seg ${segClass(x)}"></i>`).join("");
      return `<td class="sector"><div class="t ${sec.c ? "c-" + sec.c : ""}">${esc(sec.v) || "&nbsp;"}</div><div class="segs">${segs}</div></td>`;
    }).join("");
    const line = q?.advance && r.pos === q.advance + 1
      ? `<tr class="cutline"><td colspan="13"><span>KNOCKOUT ZONE · top ${q.advance} go through to Q${q.part + 1}${cutRow?.best ? " · cutoff " + esc(cutRow.best) : ""}</span></td></tr>` : "";
    return `${line}<tr class="${cls}">
      <td class="num pos">${r.pos === 99 ? "–" : r.pos}</td>
      <td class="bar"><i style="background:${esc(r.colour)}"></i></td>
      <td><span class="drv" title="${esc(r.name)} · ${esc(r.team)}">${esc(r.tla)}</span>${grid}${tag}${stw}</td>
      <td class="num">${esc(r.gap)}</td>
      <td class="num int">${esc(r.int)}</td>
      <td class="num ${r.lastC ? "c-" + r.lastC : ""}">${esc(r.last)}</td>
      <td class="num ${r.bestC ? "c-" + r.bestC : ""}">${esc(r.best)}</td>
      ${sectors}
      <td class="num ${r.speedC ? "c-" + r.speedC : ""}">${esc(r.speed)}</td>
      <td><span class="tyre ${esc(r.tyre)} ${r.tyreNew ? "" : "used"}" title="${r.tyreNew ? "New" : "Used"} set">${esc(r.tyre)}</span><span class="age">${esc(r.tyreAge)}</span></td>
      <td class="num">${r.stops}</td>
    </tr>`;
  }).join("");
  $("qualiBadge").hidden = !q;
  if (q) $("qualiBadge").textContent = q.part ? `Q${q.part}` : "Qualifying";
  renderInsights(v);
}

// Three quick facts under the timing table
function renderInsights(v) {
  const rows = v.rows.filter((r) => r.pos < 99);
  const bestSec = [0, 1, 2].map((i) => {
    let best = null;
    for (const r of rows) { const s = lapSeconds(r.bestSectors[i]); if (s && (!best || s < best.s)) best = { s, tla: r.tla }; }
    return best;
  });
  const theo = bestSec.every(Boolean) ? bestSec.reduce((a, b) => a + b.s, 0) : null;
  let speed = null;
  for (const r of rows) { const st = parseFloat(r.bestSpeeds.st); if (st && (!speed || st > speed.v)) speed = { v: st, tla: r.tla }; }
  let spread = null;
  [0, 1, 2].forEach((i) => {
    const t = rows.filter((r) => !r.inPit && !r.out).map((r) => lapSeconds(r.sectors[i]?.v)).filter(Boolean);
    if (t.length < 5) return;
    t.sort((a, b) => a - b);
    const sp = t[Math.floor(t.length * 0.9)] - t[0]; // ignore the slowest 10% (traffic, pit lane)
    if (sp >= 0.05 && (!spread || sp > spread.sp)) spread = { i, sp };
  });
  const fmt = (s) => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`; };
  $("insights").innerHTML = `
    <div class="ins"><div class="muted small caps">Theoretical best lap</div><div class="ins-val">${theo ? fmt(theo) : "—"}</div>
      <div class="small muted">${theo ? `Best S1 (${esc(bestSec[0].tla)}) + S2 (${esc(bestSec[1].tla)}) + S3 (${esc(bestSec[2].tla)}) — nobody has put it all together` : "Needs a best time in every sector"}</div></div>
    <div class="ins"><div class="muted small caps">Speed trap leader</div><div class="ins-val">${speed ? `${speed.v} km/h · ${esc(speed.tla)}` : "—"}</div>
      <div class="small muted">Fastest at the main speed trap this session</div></div>
    <div class="ins"><div class="muted small caps">Where the time is</div><div class="ins-val">${spread ? `Sector ${spread.i + 1}` : "—"}</div>
      <div class="small muted">${spread ? `Biggest spread between cars on their latest laps — ${spread.sp.toFixed(1)}s` : "Needs sector times from most of the field"}</div></div>`;
}

function renderBattles(v) {
  if (v.quali) {
    $("battles").innerHTML = `<div class="muted small">Battles are for races — in qualifying everyone runs on their own. Watch the knockout zone in the timing table instead.</div>`;
    return;
  }
  if (!v.battles.length) {
    $("battles").innerHTML = `<div class="muted small">Nobody within a second of the car ahead right now.</div>`;
    return;
  }
  $("battles").innerHTML = v.battles.slice(0, 6).map((b) => {
    let trend = "";
    let cls = "";
    if (b.trend != null) {
      if (b.trend < -0.05) { trend = `closing ${Math.abs(b.trend).toFixed(2)}s/lap`; cls = "closing"; }
      else if (b.trend > 0.05) { trend = `dropping back ${b.trend.toFixed(2)}s/lap`; cls = "away"; }
      else trend = "holding steady";
    }
    return `<div class="battle">
      <div class="who"><i style="background:${esc(b.chaserColour)}"></i>${esc(b.chaser)} <span class="muted">→</span> <i style="background:${esc(b.aheadColour)}"></i>${esc(b.ahead)}</div>
      <div class="gap">${b.gap.toFixed(1)}s</div>
      <div class="trend ${cls}">${b.pos === 1 ? "for the lead" : `for P${b.pos}`}${trend ? " · " + trend : ""}</div>
      ${gapSpark(b.hist, cls)}
    </div>`;
  }).join("");
}

// tiny line of the gap over their last few laps (line going down = closing)
function gapSpark(h, cls) {
  if (!h || h.length < 2) return "";
  const max = Math.max(...h, 1), w = 120, ht = 26;
  const pts = h.map((g, i) => `${((i / (h.length - 1)) * (w - 4) + 2).toFixed(1)},${(ht - 2 - (g / max) * (ht - 4)).toFixed(1)}`).join(" ");
  const col = cls === "closing" ? "#2FD27A" : cls === "away" ? "#FF8A65" : "#6B7383";
  return `<svg class="spark" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"></polyline></svg>`;
}

const BADGE = { pit: "Pit", overtake: "Overtake", fastest: "Fastest lap", sc: "Safety car", red: "Red flag", green: "Green flag", out: "Retired" };
function renderStory(v) {
  if (!v.story.length) {
    $("story").innerHTML = `<div class="muted small">${v.watchingSince ? `Watching since lap ${v.watchingSince}. ` : ""}Pit stops, overtakes, fastest laps and safety cars will show up here as they happen.</div>`;
    return;
  }
  $("story").innerHTML = v.story.map((e) => `<div class="item">
    <div class="when">${e.lap ? "L" + e.lap : ""}</div>
    <div class="what"><span class="badge ${e.type}">${BADGE[e.type] ?? e.type}</span><div class="head">${esc(e.head)}</div>${e.body ? `<div class="note">${esc(e.body)}</div>` : ""}</div>
  </div>`).join("");
}

function renderRcm(v) {
  const items = v.rcm.filter((m) => rcFilter === "all" || m.cat === rcFilter);
  $("rcm").innerHTML = items.length ? items.map((m) => `<div class="item">
    <div class="flag ${m.flag}"></div>
    <div class="what">
      <div class="mono small muted">${m.lap ? "L" + esc(m.lap) + " · " : ""}${esc(m.t)}</div>
      <div class="head">${esc(m.text)}</div>
      ${m.note ? `<div class="note">${esc(m.note)}</div>` : ""}
    </div>
  </div>`).join("") : `<div class="muted small">No messages${rcFilter === "all" ? " yet" : " of this kind"}.</div>`;
}

$("rcFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  rcFilter = b.dataset.f;
  for (const x of $("rcFilters").children) x.classList.toggle("on", x === b);
  if (view) renderRcm(view);
});

// ---------- team radio ----------
// One shared audio player. The list is only rebuilt when a new clip arrives, so the
// play buttons don't get swapped out from under your mouse.
const radioPlayer = new Audio();
let playing = null;
let radioKey = "";
let heard = new Set();
let radioPrimed = false;
const PLAY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"></path></svg>`;
const STOP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`;

function handleRadio(v) {
  const clips = v.radio ?? [];
  // clips already there when the page opened aren't "new"
  if (!radioPrimed && clips.length) { for (const c of clips) heard.add(c.url); radioPrimed = true; }
  const fresh = clips.filter((c) => !heard.has(c.url));
  if (fresh.length && $("radioAuto").checked && !playing) play(fresh[fresh.length - 1].url);
  // transcripts: with "Transcribe" on and the model ready, every clip on screen gets one (newest first)
  const txOn = $("radioText").checked;
  if (txOn && tx.helper()) for (const c of [...clips].reverse()) if (!tx.transcriptOf(c.url) && !tx.stateOf(c.url)) tx.transcribe(c.url, false, c.name);
  const key = clips.map((c) => c.url).join("|") + (playing ?? "") + `|${txOn}|${txVersion}`;
  if (key === radioKey || tab !== "overview") return;
  radioKey = key;
  drawTxCard();
  $("radio").innerHTML = clips.length ? clips.map((c) => `<div class="radio-item ${heard.has(c.url) ? "" : "new"} ${playing === c.url ? "playing" : ""}">
    <button class="play ${playing === c.url ? "on" : ""}" data-url="${esc(c.url)}" aria-label="${playing === c.url ? "Stop" : "Play"} ${esc(c.name || c.tla)} radio">${playing === c.url ? STOP : PLAY}</button>
    <div class="radio-main">
      <div class="who"><i style="background:${esc(c.colour)}"></i>${esc(c.tla)}</div>
      <div class="meta">${c.lap ? "L" + c.lap + " · " : ""}${esc(c.t)} UTC${playing === c.url ? ` · <span class="mono" id="radioTime"></span>` : ""}</div>
      ${playing === c.url ? `<div class="rp-bar" id="radioBar" role="progressbar" aria-label="Clip progress" aria-valuemin="0" aria-valuemax="100"><i></i></div>` : ""}
      ${txOn || tx.transcriptOf(c.url) ? `<div class="tx">${txLine(c.url)}</div>` : ""}
    </div>
  </div>`).join("") : `<div class="muted small">No team radio yet this session.</div>`;
  updateRadioBar();
}

let txVersion = 0;
tx.onChange(() => { txVersion++; drawTxCard(); if (view) handleRadio(view); });
// drawn on its own so it shows even before any session data arrives
let txCardHtml = "";
function drawTxCard() {
  const html = $("radioText").checked ? txCard() : "";
  if (html !== txCardHtml) { txCardHtml = html; $("radioTx").innerHTML = html; }
}
function txLine(url) {
  const t = tx.transcriptOf(url);
  // each tag is a button: click it to swap driver/team if the guess is wrong
  if (t) return (Array.isArray(t) ? t : [{ who: null, text: t }]).map((l, i) => `<div class="tx-line">${l.text === "(no words picked up)" ? "" : `<button class="who-tag ${l.who === "Driver" ? "drv" : l.who === "Team" ? "team" : "unk"}" data-flip="${esc(url)}" data-i="${i}" title="${l.who ? `Wrong? Click to mark as ${l.who === "Driver" ? "team" : "driver"}` : "Not sure who this is — click to mark as driver, again for team"}">${l.who === "Driver" ? "DRIVER" : l.who === "Team" ? "TEAM" : "?"}</button>`}<span>${esc(l.text)}</span></div>`).join("");
  const st = tx.stateOf(url);
  if (st === "working") return `<span class="muted">transcribing…</span><div class="tx-busy"><i></i></div>`;
  if (st === "queued") return `<span class="muted">waiting to transcribe…</span>`;
  if (st === "blocked") return "";
  if (st) return `<span class="muted">${esc(st)}</span> <button class="linkbtn" data-tx="${esc(url)}">Try again</button>`;
  if (tx.helper()) return `<button class="linkbtn" data-tx="${esc(url)}">Transcribe</button>`;
  return "";
}
// the card at the top of the radio panel: download the speech model, with a progress bar
function txCard() {
  const h = tx.helper();
  if (h && !txEditing) return `<div class="tx-card ok small"><div>Radio helper connected — new clips are written out as text, each line marked driver or team — a best guess from the words and the voices. Click a tag to fix it.</div>
      ${tx.status.error ? `<div class="tx-err">${esc(tx.status.error)}</div>` : ""}
      <button class="linkbtn" id="txEdit">Change helper address</button></div>`;
  return `<div class="tx-card small">
      <div>F1's server won't let websites read its radio clips, so transcripts come from your own free <b>radio helper</b> on Cloudflare — it fetches each clip and turns the speech into text. Set it up once, about 5 minutes, no card needed.</div>
      <a href="https://github.com/Kris-Zhang-122507/f1timing/blob/main/tools/RADIO-HELPER.md" target="_blank" rel="noopener"><b>How to set up the radio helper</b></a>
      <form class="tx-helper" id="txHelperForm"><label class="sr" for="txHelper">Radio helper address</label>
        <input id="txHelper" placeholder="https://radio-helper.yourname.workers.dev" value="${esc(h)}" autocomplete="off">
        <button class="btn primary" type="submit">Save</button></form></div>`;
}
let txEditing = false;
$("radioTx").addEventListener("click", (e) => {
  if (e.target.id === "txEdit") { txEditing = true; drawTxCard(); $("txHelper")?.focus(); }
});
$("radioTx").addEventListener("submit", (e) => {
  if (e.target.id !== "txHelperForm") return;
  e.preventDefault();
  tx.setHelper($("txHelper").value);
  txEditing = false;
  drawTxCard();
  radioKey = "";
  if (view) handleRadio(view);
});
// playback progress for the clip that's playing
function updateRadioBar() {
  const bar = $("radioBar");
  if (!bar || !playing) return;
  const d = radioPlayer.duration, t = radioPlayer.currentTime;
  const pct = d > 0 ? (t / d) * 100 : 0;
  bar.firstElementChild.style.width = `${pct}%`;
  bar.setAttribute("aria-valuenow", String(Math.round(pct)));
  const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
  if ($("radioTime")) $("radioTime").textContent = d > 0 ? `${fmt(t)} / ${fmt(d)}` : "loading…";
}
radioPlayer.addEventListener("timeupdate", updateRadioBar);
radioPlayer.addEventListener("loadedmetadata", updateRadioBar);
try { $("radioText").checked = localStorage.getItem("undercut.radioText") === "1"; } catch {}
drawTxCard();
$("radioText").addEventListener("change", (e) => {
  try { localStorage.setItem("undercut.radioText", e.target.checked ? "1" : "0"); } catch {}
  drawTxCard();
  radioKey = "";
  if (view) handleRadio(view);
});
function play(url) {
  heard.add(url);
  if (playing === url) { radioPlayer.pause(); playing = null; }
  else { radioPlayer.src = url; radioPlayer.play().catch(() => { playing = null; radioKey = ""; if (view) handleRadio(view); }); playing = url; }
  radioKey = "";
  if (view) handleRadio(view);
}
radioPlayer.addEventListener("ended", () => { playing = null; radioKey = ""; if (view) handleRadio(view); });
$("radio").addEventListener("click", (e) => {
  const t = e.target.closest("button[data-tx]");
  if (t) { tx.transcribe(t.dataset.tx, true, view?.radio?.find((c) => c.url === t.dataset.tx)?.name ?? ""); return; }
  const f = e.target.closest("button[data-flip]");
  if (f) { tx.flip(f.dataset.flip, Number(f.dataset.i)); return; }
  const b = e.target.closest("button[data-url]");
  if (b) play(b.dataset.url);
});

// ---------- compare / rewind / my driver controls ----------
const redrawSlow = () => { lastSlow = 0; if (view) drawSlow(view); };
document.addEventListener("change", (e) => {
  if (e.target.id === "cmpA") { cmpA = e.target.value; e.target.blur(); redrawSlow(); }
  if (e.target.id === "cmpB") { cmpB = e.target.value; e.target.blur(); redrawSlow(); }
  if (e.target.id === "dvSel") {
    dvSel = e.target.value;
    try { localStorage.setItem("undercut.driver", dvSel); } catch {}
    e.target.blur(); redrawSlow();
  }
});
$("tab-rewind").addEventListener("click", (e) => {
  const line = e.target.closest(".rw-line");
  if (line) { rwFocus = rwFocus === line.dataset.n ? null : line.dataset.n; redrawSlow(); return; }
  const m = e.target.closest(".moment");
  if (m) { const l = Number(m.dataset.lap); rwMark = rwMark === l ? null : l; redrawSlow(); return; }
  if (e.target.id === "rwClear") { rwFocus = null; redrawSlow(); }
});
$("tab-driver").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-url]");
  if (b) play(b.dataset.url);
});

// "Explain it simply" shows the plain-English notes; "Just the facts" hides them
$("explain").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  for (const x of $("explain").children) x.classList.toggle("on", x === b);
  document.body.classList.toggle("facts-only", b.dataset.mode === "facts");
});

// ---------- schedule + pit-call game ----------
let races = null;
async function drawSchedule(v) {
  lastSched = Date.now();
  renderGame(v);
  try { races ??= await loadSchedule(); } catch { races = []; }
  $("schedBox").innerHTML = renderSchedule(races);
}

// Predict the lap a driver will pit on. Exact = 10 points, within 2 laps = 5.
function gameData() {
  try { return JSON.parse(localStorage.getItem("undercut.game")) ?? { points: 0, picks: {} }; } catch { return { points: 0, picks: {} }; }
}
function saveGame(g) { try { localStorage.setItem("undercut.game", JSON.stringify(g)); } catch {} }
const sessionId = (v) => `${v?.session?.meeting ?? ""}|${v?.session?.name ?? ""}`;
const isRaceSession = (v) => v?.totalLaps > 0 && !v.quali;

let gameKey = "";
function renderGame(v, force = false) {
  const box = $("pitGame");
  const g = gameData();
  const pick = g.picks[sessionId(v)];
  // only rebuild when something changed, so the form doesn't reset while you use it
  const key = `${sessionId(v)}|${isRaceSession(v)}|${v?.rows?.length ?? 0}|${JSON.stringify(pick ?? null)}|${g.points}`;
  if (key === gameKey && !force) return;
  gameKey = key;
  const head = `<div class="card-head"><h2>Pit-call game</h2><span class="mono">${g.points} pts</span></div>`;
  if (!v || !isRaceSession(v)) {
    box.innerHTML = `${head}<div class="muted small">Opens during races and sprints (live or replay). Guess the lap a driver pits: exact = 10 points, within 2 laps = 5.</div>`;
    return;
  }
  if (pick?.result) {
    const r = pick.result;
    box.innerHTML = `${head}<div>You called <b>${esc(pick.tla)}</b> on lap ${pick.lap}. They pitted on lap <b>${r.actual}</b> — ${r.pts ? `<span class="good">+${r.pts} points!</span>` : "no points this time."}</div>`;
    return;
  }
  if (pick) {
    box.innerHTML = `${head}<div>Locked in: <b>${esc(pick.tla)}</b> pits on <b>lap ${pick.lap}</b>. Waiting for their stop…</div><button class="btn" id="gameCancel">Change my pick</button>`;
    return;
  }
  if (!v.rows.length) { box.innerHTML = `${head}<div class="muted small">Waiting for timing data…</div>`; return; }
  const opts = v.rows.filter((r) => r.pos < 99 && !r.out).map((r) => `<option value="${esc(r.n)}">${esc(r.tla)} — P${r.pos}, ${esc(r.tyre)} ${esc(r.tyreAge)} laps</option>`).join("");
  box.innerHTML = `${head}
    <div class="game-form">
      <label>Driver <select id="gameDrv">${opts}</select></label>
      <label>Pits on lap <input type="number" id="gameLap" min="${v.lap + 1}" max="${v.totalLaps}" value="${Math.min(v.totalLaps, v.lap + 5)}"></label>
      <button class="btn primary" id="gameLock">Lock in</button>
    </div>
    <div class="muted small">Exact lap = 10 points · within 2 laps = 5. Scored automatically when they stop.</div>`;
}

function checkGame(v) {
  if (!v || !isRaceSession(v)) return;
  const g = gameData();
  const pick = g.picks[sessionId(v)];
  if (!pick || pick.result) return;
  const stop = [...v.story].reverse().find((e) => e.type === "pit" && e.head.startsWith(`${pick.tla} pits`) && (e.lap ?? 0) >= pick.madeOn);
  if (!stop) return;
  const diff = Math.abs(stop.lap - pick.lap);
  const pts = diff === 0 ? 10 : diff <= 2 ? 5 : 0;
  pick.result = { actual: stop.lap, pts };
  g.points += pts;
  saveGame(g);
  if (tab === "schedule") renderGame(v);
}

$("tab-schedule").addEventListener("click", (e) => {
  if (!view) return;
  if (e.target.id === "gameLock") {
    const n = $("gameDrv").value, lap = Number($("gameLap").value);
    const r = view.rows.find((x) => x.n === n);
    if (!r || !lap || lap <= view.lap) { $("gameLap").focus(); return; }
    const g = gameData();
    g.picks[sessionId(view)] = { n, tla: r.tla, lap, madeOn: view.lap };
    saveGame(g);
    document.activeElement?.blur();
    renderGame(view);
  }
  if (e.target.id === "gameCancel") {
    const g = gameData();
    delete g.picks[sessionId(view)];
    saveGame(g);
    renderGame(view);
  }
});

// ---------- standings ----------
async function drawStandings(v) {
  lastStand = Date.now();
  const box = $("standBox");
  if (v?.mode === "replay" && $("plShield").checked && !standingsOk) {
    box.innerHTML = `<section class="card"><h2>Standings</h2><div class="muted small">Hidden by the spoiler shield — the championship table and head to heads would tell you how this race ended.</div><button class="btn" id="standShow">Show anyway</button></section>`;
    $("h2hBox").innerHTML = "";
    return;
  }
  drawH2H();
  if (!box.innerHTML.trim()) box.innerHTML = renderStandings(null);
  try {
    const [st] = await Promise.all([loadStandings(), races ? null : loadSchedule().then((r) => { races = r; }).catch(() => {})]);
    const round = races ? currentWeekend(races)?.round : null;
    box.innerHTML = renderStandings(st, v, { live: v?.mode === "live", currentRound: round });
  } catch {
    box.innerHTML = `<section class="card"><div class="muted small">Couldn't load the standings right now.</div></section>`;
  }
}
// calendar file download from the Schedule tab
$("tab-schedule").addEventListener("click", async (e) => {
  const b = e.target.closest("#icsAll, #icsRaces");
  if (!b) return;
  const races = await loadSchedule().catch(() => null);
  if (!races) return;
  const blob = new Blob([calendarFile(races, { racesOnly: b.id === "icsRaces" })], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = b.id === "icsRaces" ? "f1-races.ics" : "f1-sessions.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
// head to head: drawn only when it loads or you pick drivers (not on every refresh)
let h2hA = null, h2hB = null, h2hDrawn = false;
try { [h2hA, h2hB] = JSON.parse(localStorage.getItem("undercut.h2h")) ?? []; } catch {}
async function drawH2H(force = false) {
  if (h2hDrawn && !force) return;
  if (!$("h2hBox").innerHTML) $("h2hBox").innerHTML = renderH2H(null);
  try {
    const season = await loadSeason();
    if (!h2hA && view?.rows?.length) { const me = view.rows.find((r) => r.n === dvSel); if (me) h2hA = me.tla; }
    $("h2hBox").innerHTML = renderH2H(season, h2hA, h2hB);
    h2hDrawn = true;
  } catch {
    $("h2hBox").innerHTML = `<section class="card"><h2>Head to head</h2><div class="muted small">Couldn't load this season's results right now.</div></section>`;
  }
}
$("h2hBox").addEventListener("change", (e) => {
  if (e.target.id === "h2hA") h2hA = e.target.value;
  if (e.target.id === "h2hB") h2hB = e.target.value;
  try { localStorage.setItem("undercut.h2h", JSON.stringify([h2hA, h2hB])); } catch {}
  drawH2H(true);
});
$("tab-standings").addEventListener("click", (e) => { if (e.target.id === "standShow") { standingsOk = true; drawStandings(view); } });

// ---------- news + technical ----------
async function drawNews() {
  lastNews = Date.now();
  const news = await loadNews();
  if (tab === "news") { $("tab-news").innerHTML = renderNews(news, newsFilter); return; }
  if (tab !== "technical") return;
  const nav = `<div class="filters subnav" id="techNav">${[["upgrades", "Car upgrades"], ["pu", "Power units"], ["cost", "Crash costs"], ["analysis", "Crash analysis & headlines"]].map(([k, l]) => `<button data-tech-view="${k}" class="${techView === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (techView === "upgrades") { $("tab-technical").innerHTML = nav + renderUpgrades(await loadTechnical(), techPick); return; }
  if (techView === "pu") { $("tab-technical").innerHTML = nav + renderPowerUnits(await loadTechnical(), puOpen); return; }
  if (techView === "cost") { $("tab-technical").innerHTML = nav + renderCrashCost(await loadCrashCost(), ccUi); return; }
  const idx = await loadIncidentIndex();
  const withIncidents = (idx?.sessions ?? []).filter((s) => s.incidents.length);
  const key = techKey ?? withIncidents[0]?.key ?? null;
  const session = key ? await loadIncidents(key) : null;
  if (document.activeElement?.id !== "techSession") $("tab-technical").innerHTML = nav + renderTechnical(news, idx, session, key);
}
$("tab-news").addEventListener("click", (e) => {
  const b = e.target.closest("#newsFilters button");
  if (b) { newsFilter = b.dataset.f; drawNews(); }
});
$("tab-technical").addEventListener("click", (e) => {
  const v = e.target.closest("[data-tech-view]");
  if (v) { techView = v.dataset.techView; return drawNews(); }
  const up = e.target.closest("[data-up-round]");
  if (up) { techPick = { round: Number(up.dataset.upRound), team: up.dataset.upTeam ?? null }; return drawNews(); }
  const pu = e.target.closest("[data-pu]");
  if (pu) { puOpen = puOpen === pu.dataset.pu ? null : pu.dataset.pu; return drawNews(); }
  const by = e.target.closest("#ccBy [data-by]");
  if (by) { ccUi.ccBy = by.dataset.by; return drawNews(); }
  const cum = e.target.closest("#ccCum [data-cum]");
  if (cum) { ccUi.ccCum = cum.dataset.cum === "1"; return drawNews(); }
});
$("tab-technical").addEventListener("keydown", (e) => {
  const pu = e.target.closest?.("[data-pu]");
  if (pu && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); puOpen = puOpen === pu.dataset.pu ? null : pu.dataset.pu; drawNews(); }
});
$("tab-technical").addEventListener("change", (e) => {
  if (e.target.id === "techSession") { techKey = Number(e.target.value); e.target.blur(); drawNews(); }
});

// ---------- rain watch (Open-Meteo, free) ----------
let wx = { at: 0, html: "" };
async function updateWeather() {
  if (view?.mode === "replay") { $("weatherBox").innerHTML = `<div class="muted small">The forecast is for live sessions — replays show the weather as it was in the header.</div>`; return; }
  if (Date.now() - wx.at < 10 * 60e3 && wx.html) { $("weatherBox").innerHTML = wx.html; return; }
  try {
    races ??= await loadSchedule();
    const w = currentWeekend(races);
    if (!Number.isFinite(w?.lat)) throw new Error("no circuit");
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${w.lat}&longitude=${w.lon}&minutely_15=precipitation,precipitation_probability&forecast_minutely_15=8&timezone=UTC`);
    const d = (await r.json()).minutely_15;
    const blocks = d.time.map((t, i) => ({ t: new Date(t + "Z"), mm: d.precipitation[i] ?? 0, p: d.precipitation_probability?.[i] ?? 0 }));
    const first = blocks.find((b) => b.mm >= 0.1 || b.p >= 50);
    const mins = first ? Math.max(0, Math.round((first.t - Date.now()) / 60e3)) : null;
    const msg = !first ? `Dry at ${esc(w.locality)} for the next 2 hours.` : mins <= 5 ? `Rain at ${esc(w.locality)} now or any minute.` : `Rain likely at ${esc(w.locality)} in about ${mins} minutes${view?.refLap ? ` (~${Math.max(1, Math.round((mins * 60) / view.refLap))} laps)` : ""}.`;
    wx = { at: Date.now(), html: `<div class="rain">${blocks.map((b) => `<span title="${b.t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}: ${b.p}% chance, ${b.mm} mm" style="background:${b.mm >= 1 ? "#2B6CB0" : b.mm >= 0.1 || b.p >= 50 ? "#1E4E73" : b.p >= 25 ? "#14324A" : "#1A1E27"}"></span>`).join("")}</div>
      <div class="rain-axis muted small"><span>now</span><span>+1h</span><span>+2h</span></div>
      <div class="small ${first ? "warn" : "muted"}">${msg}</div>` };
    $("weatherBox").innerHTML = wx.html;
  } catch {
    $("weatherBox").innerHTML = `<div class="muted small">Forecast unavailable right now.</div>`;
  }
}
setInterval(updateWeather, 60e3);
setTimeout(updateWeather, 1500);

// ---------- tabs + circle controls ----------
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  for (const x of $("tabs").querySelectorAll("button[data-tab]")) x.classList.toggle("on", x === b);
  showTabs();
  $("dashTools").hidden = tab !== "overview";
  if (tab === "news" || tab === "technical") drawNews();
  if (tab === "standings") { lastStand = 0; drawStandings(view); }
  if (tab === "schedule") { lastSched = 0; drawSchedule(view); }
  if (tab === "replays") renderReplays();
  lastStrategy = 0;
  lastSlow = 0;
  syncAnimation();
  if (view) render();
});
const ALL_TABS = ["overview", "strategy", "compare", "rewind", "driver", "replays", "schedule", "standings", "news", "technical"];
function showTabs() {
  for (const t of ALL_TABS) $(`tab-${t}`).hidden = !shows(t);
}

// The Live dashboard: movable, resizable panels. Strategy / My driver / Rewind can be panels
// too — while they are, their tab button hides so nothing is drawn twice.
const dash = new Dashboard({
  onChange: (set) => {
    dashSet = set;
    for (const t of ["strategy", "rewind", "driver"]) $("tabs").querySelector(`[data-tab="${t}"]`).hidden = set.has(t);
    if (set.has(tab)) $("tabs").querySelector('[data-tab="overview"]').click();
    showTabs();
    syncAnimation();
    lastStrategy = 0; lastSlow = 0;
    if (view) render();
  },
});
dash.wireControls();

// ---------- edge glow: the screen border lights up briefly when something happens ----------
// Safety car / VSC / red flag keep a steady thin border while they last. One pulse at a time,
// at most every few seconds, and bursts (opening a replay, jumping ahead) are skipped.
let fxOn = true;
try { fxOn = localStorage.getItem("undercut.fx") !== "0"; } catch {}
const FX = { sc: "#FFB547", red: "#FF4D4D", green: "#2FD27A", fastest: "#B47CFF", overtake: "#4A90E2", pit: "#4A90E2", out: "#FF4D4D", chequered: "#E8EAF0" };
const fxSeen = new Set();
let fxPrimed = false, fxLast = 0, fxStatus = "";
function pulse(colour) {
  const el = $("edgePulse");
  el.style.setProperty("--c", colour);
  el.classList.remove("on"); void el.offsetWidth; el.classList.add("on");
  fxLast = Date.now();
}
function edgeFx(v) {
  const steady = { amber: "amber", red: "red" }[v.track.tone] ?? "";
  $("edge").className = `edge ${fxOn ? steady : ""}`;
  const fresh = v.story.filter((e) => !fxSeen.has(`${e.t}|${e.head}`));
  for (const e of fresh) fxSeen.add(`${e.t}|${e.head}`);
  const finished = /Finished|Ends/i.test(v.session.status ?? "");
  const chequered = finished && fxStatus && !/Finished|Ends/i.test(fxStatus);
  fxStatus = v.session.status ?? "";
  if (!fxPrimed) { fxPrimed = true; return; }          // don't light up for what was already there
  if (!fxOn || fresh.length > 3) return;              // a burst = page load or a replay jump
  if (chequered) return pulse(FX.chequered);
  if (Date.now() - fxLast < 4000) return;
  const mine = v.rows.find((r) => r.n === dvSel)?.tla;
  // what's worth a glow: flags, fastest laps, the podium changing, and anything about your driver
  const worth = fresh.filter((e) => ["sc", "red", "green", "fastest", "out"].includes(e.type)
    || (e.type === "overtake" && /for P[123]\b/.test(e.head))
    || (mine && e.head.includes(mine)));
  const order = ["red", "sc", "green", "out", "fastest", "overtake", "pit"];
  worth.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  if (worth[0]) pulse(FX[worth[0].type] ?? "#E8EAF0");
}
$("fxBtn").setAttribute("aria-pressed", String(fxOn));
$("fxBtn").addEventListener("click", () => {
  fxOn = !fxOn;
  try { localStorage.setItem("undercut.fx", fxOn ? "1" : "0"); } catch {}
  $("fxBtn").setAttribute("aria-pressed", String(fxOn));
  if (fxOn) pulse("#FFB547"); else $("edge").className = "edge";
});

// Car telemetry panel (speed, gear, throttle, brake, RPM) — follows "My driver"
const carTele = new CarTelemetry($("carTele"));
let lastTele = 0;
(function teleLoop(ts) {
  requestAnimationFrame(teleLoop);
  if (ts - lastTele < 110 || tab !== "overview" || !dashSet.has("car") || !view) return;
  if (document.activeElement?.id === "teleSel") return;
  lastTele = ts;
  const drivers = view.rows.filter((r) => r.pos < 99).map((r) => ({ n: r.n, tla: r.tla, name: r.name, colour: r.colour, speed: r.speed }));
  const replay = view.mode === "replay";
  carTele.render({ drivers, sel: dvSel, session: replay ? replayKey : null, t: replay ? player?.now : Date.now(), live: !replay });
})(0);
$("carTele").addEventListener("change", (e) => {
  if (e.target.id !== "teleSel") return;
  dvSel = e.target.value;
  try { localStorage.setItem("undercut.driver", dvSel); } catch {}
  lastSlow = 0;
  e.target.blur();
});
$("circleClear").addEventListener("click", () => { circleSel = null; if (view) updateCircle(view); });
$("pitLoss").addEventListener("input", (e) => {
  const n = Number(e.target.value), slug = pitProfile(view).slug;
  if (!slug || !(n >= 5 && n <= 60)) return;
  pitMine[slug] = n;
  try { localStorage.setItem("undercut.pitLossBy", JSON.stringify(pitMine)); } catch {}
  pitLoss = pitProfile(view);
  if (view) updateCircle(view);
});
$("pitReset").addEventListener("click", () => {
  delete pitMine[pitProfile(view).slug];
  try { localStorage.setItem("undercut.pitLossBy", JSON.stringify(pitMine)); } catch {}
  pitLoss = pitProfile(view);
  if (view) updateCircle(view);
});

// Session clock counts down between updates
setInterval(() => {
  if (!view?.clock?.remaining) { $("clock").textContent = ""; return; }
  const [h, m, s] = view.clock.remaining.split(":").map(Number);
  let secs = h * 3600 + m * 60 + s;
  if (view.clock.running && view.mode === "live" && view.clock.utc) secs -= Math.max(0, (Date.now() - Date.parse(view.clock.utc)) / 1000);
  secs = Math.max(0, Math.round(secs));
  const t = `${Math.floor(secs / 3600)}:${String(Math.floor(secs / 60) % 60).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  $("clock").textContent = `${t} left`;
}, 1000);

if (standalone) connectDirect(); else connect();
