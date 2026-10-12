// Team radio transcripts, made in your own browser with Whisper (OpenAI's open speech model,
// run by transformers.js). Nothing is uploaded anywhere: the model downloads once (~80 MB, then
// cached by the browser) and each clip is transcribed on your computer.
//
// F1's server doesn't let other websites read its radio files, so clips are fetched through a
// "radio helper": a tiny free Cloudflare Worker you set up once (tools/radio-helper.js), whose
// address is saved in this browser. Without one, transcripts can't be made on a website.
// Each line is labelled Driver or Team with a best guess: the driver's mic picks up engine and
// wind noise, the pit wall is clean — so the noisier voice is taken to be the driver.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js";
const MODEL = "Xenova/whisper-base.en";
const KEY = "undercut.transcripts.v2";

let asr = null, loading = null;
export const status = { state: "idle", progress: 0, loaded: 0, total: 0, error: null, blocked: false };
const HELPER = "undercut.radioHelper";
export const helper = () => { try { return localStorage.getItem(HELPER) || ""; } catch { return ""; } };
export function setHelper(addr) {
  const a = String(addr ?? "").trim().replace(/\/+$/, "");
  try { if (a) localStorage.setItem(HELPER, a); else localStorage.removeItem(HELPER); } catch {}
  // try everything that was blocked again
  status.blocked = false; status.error = null;
  for (const [u, st] of pending) if (st === "blocked" || /^Couldn't/.test(st)) pending.delete(u);
  changed();
}
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const changed = () => { for (const fn of listeners) fn(); };

let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
const persist = () => {
  const keys = Object.keys(saved);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete saved[k];
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
};
// [{ who: "Driver" | "Team" | null, text }]
export const transcriptOf = (url) => saved[url] ?? null;

export const downloadedBefore = () => { try { return localStorage.getItem(KEY + ".model") === "1"; } catch { return false; } };
export const loadModel = () => model().catch(() => {});

async function model() {
  if (asr) return asr;
  loading ??= (async () => {
    status.state = "loading"; status.progress = 0; status.error = null; changed();
    const { pipeline, env } = await import(LIB);
    env.allowLocalModels = false;
    const files = {};
    asr = await pipeline("automatic-speech-recognition", MODEL, {
      dtype: "q8", device: "wasm",
      progress_callback: (p) => {
        if (p.status === "progress" && p.total) {
          files[p.file] = [p.loaded, p.total];
          const [a, b] = Object.values(files).reduce(([x, y], [l, t]) => [x + l, y + t], [0, 0]);
          status.progress = b ? a / b : 0; status.loaded = a; status.total = b;
          changed();
        }
      },
    });
    status.state = "ready"; changed();
    try { localStorage.setItem(KEY + ".model", "1"); } catch {}
    setTimeout(run, 0);
    return asr;
  })().catch((e) => { status.state = "error"; status.error = e.message; loading = null; changed(); throw e; });
  return loading;
}

// ---------- the queue: clips we can download ----------
const queue = [];
const pending = new Map(); // url -> "queued" | "working" | "blocked" | error text
export const stateOf = (url) => pending.get(url) ?? null;
let busy = false;

export function transcribe(url, retry = false) {
  if (saved[url]) return;
  if (retry && pending.has(url) && pending.get(url) !== "working") pending.delete(url);
  if (pending.has(url)) return;
  if (status.blocked) { pending.set(url, "blocked"); changed(); return; } // don't hammer a server that says no
  pending.set(url, "queued");
  queue.unshift(url);
  changed();
  if (status.state === "ready") run();
}

async function run() {
  if (busy || status.state !== "ready") return;
  busy = true;
  try {
    while (queue.length) {
      const url = queue.shift();
      pending.set(url, "working"); changed();
      let audio;
      try { audio = await download(url); }
      catch (e) {
        // F1 (or the helper) said no: stop and explain, rather than trying every clip
        status.blocked = true;
        status.error = hasBridge() ? `The radio bridge couldn't get the clip (${e.message}).` : helper() ? `The radio helper couldn't get the clip (${e.message}).` : null;
        pending.set(url, "blocked");
        for (const u of queue.splice(0)) pending.set(u, "blocked");
        changed();
        break;
      }
      await finish(url, audio);
    }
  } finally { busy = false; }
}

async function finish(url, audio) {
  pending.set(url, "working"); changed();
  try {
    const asr = await model();
    const out = await asr(audio, { chunk_length_s: 30, return_timestamps: true });
    const chunks = (out?.chunks?.length ? out.chunks : [{ text: out?.text ?? "", timestamp: [0, audio.length / 16000] }])
      .map((c) => ({ text: String(c.text ?? "").trim(), from: c.timestamp?.[0] ?? 0, to: c.timestamp?.[1] ?? audio.length / 16000 }))
      .filter((c) => c.text);
    saved[url] = chunks.length ? speakers(audio, chunks) : [{ who: null, text: "(no words picked up)" }];
    persist();
    pending.delete(url);
  } catch (e) {
    pending.set(url, `Couldn't transcribe: ${e.message}`);
  }
  changed();
}

// the radio bridge user script (radio-bridge.user.js) fetches clips for the page
export const hasBridge = () => !!document.documentElement.getAttribute("data-undercut-bridge");
let bridgeId = 0;
function viaBridge(url) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${bridgeId++}`;
    const done = (e) => {
      if (e.source !== window || e.data?.type !== "undercut-radio-got" || e.data.id !== id) return;
      window.removeEventListener("message", done); clearTimeout(timer);
      if (e.data.ok && e.data.data) resolve(e.data.data); else reject(new Error(`F1 answered ${e.data.status || "nothing"}`));
    };
    const timer = setTimeout(() => { window.removeEventListener("message", done); reject(new Error("the radio bridge didn't answer")); }, 35000);
    window.addEventListener("message", done);
    window.postMessage({ type: "undercut-radio-get", id, url }, "*");
  });
}

async function download(url) {
  if (hasBridge()) return toSamples(await viaBridge(url));
  const h = helper();
  const r = await fetch(h ? `${h}/?url=${encodeURIComponent(url)}` : url, { mode: "cors" });
  if (!r.ok) throw new Error(`clip HTTP ${r.status}`);
  return toSamples(await r.arrayBuffer());
}

// 16 kHz mono samples, which is what Whisper expects
async function toSamples(buf) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const decoded = await ctx.decodeAudioData(buf);
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
    const a = decoded.getChannelData(0), b = decoded.getChannelData(1), mono = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) mono[i] = (a[i] + b[i]) / 2;
    return mono;
  } finally { ctx.close?.(); }
}

// ---------- driver or team? ----------
// For each line: how loud the background is compared with the voice. The helmet mic carries
// engine and wind noise between words, so the driver's lines have a much higher noise floor.
export function speakers(audio, chunks) {
  const frame = 400; // 25 ms
  const snr = chunks.map((c) => {
    const a = Math.max(0, Math.floor(c.from * 16000)), b = Math.min(audio.length, Math.ceil(c.to * 16000));
    const rms = [];
    for (let i = a; i + frame <= b; i += frame) {
      let s = 0;
      for (let j = i; j < i + frame; j++) s += audio[j] * audio[j];
      rms.push(Math.sqrt(s / frame) + 1e-6);
    }
    if (rms.length < 6) return null;
    rms.sort((x, y) => x - y);
    const floor = rms[Math.floor(rms.length * 0.15)], peak = rms[Math.floor(rms.length * 0.9)];
    return 20 * Math.log10(peak / floor);
  });
  const known = snr.filter((x) => x != null);
  let label;
  if (known.length >= 2 && Math.max(...known) - Math.min(...known) > 6) {
    // two voices: split at the biggest gap; the noisier group is the driver
    const sorted = [...known].sort((a, b) => a - b);
    let cut = sorted[0], gap = -1;
    for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > gap) { gap = sorted[i] - sorted[i - 1]; cut = (sorted[i] + sorted[i - 1]) / 2; }
    label = (x) => (x == null ? null : x < cut ? "Driver" : "Team");
  } else {
    label = (x) => (x == null ? null : x < 18 ? "Driver" : "Team");
  }
  const out = chunks.map((c, i) => ({ who: label(snr[i]), text: c.text }));
  // short lines with no reading take the speaker of the line before
  for (let i = 1; i < out.length; i++) if (!out[i].who) out[i].who = out[i - 1].who;
  // merge consecutive lines from the same speaker
  return out.reduce((acc, c) => { const last = acc.at(-1); if (last && last.who === c.who) last.text += ` ${c.text}`; else acc.push({ ...c }); return acc; }, []);
}
