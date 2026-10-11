// Undercut page: draws the race view, from the Undercut server or worked out right here.
import { LiveState } from "./lib/state.js?v=mv3tqc3z";
import { Race } from "./lib/race.js?v=mv3tqc3z";
import { renderCircle } from "./circle.js?v=mv3tqc3z";
import { renderTyres } from "./tyres.js?v=mv3tqc3z";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let view = null;
let rcFilter = "all";
let tab = "overview";
let circleSel = null;
let pitLoss = 24;
try { pitLoss = Number(localStorage.getItem("undercut.pitLoss")) || 24; } catch {}

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
  "DriverList", "TimingData", "TimingAppData", "TimingStats", "TopThree", "RaceControlMessages", "WeatherData", "TeamRadio"];
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
      if (m.type === 1 && m.target === "feed") { gotData = true; feed(m.arguments[0], m.arguments[1]); }
      else if (m.type === 3 && m.invocationId === "0") {
        if (m.error) engine.status = `F1 refused the subscription: ${m.error}`;
        else { gotData = true; for (const [t, d] of Object.entries(m.result ?? {})) feed(t, d); engine.status = "Live · direct from F1"; }
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

// Replay a recording file (from npm start or the capture script) right here in the page.
async function replayFile(file, speed) {
  useServer = false;
  serverSocket?.close();
  const ds = directSocket;
  directSocket = null;
  ds?.close();
  newEngine("replay", `Replaying ${file.name}`);
  const myEngine = engine;
  let simNow = null;
  engine.race.now = () => simNow ?? Date.now();
  const lines = (await file.text()).split("\n");
  let prevT = null;
  for (const line of lines) {
    if (engine !== myEngine) return; // another file was loaded
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const t = Date.parse(msg.t);
    if (prevT !== null && t > prevT) await new Promise((r) => setTimeout(r, Math.min(3000, (t - prevT) / speed())));
    prevT = t;
    if (Number.isFinite(t)) simNow = t;
    engine.replayTime = msg.t;
    if (msg.snapshot) for (const [k, d] of Object.entries(msg.snapshot)) feed(k, d);
    else if (msg.topic) feed(msg.topic, msg.data);
  }
  engine.status = "Replay finished";
}

$("recFile").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) replayFile(f, () => Number($("recSpeed").value) || 1);
  e.target.value = "";
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
  renderRows(v);
  renderBattles(v);
  renderStory(v);
  renderRcm(v);
  if (tab === "circle") renderCircleTab(v);
  if (tab === "tyres") $("tyres").innerHTML = renderTyres(v);
}

function renderCircleTab(v) {
  $("circle").innerHTML = renderCircle(v, circleSel, pitLoss);
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
    const cls = ev ?? (i < v.lap ? "done" : i === v.lap ? "now" : "");
    const label = ev === "sc" ? "safety car / VSC" : ev === "yellow" ? "yellow flag" : ev === "pits" ? "lots of pit stops" : "";
    html += `<span class="${cls}" title="Lap ${i}${label ? ": " + label : ""}"></span>`;
  }
  $("lapStrip").innerHTML = html;
}

function renderRows(v) {
  if (!v.rows.length) return;
  $("rows").innerHTML = v.rows.map((r) => {
    const close = parseFloat(String(r.int).replace("+", "")) < 1;
    const cls = [r.out || r.knockedOut ? "is-out" : "", r.inPit ? "in-pit" : "", close ? "close" : ""].join(" ");
    const tag = r.out ? `<span class="tag out">OUT</span>` : r.inPit ? `<span class="tag pit">IN PIT</span>` : r.pitOut ? `<span class="tag pit">PIT EXIT</span>` : "";
    const sectors = [0, 1, 2].map((i) => {
      const sec = r.sectors[i] ?? { v: "", c: "", seg: [] };
      const segs = sec.seg.map((x) => `<i class="seg ${segClass(x)}"></i>`).join("");
      return `<td class="sector"><div class="t ${sec.c ? "c-" + sec.c : ""}">${esc(sec.v) || "&nbsp;"}</div><div class="segs">${segs}</div></td>`;
    }).join("");
    return `<tr class="${cls}">
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
}

function renderBattles(v) {
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
    </div>`;
  }).join("");
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

// ---------- tabs + circle controls ----------
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  tab = b.dataset.tab;
  for (const x of $("tabs").children) x.classList.toggle("on", x === b);
  for (const t of ["overview", "circle", "tyres"]) $(`tab-${t}`).hidden = t !== tab;
  if (view) render();
});
$("circle").addEventListener("click", (e) => {
  const hit = e.target.closest("[data-n]");
  if (!hit) return;
  circleSel = circleSel === hit.dataset.n ? null : hit.dataset.n;
  if (view) renderCircleTab(view);
});
$("circleClear").addEventListener("click", () => { circleSel = null; if (view) renderCircleTab(view); });
$("pitLoss").value = pitLoss;
$("pitLoss").addEventListener("input", (e) => {
  pitLoss = Number(e.target.value) || 24;
  try { localStorage.setItem("undercut.pitLoss", String(pitLoss)); } catch {}
  if (view) renderCircleTab(view);
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
