// Team radio transcripts, through the "radio helper": a small free Cloudflare Worker you set up
// once (tools/radio-helper.js). F1's server doesn't let websites read its radio clips, so the
// helper fetches each clip and transcribes it with Whisper on Cloudflare. The page then works out
// which lines are the driver and which are the team (and you can click a tag to correct it).
import { label } from "./lib/speakers.js?v=mv507aov";
const KEY = "undercut.transcripts.v5";
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
// [{ who: "Driver" | "Team" | null, text, fixed? }]
export const transcriptOf = (url) => saved[url] ?? null;
// you know better: click a line's tag to swap driver/team (an untagged line becomes "Driver")
export function flip(url, i) {
  const l = saved[url]?.[i];
  if (!l) return;
  l.who = l.who === "Driver" ? "Team" : "Driver";
  l.fixed = true;
  persist();
  changed();
}

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

// name: the driver's full name, so lines that call him by name can be marked as the team
const names = new Map();
export function transcribe(url, retry = false, name = "") {
  if (name) names.set(url, name);
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
      .map((x) => ({ text: String(x.text ?? "").trim(), from: Number(x.start) || 0, to: Number(x.end) || 0, words: x.words }))
      .filter((x) => x.text);
    saved[url] = segs.length ? label(segs, audio, names.get(url) ?? "") : [{ who: null, text: "(no words picked up)" }];
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
