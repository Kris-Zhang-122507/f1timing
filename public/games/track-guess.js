// Guess the Track: a real circuit outline (the same shapes as the live track map) is revealed a
// little more after every wrong guess. Six guesses. One puzzle a day, the same for everyone, plus
// practice rounds. Wrong guesses tell you how far away the right circuit is, and which way.
import { load, save, esc, share } from "./common.js?v=mvc4w8sc";
import { sfx } from "./sfx.js?v=mvc4w8sc";

// slug (file in data/tracks) → name, country, flag, where it is, and other names people might type
const CIRCUITS = [
  ["austin", "Circuit of the Americas", "USA", "🇺🇸", 30.13, -97.64, ["cota", "austin", "texas", "united states", "us gp"]],
  ["baku", "Baku City Circuit", "Azerbaijan", "🇦🇿", 40.37, 49.85, ["baku", "azerbaijan"]],
  ["catalunya", "Barcelona-Catalunya", "Spain", "🇪🇸", 41.57, 2.26, ["barcelona", "catalunya", "catalonia", "montmelo"]],
  ["hungaroring", "Hungaroring", "Hungary", "🇭🇺", 47.58, 19.25, ["hungary", "budapest"]],
  ["interlagos", "Interlagos", "Brazil", "🇧🇷", -23.70, -46.70, ["sao paulo", "brazil", "jose carlos pace"]],
  ["jeddah", "Jeddah Corniche Circuit", "Saudi Arabia", "🇸🇦", 21.63, 39.10, ["jeddah", "saudi", "saudi arabia"]],
  ["kuala-lumpur", "Sepang (Kuala Lumpur)", "Malaysia", "🇲🇾", 2.76, 101.74, ["sepang", "kuala lumpur", "malaysia"]],
  ["las-vegas", "Las Vegas Strip Circuit", "USA", "🇺🇸", 36.11, -115.17, ["las vegas", "vegas"]],
  ["lusail", "Lusail", "Qatar", "🇶🇦", 25.49, 51.45, ["qatar", "losail", "doha"]],
  ["madring", "Madring", "Spain", "🇪🇸", 40.47, -3.62, ["madrid", "ifema"]],
  ["melbourne", "Albert Park", "Australia", "🇦🇺", -37.85, 144.97, ["melbourne", "australia"]],
  ["mexico-city", "Hermanos Rodríguez", "Mexico", "🇲🇽", 19.40, -99.09, ["mexico", "mexico city", "hermanos rodriguez"]],
  ["miami", "Miami International Autodrome", "USA", "🇺🇸", 25.96, -80.24, ["miami", "florida"]],
  ["monte-carlo", "Monaco", "Monaco", "🇲🇨", 43.73, 7.42, ["monte carlo", "monaco"]],
  ["montreal", "Circuit Gilles Villeneuve", "Canada", "🇨🇦", 45.50, -73.52, ["montreal", "canada", "gilles villeneuve"]],
  ["monza", "Monza", "Italy", "🇮🇹", 45.62, 9.29, ["italy", "italian gp"]],
  ["sakhir", "Bahrain International Circuit", "Bahrain", "🇧🇭", 26.03, 50.51, ["bahrain", "sakhir"]],
  ["shanghai", "Shanghai International Circuit", "China", "🇨🇳", 31.34, 121.22, ["shanghai", "china"]],
  ["silverstone", "Silverstone", "Great Britain", "🇬🇧", 52.07, -1.02, ["britain", "british gp", "uk", "england", "united kingdom"]],
  ["singapore", "Marina Bay", "Singapore", "🇸🇬", 1.29, 103.86, ["singapore", "marina bay"]],
  ["spa-francorchamps", "Spa-Francorchamps", "Belgium", "🇧🇪", 50.44, 5.97, ["spa", "belgium", "francorchamps"]],
  ["spielberg", "Red Bull Ring", "Austria", "🇦🇹", 47.22, 14.76, ["austria", "spielberg", "red bull ring"]],
  ["suzuka", "Suzuka", "Japan", "🇯🇵", 34.84, 136.54, ["japan", "suzuka"]],
  ["yas-marina-circuit", "Yas Marina", "Abu Dhabi", "🇦🇪", 24.47, 54.60, ["abu dhabi", "yas marina", "uae", "yas"]],
  ["zandvoort", "Zandvoort", "Netherlands", "🇳🇱", 52.39, 4.54, ["netherlands", "dutch gp", "holland"]],
].map(([slug, name, country, flag, lat, lon, aliases]) => ({ slug, name, country, flag, lat, lon, aliases }));

const MAX = 6;
const REVEAL = [0.1, 0.18, 0.28, 0.42, 0.6, 0.8]; // how much of the lap shows before each guess
const START = new Date(2026, 9, 17); // puzzle #1

const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const label = (c) => `${c.name} — ${c.country}`;
function find(text) {
  const t = norm(text);
  if (!t) return null;
  return CIRCUITS.find((c) => norm(label(c)) === t || norm(c.name) === t || c.aliases.some((a) => norm(a) === t))
    ?? CIRCUITS.find((c) => norm(c.name).startsWith(t) && t.length >= 4) ?? null;
}

// the same shuffled order for everyone, so the daily puzzle is the same for everyone
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled(seed) { const r = rng(seed), a = CIRCUITS.map((c) => c.slug); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function dayNumber(d = new Date()) { const mid = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return Math.round((mid - START) / 86400000) + 1; }
function dailySlug(n) { const cycle = Math.floor((n - 1) / CIRCUITS.length), order = shuffled(2026 + cycle * 7919); return order[(((n - 1) % CIRCUITS.length) + CIRCUITS.length) % CIRCUITS.length]; }

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function arrow(a, b) {
  const rad = Math.PI / 180, y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  const deg = (Math.atan2(y, x) / rad + 360) % 360;
  return ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"][Math.round(deg / 45) % 8];
}
const square = (km) => (km === 0 ? "🟩" : km < 1500 ? "🟨" : km < 5000 ? "🟧" : "🟥");

const shapes = {};
async function shape(slug) {
  if (!shapes[slug]) shapes[slug] = fetch(`../data/tracks/${slug}.json`).then((r) => r.json()).then((d) => d.points);
  return shapes[slug];
}

export function mountTrack(root) {
  let alive = true, timer = null;
  const today = dayNumber();
  let mode = "daily", answer = null, guesses = [], done = false, won = false, offset = 0;

  function begin(m) {
    mode = m;
    if (mode === "daily") {
      answer = CIRCUITS.find((c) => c.slug === dailySlug(today));
      const st = load("track.today", null);
      guesses = st?.day === today ? st.guesses : [];
      done = st?.day === today ? !!st.done : false;
      won = st?.day === today ? !!st.won : false;
      offset = rng(today * 31)();
    } else {
      const pool = CIRCUITS.filter((c) => c.slug !== answer?.slug && c.slug !== dailySlug(today));
      answer = pool[Math.floor(Math.random() * pool.length)];
      guesses = []; done = false; won = false; offset = Math.random();
    }
    draw();
  }

  function persist() {
    if (mode !== "daily") return;
    save("track.today", { day: today, guesses, done, won });
  }
  function record() {
    if (mode !== "daily") return;
    const s = load("track.stats", { played: 0, wins: 0, streak: 0, maxStreak: 0, dist: {}, lastDay: null });
    if (s.lastDay === today) return;
    s.played++;
    if (won) { s.wins++; s.streak = s.lastWinDay === today - 1 ? (s.streak ?? 0) + 1 : 1; s.maxStreak = Math.max(s.maxStreak ?? 0, s.streak); s.lastWinDay = today; s.dist[guesses.length] = (s.dist[guesses.length] ?? 0) + 1; }
    else { s.streak = 0; s.dist.X = (s.dist.X ?? 0) + 1; }
    s.lastDay = today;
    save("track.stats", s);
  }

  function guess(text) {
    if (done) return;
    const c = find(text);
    const form = root.querySelector("#trForm"), note = root.querySelector("#trNote");
    if (!c) { sfx.thud(); form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake"); note.textContent = "That's not one of the circuits — pick one from the list."; return; }
    if (guesses.includes(c.slug)) { note.textContent = `You've already guessed ${c.name}.`; return; }
    guesses.push(c.slug);
    if (c.slug === answer.slug) { done = true; won = true; sfx.fanfare(); }
    else if (guesses.length >= MAX) { done = true; won = false; sfx.buzz(); }
    else sfx.thud();
    persist();
    if (done) record();
    draw();
  }

  async function draw() {
    const pts = await shape(answer.slug);
    if (!alive) return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const size = Math.max(maxX - minX, maxY - minY), pad = size * 0.09;
    const vb = `${minX - pad - (size - (maxX - minX)) / 2} ${minY - pad - (size - (maxY - minY)) / 2} ${size + 2 * pad} ${size + 2 * pad}`;
    const sw = (size + 2 * pad) / 60; // stroke widths scale with the shape
    const n = pts.length;
    const frac = done ? 1 : REVEAL[Math.min(guesses.length, MAX - 1)];
    const len = Math.max(2, Math.round(n * frac)), from = Math.round(offset * n - len / 2);
    const seg = Array.from({ length: len }, (_, i) => pts[(((from + i) % n) + n) % n]);
    const d = (arr, close) => "M" + arr.map((p) => p.join(",")).join("L") + (close ? "Z" : "");

    const rows = Array.from({ length: MAX }, (_, i) => {
      const slug = guesses[i];
      if (!slug) return `<div class="tr-guess empty"><span>${i === guesses.length && !done ? "Your guess…" : ""}</span><span></span><span></span></div>`;
      const c = CIRCUITS.find((x) => x.slug === slug);
      if (slug === answer.slug) return `<div class="tr-guess right"><span>${c.flag} ${esc(c.name)}</span><span class="dist">correct</span><span class="arrow">🏁</span></div>`;
      const km = Math.round(distanceKm(c, answer));
      return `<div class="tr-guess"><span>${c.flag} ${esc(c.name)}</span><span class="dist">${km.toLocaleString()} km</span><span class="arrow" title="The answer is this way">${arrow(c, answer)}</span></div>`;
    }).join("");

    const stats = load("track.stats", { played: 0, wins: 0, streak: 0, maxStreak: 0, dist: {} });
    const maxD = Math.max(1, ...[1, 2, 3, 4, 5, 6, "X"].map((k) => stats.dist?.[k] ?? 0));
    const result = !done ? "" : `<div class="tr-result">
        <div class="muted small">${won ? `Got it in ${guesses.length}!` : "Out of guesses — it was"}</div>
        <h3>${answer.flag} ${esc(answer.name)}</h3>
        <div class="muted">${esc(answer.country)}</div>
        <div class="tr-mode" style="margin-top:6px">
          ${mode === "daily" ? `<button class="btn primary" id="trShare">Share result</button>` : ""}
          <button class="btn" id="trPractice">${mode === "daily" ? "Practice a random track" : "Another random track"}</button>
          ${mode === "practice" ? `<button class="btn ghost" id="trDaily">Back to today's puzzle</button>` : ""}
        </div>
        ${mode === "daily" ? `<div class="muted small" id="trNext"></div>
        <div class="stats" style="margin-top:8px"><div class="stat"><b>${stats.played ?? 0}</b><span>Played</span></div><div class="stat"><b>${stats.played ? Math.round((100 * (stats.wins ?? 0)) / stats.played) : 0}%</b><span>Won</span></div><div class="stat"><b>${stats.streak ?? 0}</b><span>Streak</span></div><div class="stat"><b>${stats.maxStreak ?? 0}</b><span>Best streak</span></div></div>
        <div class="tr-dist">${[1, 2, 3, 4, 5, 6, "X"].map((k) => `<div><span>${k}</span><i class="${won && String(k) === String(guesses.length) ? "today" : ""}" style="width:${Math.max(6, ((stats.dist?.[k] ?? 0) / maxD) * 100)}%">${stats.dist?.[k] ?? 0}</i></div>`).join("")}</div>` : ""}
      </div>`;

    root.innerHTML = `<div class="game">
      <div class="tr-mode"><h1 style="margin-right:auto">Guess the Track</h1><span class="pill">${mode === "daily" ? `Daily #${today}` : "Practice"}</span></div>
      <div class="tr-board">
        <svg class="tr-map ${done ? (won ? "solved" : "failed") : ""}" viewBox="${vb}" role="img" aria-label="${done ? `The ${esc(answer.name)} circuit` : `Part of a mystery circuit — ${Math.round(frac * 100)}% shown`}">
          <path class="ghost" d="${d(pts, true)}" style="stroke-width:${sw * 1.1}"></path>
          ${done ? `<path class="full" d="${d(pts, true)}" style="stroke-width:${sw}"></path>` : `<path class="shown" d="${d(seg, false)}" style="stroke-width:${sw}"></path>`}
        </svg>
        <div class="tr-side">
          ${done ? "" : `<p class="muted small" style="margin:0">Which circuit is this? ${MAX - guesses.length} guess${MAX - guesses.length === 1 ? "" : "es"} left — more of the track appears after each wrong one.</p>
          <form class="tr-form" id="trForm" autocomplete="off"><label class="sr" for="trInput">Circuit</label>
            <input id="trInput" list="trList" placeholder="Type a circuit or country…" autocomplete="off" enterkeyhint="go">
            <button class="btn primary" type="submit">Guess</button></form>
          <datalist id="trList">${CIRCUITS.filter((c) => !guesses.includes(c.slug)).map((c) => `<option value="${esc(label(c))}"></option>`).join("")}</datalist>
          <div class="muted small" id="trNote" role="status"></div>`}
          <div class="tr-guesses">${rows}</div>
          ${result}
        </div>
      </div>
    </div>`;
    // the faint outline would give the answer away — only show it once it's solved
    if (!done) root.querySelector(".ghost")?.remove();
    root.querySelector("#trForm")?.addEventListener("submit", (e) => { e.preventDefault(); const i = root.querySelector("#trInput"); guess(i.value); if (!done) { i.value = ""; i.focus(); } });
    if (!done && matchMedia("(pointer: fine)").matches) root.querySelector("#trInput")?.focus();
    root.querySelector("#trPractice")?.addEventListener("click", () => begin("practice"));
    root.querySelector("#trDaily")?.addEventListener("click", () => begin("daily"));
    root.querySelector("#trShare")?.addEventListener("click", (e) => {
      const marks = guesses.map((g) => square(g === answer.slug ? 0 : distanceKm(CIRCUITS.find((c) => c.slug === g), answer))).join("");
      share(`RaceLimit · Guess the Track #${today} ${won ? guesses.length : "X"}/${MAX}\n${marks}\n${location.origin}${location.pathname}#track`, e.currentTarget);
    });
    if (done && mode === "daily") tick();
  }

  function tick() {
    clearTimeout(timer);
    const el = root.querySelector("#trNext");
    if (!el || !alive) return;
    const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((next - now) / 1000));
    el.textContent = `Next track in ${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    timer = setTimeout(tick, 1000);
  }

  root.innerHTML = `<div class="panel muted">Loading track…</div>`;
  begin("daily");
  return () => { alive = false; clearTimeout(timer); };
}
