// Sound effects, made on the fly with the Web Audio API (no sound files to download).
// Off switch in the header, remembered in this browser.
import { load, save } from "./common.js?v=mvc4w8sc";

let ctx = null, master = null;
let muted = load("muted", false);
export const isMuted = () => muted;
export function setMuted(m) { muted = m; save("muted", m); if (master) master.gain.value = m ? 0 : 0.6; }

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function tone({ freq = 440, to = null, dur = 0.12, type = "sine", vol = 0.3, at = 0, attack = 0.005 }) {
  const c = ac(); if (!c || muted) return;
  const t = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise({ dur = 0.2, vol = 0.3, at = 0, filter = 2000, q = 1, type = "bandpass", rate = null }) {
  const c = ac(); if (!c || muted) return;
  const t = c.currentTime + at;
  const len = Math.ceil(c.sampleRate * dur), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    let v = Math.random() * 2 - 1;
    if (rate) v *= Math.sin((i / c.sampleRate) * rate * Math.PI * 2) > 0 ? 1 : 0.15; // a rattle, like a wheel gun
    d[i] = v;
  }
  const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  s.buffer = buf; f.type = type; f.frequency.value = filter; f.Q.value = q;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(master);
  s.start(t);
}

export const sfx = {
  // start lights: a short beep per light
  light: () => tone({ freq: 660, dur: 0.09, type: "square", vol: 0.12 }),
  // jump start / mistakes
  buzz: () => { tone({ freq: 150, dur: 0.35, type: "sawtooth", vol: 0.18 }); tone({ freq: 155, dur: 0.35, type: "sawtooth", vol: 0.12 }); },
  // good result: two rising notes
  chime: () => { tone({ freq: 784, dur: 0.14, vol: 0.2 }); tone({ freq: 1175, dur: 0.22, vol: 0.2, at: 0.1 }); },
  // personal best: three notes
  fanfare: () => { tone({ freq: 784, dur: 0.12, vol: 0.2 }); tone({ freq: 988, dur: 0.12, vol: 0.2, at: 0.1 }); tone({ freq: 1319, dur: 0.3, vol: 0.22, at: 0.2 }); },
  // a launch: engine note sweeping up
  launch: () => { tone({ freq: 90, to: 420, dur: 0.6, type: "sawtooth", vol: 0.12 }); noise({ dur: 0.4, vol: 0.08, filter: 900 }); },
  // wrong guess: a soft low thud
  thud: () => { tone({ freq: 140, to: 70, dur: 0.18, type: "triangle", vol: 0.28 }); },
  // pit lane: limiter hum (returns a stop function)
  limiter() {
    const c = ac(); if (!c || muted) return () => {};
    const o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
    o.type = "sawtooth"; o.frequency.value = 118; o2.type = "square"; o2.frequency.value = 59;
    lfo.frequency.value = 9; lg.gain.value = 6; lfo.connect(lg).connect(o.frequency);
    g.gain.value = 0.0001; g.gain.exponentialRampToValueAtTime(0.05, c.currentTime + 0.15);
    const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900;
    o.connect(f); o2.connect(f); f.connect(g).connect(master);
    o.start(); o2.start(); lfo.start();
    return () => { const t = c.currentTime; g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12); [o, o2, lfo].forEach((x) => x.stop(t + 0.15)); };
  },
  // wheel gun: a fast rattle
  gun: () => noise({ dur: 0.16, vol: 0.35, filter: 2600, q: 2, rate: 55 }),
  // jacks dropping / car settling
  clunk: () => { tone({ freq: 110, to: 55, dur: 0.12, type: "triangle", vol: 0.35 }); noise({ dur: 0.08, vol: 0.2, filter: 500, type: "lowpass" }); },
  // brakes on the marks
  brake: () => noise({ dur: 0.18, vol: 0.12, filter: 3500, q: 6 }),
  // green light
  go: () => tone({ freq: 988, dur: 0.12, type: "square", vol: 0.1 }),
  // tick for the reveal
  tick: () => tone({ freq: 1400, dur: 0.03, type: "square", vol: 0.05 }),
};

// the speaker button in the header
export function soundButton() {
  const b = document.getElementById("sound");
  if (!b) return;
  const draw = () => {
    b.setAttribute("aria-pressed", String(!muted));
    b.title = muted ? "Sound off — click to turn on" : "Sound on — click to turn off";
    b.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/>${muted ? '<path d="M17 9l5 6M22 9l-5 6"/>' : '<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'}</svg><span class="sr">${muted ? "Sound off" : "Sound on"}</span>`;
  };
  b.addEventListener("click", () => { setMuted(!muted); draw(); if (!muted) sfx.chime(); });
  draw();
}
