// Team radio transcripts, through the "radio helper": a small free Cloudflare Worker you set up
// once (tools/radio-helper.js). F1's server doesn't let websites read its radio clips, so the
// helper fetches each clip and transcribes it with Whisper on Cloudflare. The page then works out
// which lines are the driver and which are the team.
const KEY = "undercut.transcripts.v3";
const HELPER = "undercut.radioHelper";

export const status = { error: null };
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const changed = () => { for (const fn of listeners) fn(); };

let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
const persist = () => {
  const keys = Object.keys(saved);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete saved[k];
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
};
// [{ who: "Driver" | "Team" | null, text }]
export const transcriptOf = (url) => saved[url] ?? null;

export const helper = () => { try { return localStorage.getItem(HELPER) || ""; } catch { return ""; } };
export function setHelper(addr) {
  let a = String(addr ?? "").trim().replace(/\/+$/, "");
  if (a && !/^https?:\/\//.test(a)) a = `https://${a}`;
  try { if (a) localStorage.setItem(HELPER, a); else localStorage.removeItem(HELPER); } catch {}
  status.error = null;
  pending.clear(); queue.length = 0;
  changed();
}

// ---------- queue: two clips at a time, newest first ----------
const queue = [];
const pending = new Map(); // url -> "queued" | "working" | error text
export const stateOf = (url) => pending.get(url) ?? null;
let active = 0;

export function transcribe(url, retry = false) {
  if (!helper() || saved[url]) return;
  if (retry && pending.has(url) && pending.get(url) !== "working") pending.delete(url);
  if (pending.has(url)) return;
  pending.set(url, "queued");
  queue.unshift(url);
  changed();
  pump();
}

function pump() {
  while (active < 2 && queue.length) {
    const url = queue.shift();
    active++;
    work(url).finally(() => { active--; pump(); });
  }
}

async function work(url) {
  pending.set(url, "working"); changed();
  const h = helper();
  try {
    const [tr, audio] = await Promise.all([
      fetch(`${h}/transcribe?url=${encodeURIComponent(url)}`).then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `the helper answered ${r.status}`);
        return body;
      }),
      // the audio itself, to tell the voices apart (optional: labels are skipped without it)
      fetch(`${h}/?url=${encodeURIComponent(url)}`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? toSamples(b) : null)).catch(() => null),
    ]);
    const segs = (tr.segments?.length ? tr.segments : [{ start: 0, end: audio ? audio.length / 16000 : 0, text: tr.text ?? "" }])
      .map((s) => ({ text: String(s.text ?? "").trim(), from: Number(s.start) || 0, to: Number(s.end) || 0 }))
      .filter((s) => s.text);
    saved[url] = !segs.length ? [{ who: null, text: "(no words picked up)" }]
      : audio ? speakers(audio, segs) : [{ who: null, text: segs.map((s) => s.text).join(" ") }];
    persist();
    pending.delete(url);
    status.error = null;
  } catch (e) {
    const msg = /Failed to fetch|NetworkError|Load failed/i.test(e.message)
      ? "Couldn't reach the radio helper — check its address."
      : e.message;
    pending.set(url, msg);
    status.error = msg;
  }
  changed();
}

// 16 kHz mono samples
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
  for (let i = 1; i < out.length; i++) if (!out[i].who) out[i].who = out[i - 1].who;
  return out.reduce((acc, c) => { const last = acc.at(-1); if (last && last.who === c.who) last.text += ` ${c.text}`; else acc.push({ ...c }); return acc; }, []);
}
