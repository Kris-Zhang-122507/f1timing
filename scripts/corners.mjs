// Adds corner numbers and marshal sectors to each circuit outline in public/data/tracks/.
// Marshal sectors are what race control means by "YELLOW IN TRACK SECTOR 7", so the track map
// can light up the right stretch of track. Data from MultiViewer's circuit info, which uses the
// same coordinates as F1's car positions (and so as our outlines).
//
// Positions are saved in a 0–1000 box fitted to the circuit (like the outlines), so the page
// can line them up with whichever outline it's drawing.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const TRACKS = "public/data/tracks";
const VERSION = 1;
const YEAR = new Date().getUTCFullYear();
const UA = { "User-Agent": "racelimit-live fan project (github.com/Kris-Zhang-122507/racelimit-live)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const force = process.argv.includes("--force");

async function json(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: UA });
    if (r.ok) return r.json();
    if (r.status === 404) return null;
    await sleep(3000 * (i + 1));
  }
  return null;
}

// circuit short name → F1 circuit key, from OpenF1's session lists
const keys = {};
for (const y of [YEAR, YEAR - 1, YEAR - 2]) {
  const ss = (await json(`https://api.openf1.org/v1/sessions?year=${y}`)) ?? [];
  for (const s of ss) if (s.circuit_short_name && s.circuit_key && !keys[s.circuit_short_name]) keys[s.circuit_short_name] = s.circuit_key;
  await sleep(1200);
}
console.log(`circuit keys for ${Object.keys(keys).length} circuits`);

const box = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, size: Math.max(maxX - minX, maxY - minY) };
};

let changed = 0;
for (const file of readdirSync(TRACKS).filter((f) => f.endsWith(".json"))) {
  const path = `${TRACKS}/${file}`;
  const t = JSON.parse(readFileSync(path, "utf8"));
  if (t.cv === VERSION && !force) continue;
  const key = keys[t.circuit];
  if (!key) { console.log(`${t.circuit}: no circuit key`); continue; }
  let mv = null;
  for (const y of [YEAR, YEAR - 1, YEAR - 2, YEAR - 3]) { mv = await json(`https://api.multiviewer.app/api/v1/circuits/${key}/${y}`); await sleep(800); if (mv?.x?.length) break; }
  if (!mv?.x?.length) { console.log(`${t.circuit}: no circuit info`); continue; }

  // MultiViewer's x/y are F1 position coordinates; flip y like the outline and fit a 0–1000 box
  const raw = mv.x.map((x, i) => [x, mv.y[i]]);
  const b = box(raw);
  const norm = (x, y) => [Math.round(((x - b.minX) / b.size) * 1000), Math.round(((b.maxY - y) / b.size) * 1000)];

  // check it really lines up with our outline (same box treatment on both)
  const ob = box(t.points);
  const ours = t.points.map(([x, y]) => [((x - ob.minX) / ob.size) * 1000, ((y - ob.minY) / ob.size) * 1000]);
  const theirs = raw.filter((_, i) => i % 4 === 0).map(([x, y]) => norm(x, y));
  const err = theirs.reduce((a, p) => a + Math.min(...ours.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))), 0) / theirs.length;
  if (err > 25) { console.log(`${t.circuit}: shapes don't line up (off by ${err.toFixed(1)}) — skipped`); continue; }

  t.corners = (mv.corners ?? []).map((c) => ({ n: c.number, l: c.letter || "", p: norm(c.trackPosition.x, c.trackPosition.y) }));
  t.marshal = (mv.marshalSectors ?? []).map((m) => ({ n: m.number, p: norm(m.trackPosition.x, m.trackPosition.y) }));
  t.cv = VERSION;
  writeFileSync(path, JSON.stringify(t));
  changed++;
  console.log(`${t.circuit}: ${t.corners.length} corners, ${t.marshal.length} marshal sectors (fit ${err.toFixed(1)})`);
}
console.log(`${changed} circuit(s) updated`);
