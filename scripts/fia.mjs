// Collects two kinds of official FIA documents for this season and turns them into data for the
// Technical tab:
//   Car Presentation Submissions          — every team's upgrades, each race weekend
//   PU Elements used per Driver up to now — power unit parts each driver has used
// Runs in the hourly GitHub Actions job (needs `pdftotext` from poppler-utils).
//
//   node scripts/fia.mjs           update this season
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePu, parseCarPresentation, PU_ELEMENTS, PU_ALLOWANCE } from "./fia-parse.mjs";

const YEAR = Number(process.argv[2]) || new Date().getUTCFullYear();
const BASE = "https://www.fia.com";
const OUT = "public/data/fia";
const EVENTS = `${OUT}/events`;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const log = (...a) => console.log(...a);

async function get(url, binary = false) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
      if (r.ok) return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
      log(`  ${r.status} ${url}`);
      if (r.status === 404) return null;
    } catch (e) { log(`  ${e.message} ${url}`); }
    await pause(3000 * (i + 1));
  }
  return null;
}

// short team names, matching the rest of the site
export function teamName(raw) {
  const t = String(raw ?? "").toLowerCase();
  const map = [["mclaren", "McLaren"], ["mercedes", "Mercedes"], ["racing bulls", "Racing Bulls"], ["rb f1", "Racing Bulls"], ["red bull", "Red Bull Racing"],
    ["ferrari", "Ferrari"], ["williams", "Williams"], ["aston", "Aston Martin"], ["haas", "Haas"], ["alpine", "Alpine"], ["audi", "Audi"], ["sauber", "Audi"], ["cadillac", "Cadillac"]];
  // "McLaren Mercedes" etc. list the engine second, so check the start of the name first
  for (const [k, v] of map) if (t.startsWith(k)) return v;
  for (const [k, v] of map) if (t.includes(k)) return v;
  return String(raw ?? "").trim();
}

function pdfText(buf) {
  const dir = mkdtempSync(join(tmpdir(), "fia-"));
  try {
    writeFileSync(join(dir, "d.pdf"), buf);
    execFileSync("pdftotext", ["-layout", join(dir, "d.pdf"), join(dir, "d.txt")]);
    return readFileSync(join(dir, "d.txt"), "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  mkdirSync(EVENTS, { recursive: true });
  const seasonUrl = `${BASE}/documents/championships/fia-formula-one-world-championship-14/season/season-${YEAR}-2072`;
  const season = await get(seasonUrl);
  if (!season) { log("Couldn't load the FIA documents page."); return; }
  // newest first: the open event, then the list of earlier ones
  const names = [];
  const active = season.match(/class="event-title active">\s*([^<]+?)\s*</);
  if (active) names.push(active[1]);
  for (const m of season.matchAll(/decision-document-list\/nojs\/\d+"[^>]*>\s*([^<]+?)\s*<\/a>/g)) if (!names.includes(m[1])) names.push(m[1]);
  if (!names.length) { log("No events found on the FIA page (layout changed?)"); return; }
  log(`${names.length} events: ${names.join(", ")}`);

  const events = [];
  for (const [i, name] of names.entries()) {
    const round = names.length - i;
    const file = `${EVENTS}/${slug(name)}.json`;
    const cached = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    // documents can still change during and just after the newest two weekends
    if (cached && i >= 2 && cached.pu?.length && cached.upgradesChecked) { events.push({ ...cached, round }); continue; }
    const page = await get(`${seasonUrl}/event/${encodeURIComponent(name)}`);
    await pause(1500);
    if (!page) { if (cached) events.push({ ...cached, round }); continue; }
    const pdfs = [...new Set([...page.matchAll(/\/system\/files\/decision-document\/[^"'\s>]+?\.pdf/g)].map((m) => BASE + m[0]))];
    const puUrl = pdfs.filter((u) => /pu_elements_used_per_driver/i.test(u)).sort().pop() ?? null;
    const cpUrls = pdfs.filter((u) => /car_presentation/i.test(u));
    const ev = { round, name, slug: slug(name), pu: cached?.pu ?? [], upgrades: cached?.upgrades ?? [], sources: { pu: puUrl, upgrades: cpUrls } };
    if (puUrl) {
      const buf = await get(puUrl, true);
      if (buf) ev.pu = parsePu(pdfText(buf)).map((r) => ({ ...r, team: teamName(r.car) }));
      await pause(1500);
    }
    const teams = new Map();
    for (const u of cpUrls) {
      const buf = await get(u, true);
      await pause(1500);
      if (!buf) continue;
      for (const t of parseCarPresentation(pdfText(buf))) {
        const name = teamName(t.team);
        const have = teams.get(name) ?? [];
        // a later revision of the document replaces the team's list
        teams.set(name, t.updates.length || !have.length ? t.updates.map((x) => ({ ...x, source: u })) : have);
      }
    }
    if (teams.size) ev.upgrades = [...teams.entries()].map(([team, updates]) => ({ team, updates }));
    ev.upgradesChecked = cpUrls.length > 0;
    writeFileSync(file, JSON.stringify(ev));
    log(`R${round} ${name}: ${ev.pu.length} drivers' PU usage, ${ev.upgrades.reduce((a, t) => a + t.updates.length, 0)} upgrades`);
    events.push(ev);
  }
  events.sort((a, b) => a.round - b.round);

  // power units: latest totals, plus what each driver took new at each event
  const withPu = events.filter((e) => e.pu.length);
  const latest = withPu[withPu.length - 1];
  const history = {};
  let prev = {};
  for (const e of withPu) {
    for (const r of e.pu) {
      const before = prev[r.n] ?? Object.fromEntries(PU_ELEMENTS.map((k) => [k, 0]));
      const fresh = PU_ELEMENTS.filter((k) => r.used[k] > before[k]).map((k) => `${k}${r.used[k] - before[k] > 1 ? " ×" + (r.used[k] - before[k]) : ""}`);
      if (fresh.length) (history[r.n] ??= []).push({ round: e.round, event: e.name, parts: fresh });
    }
    prev = Object.fromEntries(e.pu.map((r) => [r.n, r.used]));
  }

  const data = {
    year: YEAR,
    rounds: events.map((e) => ({ round: e.round, name: e.name })),
    upgrades: events.flatMap((e) => e.upgrades.flatMap((t) => t.updates.map((u) => ({ round: e.round, event: e.name, team: t.team, ...u })))),
    upgradesChecked: events.filter((e) => e.upgradesChecked).map((e) => e.round),
    pu: latest ? { round: latest.round, event: latest.name, source: latest.sources?.pu, allowance: PU_ALLOWANCE, elements: PU_ELEMENTS, drivers: latest.pu.map((r) => ({ ...r, history: history[r.n] ?? [] })) } : null,
  };
  const path = `${OUT}/technical.json`;
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = JSON.stringify(data);
  if (old !== next) writeFileSync(path, next);
  log(`Technical data: ${data.upgrades.length} upgrades over ${data.upgradesChecked.length} events; PU usage after ${latest?.name ?? "—"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.log(`FIA: ${e.message}`); });
