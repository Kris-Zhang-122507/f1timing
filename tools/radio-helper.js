// Undercut radio helper — a free Cloudflare Worker that lets the site transcribe team radio.
//   GET /transcribe?url=<clip>  → { text, segments: [{ start, end, text, words? }] }  (Whisper, on Cloudflare)
//   GET /?url=<clip>            → the clip's audio (used to tell the driver's voice from the team's)
// F1's server doesn't let websites read its radio files, so the site asks this helper instead.
// It only works with F1 team radio .mp3 files, and only answers your Undercut site.
//
// Set up: see tools/RADIO-HELPER.md (needs a Workers AI binding called AI)
const SITE = "https://kris-zhang-122507.github.io/f1timing/public/"; // your Undercut site's address
const ORIGIN = new URL(SITE).origin; // browsers only send the start of it (https://name.github.io)
const CLIP = /^https:\/\/livetiming\.formula1\.com\/static\/[\w\-./%]+\/TeamRadio\/[\w\-.%]+\.mp3$/;
const TURBO = "@cf/openai/whisper-large-v3-turbo";
const CLASSIC = "@cf/openai/whisper"; // older model, used if the first one hears nothing
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const toBase64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// Whisper on Cloudflare. Radio is noisy and squashed, so if the newer model returns nothing,
// try the older one too. Segments: [{ start, end, text }]
// A hint about what the audio is helps Whisper with F1 words ("box", "copy", "DRS").
const HINT = "Formula 1 team radio between a driver and his race engineer. Box, box. Copy. Push now. Gap, tyres, DRS, safety car.";
// Whisper's well-known habit: on noise or silence it "hears" one of these
const FILLER = /^(thank you|thanks|thanks for watching|you|bye|okay|so|uh|um|\.+)[.!?]*$/i;
// Whisper's own test for a line that's really silence: likely no speech AND low confidence
const real = (s) => !(Number(s.no_speech_prob) > 0.6 && Number(s.avg_logprob) < -1) && !(FILLER.test(s.text) && Number(s.no_speech_prob) > 0.25) && !(Number(s.compression_ratio) > 2.6);

// word timings let the site split a line where the speaker changes
const words = (ws) => (Array.isArray(ws) && ws.length ? ws.map((w) => ({ word: String(w.word ?? "").trim(), start: w.start, end: w.end })) : undefined);

async function transcribeBytes(env, bytes, debug = false) {
  const tried = [];
  try {
    const r = await env.AI.run(TURBO, { audio: toBase64(bytes), language: "en", initial_prompt: HINT });
    const raw = (r.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: String(s.text ?? "").trim(), words: words(s.words), no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob, compression_ratio: s.compression_ratio })).filter((s) => s.text && s.text !== HINT);
    const kept = raw.filter(real);
    const segments = kept.map(({ start, end, text, words }) => ({ start, end, text, ...(words ? { words } : {}) }));
    const text = segments.map((s) => s.text).join(" ");
    if (text) return { text, segments, model: TURBO, ...(debug ? { raw } : {}) };
    tried.push(raw.length ? `${TURBO}: only noise (${raw.map((s) => s.text).join(" ")})` : `${TURBO}: no words`);
  } catch (e) { tried.push(`${TURBO}: ${e.message}`); }
  try {
    const r = await env.AI.run(CLASSIC, { audio: [...bytes] });
    // group words into lines at pauses
    const segments = [];
    for (const w of r.words ?? []) {
      const last = segments.at(-1);
      if (last && w.start - last.end < 0.7) { last.text += ` ${w.word}`; last.end = w.end; }
      else segments.push({ start: w.start, end: w.end, text: String(w.word ?? ""), words: [] });
      segments.at(-1).words.push({ word: String(w.word ?? "").trim(), start: w.start, end: w.end });
    }
    const text = String(r.text ?? "").trim();
    if (text && !FILLER.test(text)) return { text, segments: segments.map((s) => ({ ...s, text: s.text.trim() })), model: CLASSIC };
    tried.push(text ? `${CLASSIC}: only noise (${text})` : `${CLASSIC}: no words`);
  } catch (e) { tried.push(`${CLASSIC}: ${e.message}`); }
  return { text: "", segments: [], tried };
}

// length of an mp3 in seconds, from its first frame header (F1's clips are constant bitrate)
function seconds(bytes) {
  let i = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) i = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]); // skip ID3 tag
  if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) return null;
  const v1 = (bytes[i + 1] & 0x18) === 0x18;
  const kbps = (v1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bytes[i + 2] >> 4];
  return kbps ? Math.round(((bytes.length - i) * 8) / (kbps * 1000) * 10) / 10 : null;
}

export default {
  async fetch(request, env, ctx) {
    const cors = { "Access-Control-Allow-Origin": ORIGIN, "Vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    const u = new URL(request.url);
    const clip = u.searchParams.get("url") ?? "";
    if (!CLIP.test(clip)) return Response.json({ error: "This helper only works with F1 team radio clips." }, { status: 400, headers: cors });

    // answers are cached for a day, so each clip is fetched and transcribed once
    const cache = caches.default;
    const debug = u.pathname.startsWith("/debug");
    // the "v" changes whenever the helper changes, so answers from an older version aren't reused
    const key = new Request(`${u.origin}${u.pathname}?v=4&url=${encodeURIComponent(clip)}`);
    const hit = debug ? null : await cache.match(key);
    if (hit) return hit;

    const res = await fetch(clip, { headers: { "User-Agent": UA } });
    if (!res.ok) return Response.json({ error: `F1 answered ${res.status}` }, { status: 502, headers: cors });
    const bytes = new Uint8Array(await res.arrayBuffer());

    let out;
    if (debug) {
      // what the helper sees, for checking the set-up: /debug?url=<clip>
      const head = [...bytes.subarray(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      const result = env.AI ? await transcribeBytes(env, bytes, true) : { error: "no Workers AI binding named AI" };
      return Response.json({ f1Status: res.status, f1Type: res.headers.get("content-type"), bytes: bytes.length, seconds: seconds(bytes), head, result }, { headers: cors });
    }
    if (u.pathname.startsWith("/transcribe")) {
      if (!env.AI) return Response.json({ error: "Workers AI isn't connected — add a Workers AI binding named AI (step 4 of the guide)." }, { status: 500, headers: cors });
      const r = await transcribeBytes(env, bytes);
      out = Response.json({ text: r.text, segments: r.segments }, { headers: { ...cors, "Cache-Control": "public, max-age=86400" } });
      if (!r.text) return out; // don't keep an empty answer — the next try might do better
    } else {
      out = new Response(bytes, { headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } });
    }
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  },
};
