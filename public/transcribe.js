// Team radio transcripts, made in your own browser with Whisper (OpenAI's open speech model,
// run by transformers.js). Nothing is uploaded anywhere: the model downloads once (~80 MB, then
// cached by the browser) and each clip is transcribed on your computer.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js";
const MODEL = "Xenova/whisper-base.en";
const KEY = "undercut.transcripts";

let asr = null, loading = null;
export const status = { state: "idle", progress: 0, loaded: 0, total: 0, error: null }; // idle | loading | ready | error
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
export const transcriptOf = (url) => saved[url] ?? null;

// was the model downloaded before? (then it's in the browser's cache and loads quickly)
export const downloadedBefore = () => { try { return localStorage.getItem(KEY + ".model") === "1"; } catch { return false; } };
export const loadModel = () => model().catch(() => {});

async function model() {
  if (asr) return asr;
  loading ??= (async () => {
    status.state = "loading"; status.progress = 0; changed();
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
    setTimeout(run, 0);
    try { localStorage.setItem(KEY + ".model", "1"); } catch {}
    return asr;
  })().catch((e) => { status.state = "error"; status.error = e.message; loading = null; changed(); throw e; });
  return loading;
}

// clips are transcribed one at a time, newest first
const queue = [];
const pending = new Map(); // url -> "queued" | "working" | error text
export const stateOf = (url) => pending.get(url) ?? null;
let busy = false;

export function transcribe(url, retry = false) {
  if (saved[url]) return;
  if (retry && pending.has(url) && pending.get(url) !== "working") pending.delete(url);
  if (pending.has(url)) return;
  pending.set(url, "queued");
  queue.unshift(url);
  changed();
  if (status.state === "ready") run();
}

async function run() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const url = queue.shift();
      pending.set(url, "working"); changed();
      try {
        const audio = await decode(url);
        const asr = await model();
        const out = await asr(audio, { chunk_length_s: 30 });
        saved[url] = (out?.text ?? "").trim() || "(no words picked up)";
        persist();
        pending.delete(url);
      } catch (e) {
        pending.set(url, /fetch|cors|network/i.test(e.message)
          ? "Couldn't download this clip to transcribe it — F1's server may not allow it, or you're offline."
          : `Couldn't transcribe: ${e.message}`);
      }
      changed();
    }
  } finally { busy = false; }
}

// the clip as 16 kHz mono samples, which is what Whisper expects
async function decode(url) {
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error(`clip HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const decoded = await ctx.decodeAudioData(buf);
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0);
    const a = decoded.getChannelData(0), b = decoded.getChannelData(1), mono = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) mono[i] = (a[i] + b[i]) / 2;
    return mono;
  } finally { ctx.close?.(); }
}
