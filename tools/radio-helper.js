// Undercut radio helper — a free Cloudflare Worker that lets the site transcribe team radio.
//   GET /transcribe?url=<clip>  → { text, segments: [{ start, end, text }] }  (Whisper, on Cloudflare)
//   GET /?url=<clip>            → the clip's audio (used to tell the driver's voice from the team's)
// F1's server doesn't let websites read its radio files, so the site asks this helper instead.
// It only works with F1 team radio .mp3 files, and only answers your Undercut site.
//
// Set up: see tools/RADIO-HELPER.md (needs a Workers AI binding called AI)
const SITE = "https://kris-zhang-122507.github.io/f1timing/public/"; // your Undercut site's address
const ORIGIN = new URL(SITE).origin; // browsers only send the start of it (https://name.github.io)
const CLIP = /^https:\/\/livetiming\.formula1\.com\/static\/[\w\-./%]+\/TeamRadio\/[\w\-.%]+\.mp3$/;
const MODEL = "@cf/openai/whisper-large-v3-turbo";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const toBase64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export default {
  async fetch(request, env, ctx) {
    const cors = { "Access-Control-Allow-Origin": ORIGIN, "Vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    const u = new URL(request.url);
    const clip = u.searchParams.get("url") ?? "";
    if (!CLIP.test(clip)) return Response.json({ error: "This helper only works with F1 team radio clips." }, { status: 400, headers: cors });

    // answers are cached for a day, so each clip is fetched and transcribed once
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;

    const res = await fetch(clip, { headers: { "User-Agent": UA } });
    if (!res.ok) return Response.json({ error: `F1 answered ${res.status}` }, { status: 502, headers: cors });
    const bytes = new Uint8Array(await res.arrayBuffer());

    let out;
    if (u.pathname.startsWith("/transcribe")) {
      if (!env.AI) return Response.json({ error: "Workers AI isn't connected — add a Workers AI binding named AI (step 4 of the guide)." }, { status: 500, headers: cors });
      const r = await env.AI.run(MODEL, { audio: toBase64(bytes), language: "en", vad_filter: true });
      const segments = (r.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: String(s.text ?? "").trim() })).filter((s) => s.text);
      out = Response.json({ text: r.text ?? "", segments }, { headers: { ...cors, "Cache-Control": "public, max-age=86400" } });
    } else {
      out = new Response(bytes, { headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } });
    }
    ctx.waitUntil(cache.put(request, out.clone()));
    return out;
  },
};
