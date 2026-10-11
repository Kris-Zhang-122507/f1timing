// Undercut page: draws the race view, from the Undercut server or worked out right here.
import { LiveState } from "./lib/state.js?v=mv3va7yn";
import { Race, lapSeconds } from "./lib/race.js?v=mv3va7yn";
import { CircleView } from "./circle.js?v=mv3va7yn";
import { renderTyres } from "./tyres.js?v=mv3va7yn";
import { renderStrategy } from "./strategy.js?v=mv3va7yn";
import { renderCompare } from "./compare.js?v=mv3va7yn";
import { renderRewind } from "./rewind.js?v=mv3va7yn";
import { renderDriver } from "./driver.js?v=mv3va7yn";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let view = null;
let rcFilter = "all";
let tab = "overview";
let lastStrategy = 0;
let lastSlow = 0;          // compare / rewind / my driver redraw every 2s (their numbers change per lap)
let cmpA = null, cmpB = null, rwFocus = null, rwMark = null;
let dvSel = null;
try { dvSel = localStorage.getItem("undercut.driver"); } catch {}
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
  // only draw the tab you're looking at — hidden tabs cost nothing
  if (tab === "overview") {
    renderRows(v);
    renderBattles(v);
    renderStory(v);
    renderRcm(v);
  }
  handleRadio(v);
  if (tab === "circle") updateCircle(v);
  if (tab === "tyres") $("tyres").innerHTML = renderTyres(v);
  if (tab === "strategy" && Date.now() - lastStrategy > 2000) { lastStrategy = Date.now(); $("tab-strategy").innerHTML = renderStrategy(v, pitLoss); }
  if (["compare", "rewind", "driver"].includes(tab) && Date.now() - lastSlow > 2000) drawSlow(v);
}

// Tabs that don't need twice-a-second redraws. Skipped while you're using a dropdown.
function drawSlow(v) {
  if (document.activeElement?.tagName === "SELECT") return;
  lastSlow = Date.now();
  if (tab === "compare") $("tab-compare").innerHTML = renderCompare(v, cmpA, cmpB);
  if (tab === "rewind") $("tab-rewind").innerHTML = renderRewind(v, rwFocus, rwMark);
  if (tab === "driver") $("tab-driver").innerHTML = renderDriver(v, dvSel, pitLoss);
}

// Clock for the circle: the data's own time, carried forward smoothly between updates.
let clockBase = { now: Date.now(), at: Date.now() };
function circleNow() {
  const rate = view?.mode === "replay" ? (Number($("recSpeed").value) || 1) : 1;
  return clockBase.now + (Date.now() - clockBase.at) * rate;
}

const circleView = new CircleView($("circle"), (n) => {
  circleSel = circleSel === n ? null : n;
  if (view) updateCircle(view);
});
function updateCircle(v) {
  if (v.now && v.now !== clockBase.now) clockBase = { now: v.now, at: Date.now() };
  circleView.setData(v, circleSel, pitLoss, circleNow);
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
const player = new Audio();
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
  if (playing === url) { player.pause(); playing = null; }
  else { player.src = url; player.play().catch(() => { playing = null; radioKey = ""; if (view) handleRadio(view); }); playing = url; }
  radioKey = "";
  if (view) handleRadio(view);
}
player.addEventListener("ended", () => { playing = null; radioKey = ""; if (view) handleRadio(view); });
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

// ---------- tabs + circle controls ----------
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  tab = b.dataset.tab;
  for (const x of $("tabs").children) x.classList.toggle("on", x === b);
  for (const t of ["overview", "circle", "tyres", "strategy", "compare", "rewind", "driver"]) $(`tab-${t}`).hidden = t !== tab;
  lastStrategy = 0;
  lastSlow = 0;
  if (tab === "circle") circleView.start(); else circleView.stop();
  if (view) render();
});
$("circleClear").addEventListener("click", () => { circleSel = null; if (view) updateCircle(view); });
$("pitLoss").value = pitLoss;
$("pitLoss").addEventListener("input", (e) => {
  pitLoss = Number(e.target.value) || 24;
  try { localStorage.setItem("undercut.pitLoss", String(pitLoss)); } catch {}
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
