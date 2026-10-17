// Lights Out: five red lights come on one a second, hold for a random moment, then go out.
// React as fast as you can. Too early is a jump start.
import { load, save } from "./common.js?v=mvc4lmfh";
import { sfx } from "./sfx.js?v=mvc4lmfh";

const VERDICTS = [
  [150, "Lightning! That's F1 level — or a very good guess", "good"],
  [200, "F1 driver territory", "good"],
  [250, "Great start — right on the pace", "good"],
  [300, "Solid — about a typical person", ""],
  [400, "A bit slow off the line", "bad"],
  [Infinity, "Still on the grid…", "bad"],
];

export function mountLights(root) {
  const stats = load("lights", { best: null, history: [], jumps: 0, runs: 0 });
  root.innerHTML = `<div class="game">
    <div class="lo-stage" id="loStage" role="button" tabindex="0" aria-label="Start lights. Tap or press Space.">
      <div class="gantry" aria-hidden="true">${[0, 1, 2, 3, 4].map((i) => `<div class="pod" data-i="${i}"><div class="lamp"></div><div class="lamp"></div></div>`).join("")}</div>
      <div class="lo-msg" id="loMsg"></div>
    </div>
    <div class="panel">
      <div class="stats" id="loStats"></div>
      <div class="scale" id="loScale" aria-hidden="true"></div>
      <div class="lo-history" id="loHist" style="margin-top:12px"></div>
    </div>
    <p class="hint">Tap the lights, click, or press <kbd>Space</kbd>. Wait for all five to go out — going early is a jump start. F1 drivers usually react in about 0.2 seconds.</p>
  </div>`;
  const $ = (id) => root.querySelector("#" + id);
  const stage = $("loStage"), pods = [...root.querySelectorAll(".pod")];

  let state = "idle"; // idle → lighting → holding → out → result
  let timers = [], t0 = 0, readyAt = 0;
  const clear = () => { timers.forEach(clearTimeout); timers = []; };
  const setLights = (n) => pods.forEach((p, i) => p.classList.toggle("on", i < n));

  function message(html) { $("loMsg").innerHTML = html; }
  function idle() { state = "idle"; setLights(0); message(`<div class="lo-verdict">Tap here or press <kbd>Space</kbd> to start</div><div class="muted small">Watch the lights…</div>`); }

  function start() {
    clear();
    state = "lighting";
    setLights(0);
    message(`<div class="lo-verdict muted">Get ready…</div>`);
    for (let k = 1; k <= 5; k++) timers.push(setTimeout(() => { setLights(k); sfx.light(); }, 700 + (k - 1) * 1000));
    const hold = 200 + Math.random() * 2800; // like the real thing: you can't predict it
    timers.push(setTimeout(() => {
      state = "holding";
      timers.push(setTimeout(() => requestAnimationFrame((ts) => { if (state !== "holding") return; setLights(0); state = "out"; t0 = ts; }), hold));
    }, 700 + 4 * 1000));
  }

  function finish(ms, jump) {
    clear();
    state = "result";
    readyAt = performance.now() + 700; // a short pause so a double tap doesn't restart straight away
    stats.runs = (stats.runs ?? 0) + 1;
    if (jump) {
      stats.jumps = (stats.jumps ?? 0) + 1;
      stats.history = [{ jump: true }, ...(stats.history ?? [])].slice(0, 12);
      setLights(0);
      sfx.buzz();
      message(`<div class="lo-time bad">JUMP START</div><div class="lo-verdict">${ms != null ? "Under 0.1s — that was a guess, not a reaction" : "You went before the lights went out"} · drive-through penalty</div><div class="muted small">Tap or press Space to try again</div>`);
    } else {
      const isBest = !stats.best || ms < stats.best;
      if (isBest) stats.best = ms;
      stats.history = [{ ms }, ...(stats.history ?? [])].slice(0, 12);
      const [, text, cls] = VERDICTS.find(([lim]) => ms < lim);
      sfx.launch();
      if (isBest && stats.runs > 1) setTimeout(sfx.fanfare, 450);
      message(`<div class="lo-time ${cls}">${(ms / 1000).toFixed(3)}s</div><div class="lo-verdict">${isBest && stats.runs > 1 ? "New personal best! " : ""}${text}</div><div class="muted small">Tap or press Space to go again</div>`);
    }
    save("lights", stats);
    drawStats(jump ? null : ms);
  }

  function press(e) {
    if (state === "idle") return start();
    if (state === "result") { if (performance.now() >= readyAt) start(); return; }
    if (state === "lighting" || state === "holding") return finish(null, true);
    if (state === "out") {
      const now = e?.timeStamp > 0 ? e.timeStamp : performance.now();
      const ms = Math.max(0, Math.round(now - t0));
      return ms < 100 ? finish(ms, true) : finish(ms, false);
    }
  }

  function drawStats(last) {
    const valid = (stats.history ?? []).filter((h) => !h.jump).map((h) => h.ms);
    const avg5 = valid.length ? Math.round(valid.slice(0, 5).reduce((a, b) => a + b, 0) / Math.min(5, valid.length)) : null;
    const s = (x) => (x == null ? "—" : (x / 1000).toFixed(3) + "s");
    $("loStats").innerHTML = `<div class="stat"><b>${s(stats.best)}</b><span>Best</span></div>
      <div class="stat"><b>${s(avg5)}</b><span>Average (last 5)</span></div>
      <div class="stat"><b>${stats.runs ?? 0}</b><span>Starts</span></div>
      <div class="stat"><b>${stats.jumps ?? 0}</b><span>Jump starts</span></div>`;
    // where you sit between 0.1s and 0.5s
    const pos = (ms) => `${Math.max(0, Math.min(100, ((ms - 100) / 400) * 100))}%`;
    const you = last ?? valid[0];
    $("loScale").innerHTML = `<div class="bar"></div>
      <div class="mark f1" style="left:${pos(200)}"></div><div class="lbl" style="left:${pos(200)}">F1 ≈ 0.20</div>
      <div class="mark" style="left:${pos(250)};opacity:.35"></div><div class="lbl" style="left:${pos(250)}">typical ≈ 0.25</div>
      ${you ? `<div class="mark" style="left:${pos(you)};background:#2FD27A;width:3px"></div><div class="lbl" style="left:${pos(you)};top:-14px;color:#6EE7A8">you</div>` : ""}`;
    const best = stats.best;
    $("loHist").innerHTML = (stats.history ?? []).map((h) => h.jump ? `<span class="jump">JUMP</span>` : `<span class="${h.ms === best ? "best" : ""}">${(h.ms / 1000).toFixed(3)}</span>`).join("");
  }

  const onKey = (e) => {
    if (e.code !== "Space" && e.code !== "Enter") return;
    if (e.target.closest?.("input, a, button") && e.target !== stage) return;
    e.preventDefault();
    if (!e.repeat) press(e);
  };
  const onDown = (e) => { if (e.button > 0) return; e.preventDefault(); press(e); };
  stage.addEventListener("pointerdown", onDown);
  addEventListener("keydown", onKey);
  idle();
  drawStats(null);
  return () => { clear(); removeEventListener("keydown", onKey); };
}
