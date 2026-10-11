// Undercut page: receives the race view from the server and draws it.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let view = null;
let rcFilter = "all";

// Minisector status codes from the F1 feed
function segClass(s) {
  if (s === 2051) return "p";
  if (s === 2049) return "g";
  if (s === 2064) return "b";
  if (s === 2048 || s === 2052) return "y";
  return "";
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (e) => { view = JSON.parse(e.data); render(); };
  ws.onclose = () => {
    $("conn").className = "conn";
    $("connText").textContent = "Disconnected from the Undercut server — retrying…";
    setTimeout(connect, 2000);
  };
}

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
  if (!v.story.length) return;
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

connect();
