// Pit Stop Challenge. Three parts, like the real thing:
//   1. stop the car on your marks (off the marks and the crew has to shuffle → time lost)
//   2. change all four tyres: each wheel = gun off, then gun on with the new tyre fitted
//   3. release the car when the light goes green (go early and it's an unsafe release)
// The light only turns green once the jacks are down. The time is the stationary time, from the car stopping to the release, plus any penalties.
import { load, save, share } from "./common.js?v=mvc4lmfh";
import { sfx } from "./sfx.js?v=mvc4lmfh";

const W = 900, H = 400;
const TARGET = 450;            // where the car's middle should stop
const SPEED = 300;             // px per second down the pit lane
const SWAP = 280;              // ms for the new tyre to go on between the two gun hits
const JACKS = 250;             // ms for the jacks to drop before the light turns green
const WHEELS = [               // key, position (car points right: the top side is the car's left)
  { key: "Q", name: "rear left", dx: -88, dy: -62 },
  { key: "P", name: "front left", dx: 92, dy: -62 },
  { key: "Z", name: "rear right", dx: -88, dy: 62 },
  { key: "M", name: "front right", dx: 92, dy: 62 },
];
const VERDICTS = [
  [1800, "Faster than the world record!"],
  [2000, "World-record pace — the record is 1.80s"],
  [2500, "F1-crew quality stop"],
  [3000, "A solid stop"],
  [4000, "Slow stop — that probably cost a place"],
  [Infinity, "Disaster in the pit lane…"],
];

export function mountPit(root) {
  const saved = load("pit", { best: null, history: [] });
  root.innerHTML = `<div class="game">
    <div class="ps-stage" id="psStage">
      <svg viewBox="0 0 ${W} ${H}" id="psSvg" role="img" aria-label="Pit box, top-down view">
        <defs>
          <pattern id="psLane" width="40" height="40" patternUnits="userSpaceOnUse"><rect width="40" height="40" fill="#14171E"/><circle cx="8" cy="12" r="1" fill="#1B1F28"/><circle cx="28" cy="30" r="1" fill="#1B1F28"/></pattern>
        </defs>
        <rect width="${W}" height="${H}" fill="url(#psLane)"/>
        <rect x="0" y="40" width="${W}" height="6" fill="#E8EAF0" opacity=".5"/>
        <rect x="0" y="${H - 46}" width="${W}" height="6" fill="#E8EAF0" opacity=".5"/>
        <g id="psBox">
          <rect x="${TARGET - 190}" y="70" width="380" height="260" fill="none" stroke="#FFB547" stroke-width="4" stroke-dasharray="18 10" opacity=".55"/>
          ${WHEELS.map((w) => `<rect x="${TARGET + w.dx - 26}" y="${200 + w.dy - 22}" width="52" height="44" rx="4" fill="none" stroke="#FFFFFF" stroke-width="2" opacity=".35"/>`).join("")}
          <text x="${TARGET}" y="62" fill="#6B7383" font-family="Barlow, sans-serif" font-size="14" font-weight="600" text-anchor="middle" letter-spacing="2">YOUR BOX</text>
        </g>
        <g id="psLight" transform="translate(${TARGET + 212}, 96)">
          <rect x="-16" y="-10" width="32" height="56" rx="7" fill="#06070A" stroke="#262B36"/>
          <circle class="light" id="psRed" cx="0" cy="6" r="9" fill="#3A1214"/>
          <circle class="light" id="psGreen" cx="0" cy="30" r="9" fill="#0E2A1A"/>
        </g>
        <g id="psCar">
          <rect x="-150" y="-12" width="40" height="24" rx="3" fill="#2A2F3A"/>
          <rect x="-160" y="-46" width="22" height="92" rx="3" fill="#FFB547"/>
          <path d="M-138 -20 L-60 -34 L70 -26 L130 -10 L150 -6 L150 6 L130 10 L70 26 L-60 34 L-138 20 Z" fill="#FFB547"/>
          <path d="M-30 -14 L40 -10 L40 10 L-30 14 Z" fill="#0B0D12"/>
          <path d="M-20 -16 Q20 -26 44 -10 L44 10 Q20 26 -20 16" fill="none" stroke="#2A2F3A" stroke-width="6"/>
          <rect x="140" y="-52" width="22" height="104" rx="4" fill="#E8A02E"/>
          ${WHEELS.map((w, i) => `<g class="wheel" data-i="${i}" transform="translate(${w.dx}, ${w.dy})" tabindex="-1">
              <rect class="tyre" x="-24" y="-20" width="48" height="40" rx="7"/>
              <rect class="ring" x="-30" y="-26" width="60" height="52" rx="10"/>
              <text class="klabel" x="0" y="1">${w.key}</text></g>`).join("")}
        </g>
      </svg>
      <div class="ps-hud"><div class="ps-clock" id="psClock">0.00</div><div class="ps-phase" id="psPhase"></div></div>
    </div>
    <div class="ps-controls">
      <button class="btn primary" id="psMain" type="button">Start</button>
      <span class="hint" id="psHint"></span>
    </div>
    <div class="panel ps-result" id="psResult" hidden></div>
    <div class="panel"><div class="stats" id="psStats"></div></div>
    <p class="hint">Keyboard: <kbd>Space</kbd> to stop the car and to release it, and <kbd>Q</kbd> <kbd>P</kbd> <kbd>Z</kbd> <kbd>M</kbd> for the four wheels (they sit at the corners of your keyboard, like the wheels on the car). On a phone, tap the wheels and the big button. Each wheel needs two hits: gun off, then — once the new tyre is on — gun on.</p>
  </div>`;
  const $ = (id) => root.querySelector("#" + id);
  const car = $("psCar"), wheelEls = [...root.querySelectorAll(".wheel")];
  // on narrow screens, zoom in on the box so the wheels are big enough to tap
  const fit = () => $("psSvg").setAttribute("viewBox", $("psStage").clientWidth < 640 ? `${TARGET - 235} 52 470 300` : `0 0 ${W} ${H}`);
  const ro = new ResizeObserver(fit); ro.observe($("psStage")); fit();

  let phase = "ready";   // ready → driving → stationary → release → done
  let stopHum = () => {};
  let x = -220, raf = 0, last = 0, tStop = 0, tEnd = 0, wheels = [], penalties = [], greenAt = 0;
  const now = () => performance.now();

  function setCar() { car.setAttribute("transform", `translate(${x}, 200)`); }
  function setLight(c) { $("psRed").setAttribute("fill", c === "red" ? "#FF4D4D" : "#3A1214"); $("psGreen").setAttribute("fill", c === "green" ? "#2FD27A" : "#0E2A1A"); }
  function phaseText(t, hint, button) { $("psPhase").textContent = t; $("psHint").innerHTML = hint ?? ""; if (button) { $("psMain").textContent = button[0]; $("psMain").disabled = !!button[1]; } }
  function drawWheels() { wheelEls.forEach((el, i) => { const w = wheels[i]; el.setAttribute("class", `wheel ${w?.state ?? ""} ${phase === "stationary" && (w?.state === "on" || w?.state === "new") ? "ready" : ""}`); }); }

  function reset() {
    cancelAnimationFrame(raf); stopHum();
    phase = "ready"; x = -220; penalties = []; wheels = WHEELS.map(() => ({ state: "on" })); setCar(); setLight("red");
    $("psClock").textContent = "0.00"; $("psResult").hidden = true;
    phaseText("Pit entry", "Press <kbd>Start</kbd> — the car comes down the pit lane. Hit <kbd>Space</kbd> or <b>STOP</b> to stop it on the marks.", ["Start", false]);
    drawWheels();
  }

  function drive() {
    phase = "driving"; last = now(); stopHum = sfx.limiter();
    phaseText("Pit limiter on", "Stop on the marks!", ["STOP", false]);
    const step = (t) => {
      x += (SPEED * (t - last)) / 1000; last = t; setCar();
      if (x > W + 200) { stopCar(true); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function stopCar(overran) {
    cancelAnimationFrame(raf);
    stopHum(); sfx.brake(); setTimeout(sfx.clunk, 90);
    const err = overran ? Infinity : Math.abs(x - TARGET);
    if (overran) { x = TARGET + 120; setCar(); penalties.push(["Overshot the box — the crew had to run to the car", 3000]); }
    else if (err > 70) penalties.push([`Missed the marks by ${Math.round(err / 4)} cm — crew had to move`, 2500]);
    else if (err > 6) penalties.push([`${Math.round(err / 4)} cm off the marks`, Math.round(err * 12)]);
    phase = "stationary"; tStop = now();
    wheels = WHEELS.map(() => ({ state: "on" }));
    phaseText("Change the tyres", "Two hits on each wheel: gun off, then gun on.", ["Release (wait for green)", false]);
    drawWheels();
    clock();
  }

  function clock() {
    if (!["stationary", "jacks", "release"].includes(phase)) return;
    $("psClock").textContent = ((now() - tStop) / 1000).toFixed(2);
    raf = requestAnimationFrame(clock);
  }

  function hitWheel(i) {
    if (phase !== "stationary") return;
    const w = wheels[i];
    if (w.state === "on") { sfx.gun(); w.state = "off"; w.at = now(); drawWheels(); setTimeout(() => { if (w.state === "off") { w.state = "new"; drawWheels(); } }, SWAP); return; }
    if (w.state === "off") { // gun on before the new tyre is there: fumble
      penalties.push([`Fumbled the ${WHEELS[i].name} wheel`, 300]);
      sfx.thud();
      const el = wheelEls[i]; el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 200);
      return;
    }
    if (w.state === "new") {
      w.state = "done"; sfx.gun(); drawWheels();
      if (wheels.every((v) => v.state === "done")) { setTimeout(sfx.clunk, JACKS - 60); phase = "jacks"; phaseText("Jacks down…", "Wait for green!", ["GO", false]); setTimeout(() => { if (phase === "jacks") green(); }, JACKS); }
    }
  }

  function green() {
    phase = "release"; greenAt = now(); setLight("green"); sfx.go();
    phaseText("Go go go!", "Release the car!", ["GO", false]);
    drawWheels();
  }

  function release() {
    if (phase === "stationary") penalties.push(["Unsafe release — a wheel wasn't on", 5000]);
    if (phase === "jacks") penalties.push(["Unsafe release — went before the green light", 5000]);
    cancelAnimationFrame(raf);
    tEnd = now(); phase = "done"; setLight("red");
    if (penalties.some(([t]) => t.startsWith("Unsafe"))) sfx.buzz(); else sfx.launch();
    const stationary = Math.round(tEnd - tStop);
    const pen = penalties.reduce((a, [, ms]) => a + ms, 0);
    const total = stationary + pen;
    $("psClock").textContent = (total / 1000).toFixed(2);
    // drive away
    const fromX = x, t0 = now();
    const away = (t) => { x = fromX + ((t - t0) / 1000) ** 2 * 900; setCar(); if (x < W + 250) raf = requestAnimationFrame(away); };
    raf = requestAnimationFrame(away);
    const isBest = !saved.best || total < saved.best;
    if (isBest) saved.best = total;
    saved.history = [total, ...(saved.history ?? [])].slice(0, 10);
    save("pit", saved);
    const verdict = VERDICTS.find(([lim]) => total < lim)[1];
    if (isBest && saved.history.length > 1) setTimeout(sfx.fanfare, 500);
    $("psResult").hidden = false;
    $("psResult").innerHTML = `<div class="stats"><div class="stat"><b style="font-size:30px">${(total / 1000).toFixed(2)}s</b><span>Your stop${isBest && saved.history.length > 1 ? " · new best!" : ""}</span></div></div>
      <div class="lo-verdict" style="font:600 20px 'Barlow Condensed',sans-serif">${verdict}</div>
      <div class="ps-breakdown"><div><span>Stationary time</span><b class="mono">${(stationary / 1000).toFixed(2)}s</b></div>
        ${greenAt ? `<div><span>…of which reacting to the green light</span><span class="mono muted">${((tEnd - greenAt) / 1000).toFixed(2)}s</span></div>` : ""}
        ${penalties.map(([t, ms]) => `<div class="pen"><span>${t}</span><b class="mono">+${(ms / 1000).toFixed(2)}s</b></div>`).join("")}</div>
      <div class="muted small">Good F1 stops take about 2.0–2.5 seconds; the world record is 1.80s (McLaren, Qatar 2023).</div>
      <div class="ps-controls"><button class="btn" id="psShare" type="button">Share</button></div>`;
    $("psShare").addEventListener("click", (e) => share(`RaceLimit · Pit Stop Challenge: ${(total / 1000).toFixed(2)}s${penalties.length ? ` (${penalties.length} penalt${penalties.length > 1 ? "ies" : "y"})` : ""} 🛞\n${location.origin}${location.pathname}#pit`, e.currentTarget));
    phaseText("Car released", "Go again?", ["Go again", false]);
    greenAt = 0;
    drawStats();
  }

  function main() {
    if (phase === "ready") return drive();
    if (phase === "driving") return stopCar(false);
    if (phase === "stationary" || phase === "jacks" || phase === "release") return release();
    if (phase === "done") { reset(); drive(); }
  }

  function drawStats() {
    const h = saved.history ?? [];
    const avg = h.length ? h.slice(0, 5).reduce((a, b) => a + b, 0) / Math.min(5, h.length) : null;
    const s = (v) => (v == null ? "—" : (v / 1000).toFixed(2) + "s");
    $("psStats").innerHTML = `<div class="stat"><b>${s(saved.best)}</b><span>Best</span></div><div class="stat"><b>${s(avg)}</b><span>Average (last 5)</span></div><div class="stat"><b>1.80s</b><span>F1 record</span></div>`;
  }

  const onKey = (e) => {
    if (e.target.closest?.("input")) return;
    const k = e.key.toUpperCase();
    if (e.code === "Space" || e.code === "Enter") { if (e.target.closest?.("button") && e.target !== $("psMain")) return; e.preventDefault(); if (!e.repeat) main(); return; }
    const i = WHEELS.findIndex((w) => w.key === k);
    if (i >= 0 && !e.repeat) { e.preventDefault(); hitWheel(i); }
  };
  $("psMain").addEventListener("click", (e) => { if (e.detail === 0) return; main(); }); // keyboard Space is handled above
  $("psMain").addEventListener("keydown", (e) => { if (e.code === "Space" || e.code === "Enter") e.preventDefault(); });
  wheelEls.forEach((el, i) => el.addEventListener("pointerdown", (e) => { e.preventDefault(); hitWheel(i); }));
  addEventListener("keydown", onKey);
  reset();
  drawStats();
  return () => { cancelAnimationFrame(raf); stopHum(); ro.disconnect(); removeEventListener("keydown", onKey); };
}
