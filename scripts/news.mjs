// Collects F1 headlines from public RSS feeds into public/data/news.json.
// Only headlines, dates and links are kept — the site links out to read the full stories.
// Each headline is tagged by topic (upgrades, power unit, crashes…) for the Technical tab.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const FEEDS = process.env.NEWS_FEEDS ? JSON.parse(process.env.NEWS_FEEDS) : [
  ["Formula 1", "https://www.formula1.com/en/latest/all.xml"],
  ["Motorsport.com", "https://www.motorsport.com/rss/f1/news/"],
  ["Autosport", "https://www.autosport.com/rss/f1/news/"],
  ["RaceFans", "https://www.racefans.net/feed/"],
];
const TAGS = [
  ["upgrades", /upgrade|new floor|sidepod|front wing|rear wing|new parts|car presentation|development|aero package|b-spec/i],
  ["power unit", /power unit|\bengine\b|\bPU\b|grid penalt|MGU|energy store|battery|gearbox|ICE\b|turbo/i],
  ["crashes", /crash|collision|accident|damage|chassis|shunt|barrier|wreck|repair/i],
  ["technical", /technical|aerodynamic|downforce|setup|tyre|tire|telemetry|regulation|FIA|stewards/i],
];
const OUT = "public/data/news.json";

const decode = (s) => String(s ?? "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "’").replace(/&#8216;/g, "‘").replace(/&#822[01];/g, '"').replace(/&#8211;/g, "–").replace(/&#8212;/g, "—").replace(/&nbsp;/g, " ")
  .trim();
const tag = (s, name) => s.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "";

async function feed(source, url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (RaceLimit Live fan project; headlines only)" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => {
    const it = m[0];
    const title = decode(tag(it, "title"));
    const link = decode(tag(it, "link")) || decode(tag(it, "guid"));
    const date = new Date(decode(tag(it, "pubDate")) || Date.now());
    const text = `${title} ${decode(tag(it, "description")).slice(0, 400)}`;
    return { source, title, link, date: isNaN(date) ? null : date.toISOString(), tags: TAGS.filter(([, re]) => re.test(text)).map(([t]) => t) };
  }).filter((x) => x.title && /^https?:/.test(x.link));
}

const items = [];
for (const [source, url] of FEEDS) {
  try { const got = await feed(source, url); items.push(...got); console.log(`${source}: ${got.length}`); }
  catch (e) { console.log(`${source}: ${e.message}`); }
}
if (!items.length) { console.log("No news fetched — keeping the old file."); process.exit(0); }
// newest first, drop near-duplicate headlines across sources
const seen = new Set();
const out = items.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).filter((x) => {
  const k = x.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").slice(0, 60);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
}).slice(0, 80);
mkdirSync("public/data", { recursive: true });
const before = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).items : null;
if (JSON.stringify(before) !== JSON.stringify(out)) writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), items: out }, null, 1));
console.log(`Saved ${out.length} headlines`);
