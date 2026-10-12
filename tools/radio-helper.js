// Undercut radio helper — a Cloudflare Worker that fetches F1 team radio clips for the site.
// F1's server doesn't let other websites read its audio files from a page, which the in-browser
// transcription needs. This worker fetches a clip and hands it back with permission to read it.
// It only fetches F1 team radio .mp3 files, and only for your Undercut site.
//
// Set up: see tools/RADIO-HELPER.md
const SITE = "https://kris-zhang-122507.github.io"; // your Undercut site (no trailing slash)
const CLIP = /^https:\/\/livetiming\.formula1\.com\/static\/[\w\-./%]+\/TeamRadio\/[\w\-.%]+\.mp3$/;

export default {
  async fetch(request) {
    const cors = { "Access-Control-Allow-Origin": SITE, "Vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    const url = new URL(request.url).searchParams.get("url") ?? "";
    if (!CLIP.test(url)) return new Response("This helper only fetches F1 team radio clips.", { status: 400, headers: cors });
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36" },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (!res.ok) return new Response(`F1 answered ${res.status}`, { status: 502, headers: cors });
    return new Response(res.body, { headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } });
  },
};
