// Undercut page: draws the race view, from the Undercut server or worked out right here.
import { LiveState } from "./lib/state.js?v=mv4bb03z";
import { Race, lapSeconds } from "./lib/race.js?v=mv4bb03z";
import { CircleView } from "./circle.js?v=mv4bb03z";
import { renderTyres } from "./tyres.js?v=mv4bb03z";
import { renderStrategy, renderPitTable } from "./strategy.js?v=mv4bb03z";
import { renderCompare } from "./compare.js?v=mv4bb03z";
import { renderRewind } from "./rewind.js?v=mv4bb03z";
import { renderDriver } from "./driver.js?v=mv4bb03z";
import { Player, parseRecording } from "./player.js?v=mv4bb03z";
import { loadSchedule, currentWeekend, renderSchedule } from "./schedule.js?v=mv4bb03z";
import { TrackView, loadTrack, circuitSlug } from "./track.js?v=mv4bb03z";
import { loadStandings, renderStandings } from "./standings.js?v=mv4bb03z";
import { loadNews, loadIncidentIndex, loadIncidents, renderNews, renderTechnical } from "./news.js?v=mv4bb03z";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let view = null;
let rcFilter = "all";
let tab = "overview";
let lastStrategy = 0;
let lastSched = 0;
let lastStand = 0;
let lastNews = 0;
let newsFilter = "all";
let techKey = null;
let standingsOk = false; // "show anyway" past the spoiler shield
let lastSlow = 0;          // compare / rewind / my driver redraw every 2s (their numbers change per lap)
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
  serverSocket.onmessage = (e) => { if (useServer) { view = JSON.parse(e.data); render(); } };
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
  "DriverList", "TimingData", "TimingAppData", "TimingStats", "TopThree", "RaceControlMessages", "WeatherData", "TeamRadio", "PitLaneTimeCollection"];
let directSocket = null;

function connectDirect() {
  if (!engine || engine.mode !== "live") newEngine("live", "Connecting to F1 from your browser…");
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
      if (m.type === 1 && m.target === "feed") { gotData = true; feed(m.arguments[0], m.arguments[1]); saveLocal(m.arguments[0], m.arguments[1]); }
      else if (m.type === 3 && m.invocationId === "0") {
        if (m.error) engine.status = `F1 refused the subscription: ${m.error}`;
        else { gotData = true; for (const [t, d] of Object.entries(m.result ?? {})) { feed(t, d); saveLocal(t, d); } engine.status = "Live · direct from F1"; }
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
if (params.has("debug")) window.undercut = { saveLocal, flushLocal, localSessions, newEngine, feed, get engine() { return engine; } };
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
  $("track").textContent = v.track.label;
  const w = v.weather;
  $("weather").textContent = w.air ? `Air ${w.air}° · Track ${w.track}° · ${w.rain ? "RAIN" : "Dry"}` : "";
  $("conn").className = `conn ${v.mode === "replay" ? "replay" : v.status.startsWith("Live") ? "live" : ""}`;
  $("connText").textContent = v.mode === "replay" && v.replayTime ? `Replay · ${v.replayTime.slice(11, 19)} UTC` : v.status;
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
  if (tab === "circle") updateCircle(v);
  if (tab === "tyres") $("tyres").innerHTML = renderTyres(v);
  if (tab === "strategy" && Date.now() - lastStrategy > 2000) { lastStrategy = Date.now(); $("tab-strategy").innerHTML = renderStrategy(v, pitLoss) + renderPitTable(pitData, pitLoss.slug); }
  if (["compare", "rewind", "driver"].includes(tab) && Date.now() - lastSlow > 2000) drawSlow(v);
}

// Tabs that don't need twice-a-second redraws. Skipped while you're using a dropdown.
function drawSlow(v) {
  if (document.activeElement?.tagName === "SELECT") return;
  lastSlow = Date.now();
  if (tab === "compare") $("tab-compare").innerHTML = renderCompare(v, cmpA, cmpB, telemetryFor(v));
  if (tab === "rewind") $("tab-rewind").innerHTML = renderRewind(v, rwFocus, rwMark);
  if (tab === "driver") $("tab-driver").innerHTML = renderDriver(v, dvSel, pitLoss);
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
let circleMode = "circle";
const trackView = new TrackView($("trackMap"), circleView, (n) => {
  circleSel = circleSel === n ? null : n;
  if (view) updateCircle(view);
});
function setCircleMode(mode) {
  circleMode = mode;
  $("viewCircle").classList.toggle("on", mode === "circle");
  $("viewTrack").classList.toggle("on", mode === "track");
  $("circle").hidden = mode !== "circle";
  $("trackMap").hidden = mode !== "track";
  if (mode === "track" && tab === "circle") trackView.start(); else trackView.stop();
  if (view) updateCircle(view);
}
$("viewCircle").addEventListener("click", () => setCircleMode("circle"));
$("viewTrack").addEventListener("click", () => setCircleMode("track"));

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
  if (circleMode === "track") loadTrack(v.session.circuit).then((pts) => trackView.setPoints(pts));
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
    let tag = r.out ? `<span class="tag out">OUT</span>` : r.knockedOut ? `<span class="tag out">KNOCKED OUT</span>` : r.inPit ? `<span class="tag pit">IN PIT</span>` : r.pitOut ? `<span class="tag pit">${q ? "OUT LAP" : "PIT EXIT"}</span>` : "";
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
      <td><span class="drv" title="${esc(r.name)} · ${esc(r.team)}">${esc(r.tla)}</span>${tag}</td>
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
  const key = clips.map((c) => c.url).join("|") + (playing ?? "");
  if (key === radioKey || tab !== "overview") return;
  radioKey = key;
  $("radio").innerHTML = clips.length ? clips.map((c) => `<div class="radio-item ${heard.has(c.url) ? "" : "new"}">
    <button class="play ${playing === c.url ? "on" : ""}" data-url="${esc(c.url)}" aria-label="${playing === c.url ? "Stop" : "Play"} ${esc(c.name || c.tla)} radio">${playing === c.url ? STOP : PLAY}</button>
    <div>
      <div class="who"><i style="background:${esc(c.colour)}"></i>${esc(c.tla)}</div>
      <div class="meta">${c.lap ? "L" + c.lap + " · " : ""}${esc(c.t)} UTC</div>
    </div>
  </div>`).join("") : `<div class="muted small">No team radio yet this session.</div>`;
}

function play(url) {
  heard.add(url);
  if (playing === url) { radioPlayer.pause(); playing = null; }
  else { radioPlayer.src = url; radioPlayer.play().catch(() => { playing = null; radioKey = ""; if (view) handleRadio(view); }); playing = url; }
  radioKey = "";
  if (view) handleRadio(view);
}
radioPlayer.addEventListener("ended", () => { playing = null; radioKey = ""; if (view) handleRadio(view); });
$("radio").addEventListener("click", (e) => {
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
  const box = $("tab-standings");
  if (v?.mode === "replay" && $("plShield").checked && !standingsOk) {
    box.innerHTML = `<section class="card"><h2>Standings</h2><div class="muted small">Hidden by the spoiler shield — the championship table would tell you how this race ended.</div><button class="btn" id="standShow">Show anyway</button></section>`;
    return;
  }
  if (!box.innerHTML.trim()) box.innerHTML = renderStandings(null);
  try {
    const [st] = await Promise.all([loadStandings(), races ? null : loadSchedule().then((r) => { races = r; }).catch(() => {})]);
    const round = races ? currentWeekend(races)?.round : null;
    box.innerHTML = renderStandings(st, v, { live: v?.mode === "live", currentRound: round });
  } catch {
    box.innerHTML = `<section class="card"><div class="muted small">Couldn't load the standings right now.</div></section>`;
  }
}
$("tab-standings").addEventListener("click", (e) => { if (e.target.id === "standShow") { standingsOk = true; drawStandings(view); } });

// ---------- news + technical ----------
async function drawNews() {
  lastNews = Date.now();
  const news = await loadNews();
  if (tab === "news") { $("tab-news").innerHTML = renderNews(news, newsFilter); return; }
  if (tab !== "technical") return;
  const idx = await loadIncidentIndex();
  const withIncidents = (idx?.sessions ?? []).filter((s) => s.incidents.length);
  const key = techKey ?? withIncidents[0]?.key ?? null;
  const session = key ? await loadIncidents(key) : null;
  if (document.activeElement?.id !== "techSession") $("tab-technical").innerHTML = renderTechnical(news, idx, session, key);
}
$("tab-news").addEventListener("click", (e) => {
  const b = e.target.closest("#newsFilters button");
  if (b) { newsFilter = b.dataset.f; drawNews(); }
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
  const b = e.target.closest("button");
  if (!b) return;
  tab = b.dataset.tab;
  for (const x of $("tabs").children) x.classList.toggle("on", x === b);
  for (const t of ["overview", "circle", "tyres", "strategy", "compare", "rewind", "driver", "replays", "schedule", "standings", "news", "technical"]) $(`tab-${t}`).hidden = t !== tab;
  if (tab === "news" || tab === "technical") drawNews();
  if (tab === "standings") { lastStand = 0; drawStandings(view); }
  if (tab === "schedule") { lastSched = 0; drawSchedule(view); }
  if (tab === "replays") renderReplays();
  lastStrategy = 0;
  lastSlow = 0;
  if (tab === "circle") circleView.start(); else circleView.stop();
  if (tab === "circle" && circleMode === "track") trackView.start(); else trackView.stop();
  if (view) render();
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
