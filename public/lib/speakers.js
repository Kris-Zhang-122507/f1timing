// Driver or team? Two clues, combined:
//   1. the words — engineers call the driver by name, give gaps, positions and instructions and
//      say "you"; drivers say "I", "my", talk about the car and call the team "guys".
//   2. the voice — each sentence gets a fingerprint of its sound (the shape of its spectrum while
//      someone is speaking). Sentences are split into two groups by that fingerprint; when the
//      words say which group is which, the rest of each group follows.
// Lines with no real clue stay untagged rather than guessed.

// ---------------- sentences ----------------
// Whisper's lines can hold both speakers ("Box box. Copy."), so split them into sentences,
// using word timings when the helper sends them, else sharing the time out by length.
export function sentences(segs) {
  const out = [];
  for (const s of segs) {
    if (s.words?.length) {
      let cur = null;
      for (const w of s.words) {
        const word = String(w.word ?? "").trim();
        if (!word) continue;
        if (!cur) cur = { text: word, from: Number(w.start) || s.from, to: Number(w.end) || s.to };
        else { cur.text += ` ${word}`; cur.to = Number(w.end) || cur.to; }
        if (/[.?!]$/.test(word)) { out.push(cur); cur = null; }
      }
      if (cur) out.push(cur);
      continue;
    }
    const parts = s.text.split(/(?<=[.?!])\s+/).filter(Boolean);
    const total = parts.reduce((a, p) => a + p.length, 0) || 1;
    let t = s.from;
    for (const p of parts) {
      const d = ((s.to - s.from) * p.length) / total;
      out.push({ text: p, from: t, to: t + d });
      t += d;
    }
  }
  return out;
}

// ---------------- the words ----------------
const NICK = { alexander: ["alex"], oliver: ["ollie", "olly"], gabriel: ["gabi", "gabby"], sergio: ["checo"], fernando: ["nando"], valtteri: ["val"], andrea: ["kimi"], nicholas: ["nico"], nicolas: ["nico"] };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// > 0: sounds like the team; < 0: sounds like the driver; 0: can't tell ("Copy.", "Yeah.")
export function textScore(text, fullName = "") {
  const t = ` ${String(text).toLowerCase().replace(/[’`]/g, "'")} `;
  let s = 0;
  const has = (re) => re.test(t);
  // called by name: "Alex, box box" / "Good job, Lando"
  const first = fullName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const names = first ? [first, ...(NICK[first] ?? [])] : [];
  if (names.length && new RegExp(`(^\\s*|[,.!?]\\s*)(${names.map(reEsc).join("|")})\\b|\\b(${names.map(reEsc).join("|")})[.!?,]?\\s*$`).test(t)) s += 3;
  const question = /\?\s*$/.test(t);
  // driver asking for information
  if (has(/\b(what'?s|what is|where'?s|where are) (the |my )?(gap|we|lap|plan|position|delta|pace)|\b(are|should) (we|i) (box|boxing|pit|stay)|\bwhich tyre|\bhow many laps|\bhow long\b|\bwhat lap\b/)) s -= 2.5;
  // engineer asking how things are
  else if (has(/\bhow (are|is|'s|do|does) (the |your |you )?(tyres?|balance|car|grip|it|feel|feeling|things|brakes?|rears?|fronts?)/)) s += 2;
  else if (question) s -= 0.5;
  if (has(/\bbox,? box\b|\bbox (this|now|at the end)\b|\bstay out\b|\bpit confirm/) && !question) s += 2;
  const info = [/\b\d+([.,]\d+)? ?(seconds|second|tenths|tenth|secs)\b/, /\bgap (is|to|now|behind|ahead)\b/, /\bp\d{1,2}\b|\bposition\b/, /\b\d+ laps? (to go|remaining|left)\b|\blaps? to go\b/, /\bdelta\b|\btarget\b|\bplan [a-z]\b|\bstrat \d|\b(mode|switch) \w/, /\bpush now\b|\bkeep (it up|pushing|going)\b|\bmanage\b|\bstand ?by\b/, /\bcar (ahead|behind)\b|\b(behind|ahead of|in front of) you\b|\bon (your|the) tail\b/, /\byellow flag|\bsafety car\b|\bvsc\b|\bred flag/];
  s += Math.min(2.5, info.filter((re) => re.test(t)).length);
  const noThanks = t.replace(/\bthank you\b/g, "");
  if (/\byou('re| are|'ve| have|'ll| will| need| can| did| got)\b|\byour\b/.test(noThanks)) s += 1;
  if (has(/\bwell done\b|\bgreat (job|drive|work|stuff)\b|\bgood (job|work|stuff)\b|\bnice (job|work)\b|\bfantastic\b|\bbrilliant\b|\bmega\b|\bwhat a (drive|job|race)\b|\bproud of you\b/)) s += 1.5;
  if (has(/\bmate\b/)) s += 0.5;
  if (has(/\bwe('re| are|'ll| will| have| need| can)\b/)) s += 0.5;
  // driver talk
  if (has(/\bi\b|\bi'm\b|\bi've\b|\bi'll\b|\bi'd\b|\bmy\b|\bme\b/)) s -= 1.5;
  if (has(/\bguys\b/)) s -= 1.5;
  if (has(/\bthank you\b|\bthanks\b/)) s -= 0.5;
  if (has(/\bthe car\b|\btyres? (are|is) (gone|dead|done|finished|cold|graining)\b|\bno grip\b|\bunder ?steer|\bover ?steer|\bthe (rears?|fronts?)\b|\bblue flags?\b|\bhe (pushed|hit|forced|crashed|moved|blocked|went|just)\b|\bhe's\b|\bdangerous\b|\bunbelievable\b|\bridiculous\b|\bwhat (was|is) that\b|\bno power\b|\bengine\b|\bgearbox\b|\bpuncture\b|\bi lost\b/)) s -= 1;
  if (has(/\b(come on|let's go|lets go|get in there|vamos|allez|forza)\b|\by+e+s+!|\bwoo+\b|\bwoohoo\b/)) s -= 1.5;
  if (has(/\bf[*u]+c?k|\bf\*+|\bshit\b|\bdamn\b|\bbloody\b/)) s -= 1;
  return s;
}

// ---------------- the voice ----------------
const N = 512, HOP = 256, SR = 16000, BANDS = 24;
// mel filter bank, 80 Hz – 7.6 kHz
const mel = (f) => 2595 * Math.log10(1 + f / 700);
const imel = (m) => 700 * (10 ** (m / 2595) - 1);
const BANK = (() => {
  const lo = mel(80), hi = mel(7600);
  const pts = Array.from({ length: BANDS + 2 }, (_, i) => imel(lo + ((hi - lo) * i) / (BANDS + 1)) / (SR / N));
  return Array.from({ length: BANDS }, (_, b) => [pts[b], pts[b + 1], pts[b + 2]]);
})();
const WIN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

function fftPower(frame) {
  const re = Float64Array.from(frame, (x, i) => x * WIN[i]), im = new Float64Array(N);
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  const p = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

// the fingerprint of a stretch of audio: average spectrum shape (dB) of its loudest frames
// (where someone's talking), with overall loudness taken out
export function voiceprint(audio, from, to) {
  const a = Math.max(0, Math.floor(from * SR)), b = Math.min(audio.length, Math.ceil(to * SR));
  const frames = [];
  for (let i = a; i + N <= b; i += HOP) {
    const p = fftPower(audio.subarray(i, i + N));
    const bands = BANK.map(([l, c, h]) => {
      let e = 1e-10;
      for (let k = Math.ceil(l); k <= Math.floor(h); k++) e += p[k] * (k <= c ? (k - l) / (c - l || 1) : (h - k) / (h - c || 1));
      return 10 * Math.log10(e);
    });
    frames.push({ e: bands.reduce((x, y) => x + y, 0), bands });
  }
  if (frames.length < 4) return null;
  frames.sort((x, y) => y.e - x.e);
  const voiced = frames.slice(0, Math.max(3, Math.ceil(frames.length * 0.4)));
  const v = Array.from({ length: BANDS }, (_, k) => voiced.reduce((acc, f) => acc + f.bands[k], 0) / voiced.length);
  const m = v.reduce((x, y) => x + y, 0) / BANDS;
  return v.map((x) => x - m);
}

const dist = (x, y) => Math.sqrt(x.reduce((acc, xi, i) => acc + (xi - y[i]) ** 2, 0));
const mean = (vs) => vs[0].map((_, k) => vs.reduce((acc, v) => acc + v[k], 0) / vs.length);

// two groups by voice; sep = how far apart the groups are compared with how spread out each is
function twoVoices(prints) {
  const idx = prints.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  if (idx.length < 2) return null;
  let sa = idx[0], sb = idx[1], best = -1;
  for (const i of idx) for (const j of idx) if (i < j && dist(prints[i], prints[j]) > best) { best = dist(prints[i], prints[j]); sa = i; sb = j; }
  let ca = prints[sa], cb = prints[sb], group = new Map();
  for (let it = 0; it < 10; it++) {
    group = new Map(idx.map((i) => [i, dist(prints[i], ca) <= dist(prints[i], cb) ? 0 : 1]));
    const A = idx.filter((i) => group.get(i) === 0).map((i) => prints[i]), B = idx.filter((i) => group.get(i) === 1).map((i) => prints[i]);
    if (!A.length || !B.length) return null;
    ca = mean(A); cb = mean(B);
  }
  const within = Math.sqrt(idx.reduce((acc, i) => acc + dist(prints[i], group.get(i) ? cb : ca) ** 2, 0) / idx.length);
  return { group, sep: dist(ca, cb) / Math.max(within, 3) };
}

// ---------------- together ----------------
const SURE = 1.5;   // text score needed to call a sentence on its words alone
const APART = 2.2;  // voice groups this far apart are taken to be two different people
export function label(segs, audio, fullName = "") {
  const sents = sentences(segs);
  const score = sents.map((x) => textScore(x.text, fullName));
  const byText = score.map((s) => (s >= SURE ? "Team" : s <= -SURE ? "Driver" : null));
  const prints = audio ? sents.map((x) => voiceprint(audio, x.from, x.to)) : [];
  const voices = audio ? twoVoices(prints) : null;
  let who = byText.slice();

  if (voices) {
    const g = voices.group;
    const sum = [0, 0];
    for (const [i, k] of g) sum[k] += score[i];
    const tags = [new Set(), new Set()];
    for (const [i, k] of g) if (byText[i]) tags[k].add(byText[i]);
    const mixed = tags[0].size > 1 || tags[1].size > 1;
    const same = !mixed && tags[0].size && tags[1].size && [...tags[0]][0] === [...tags[1]][0];
    if (!mixed && !same && voices.sep >= APART && (tags[0].size || tags[1].size)) {
      // two people, and the words tell us who's who: one group is the team, the other the driver
      const teamGroup = sum[0] === sum[1] ? (tags[0].has("Team") || tags[1].has("Driver") ? 0 : 1) : sum[0] > sum[1] ? 0 : 1;
      who = sents.map((_, i) => (g.has(i) ? (g.get(i) === teamGroup ? "Team" : "Driver") : byText[i]));
      // a really clear sentence keeps its own label
      who = who.map((w, i) => (Math.abs(score[i]) >= 3 ? byText[i] : w));
    } else if (!mixed && (voices.sep < APART || same)) {
      // sounds like one person: everyone gets the label the words agree on
      const all = [...tags[0], ...tags[1]];
      if (all.length && all.every((x) => x === all[0])) who = sents.map(() => all[0]);
    }
  } else {
    // no voice info: a clip where the words only ever point one way is one person talking
    const all = byText.filter(Boolean);
    if (all.length && all.every((x) => x === all[0]) && sents.length <= 3) who = sents.map(() => all[0]);
  }
  // a short reply with no clue ("Copy.") right after one side talked is usually the other side
  for (let i = 1; i < sents.length; i++) {
    if (!who[i] && who[i - 1] && /^(copy|copy that|okay|ok|yeah|yes|yep|understood|roger|got it|thanks|thank you)[.!]*$/i.test(sents[i].text.trim())) who[i] = who[i - 1] === "Team" ? "Driver" : "Team";
  }
  // join neighbouring sentences from the same speaker into one line
  const lines = [];
  sents.forEach((x, i) => {
    const last = lines.at(-1);
    if (last && last.who === who[i]) last.text += ` ${x.text}`;
    else lines.push({ who: who[i], text: x.text });
  });
  return lines;
}
