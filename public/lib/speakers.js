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
  if (has(/\bwell (done|driven|drove)\b|\bgreat (job|drive|work|stuff)\b|\bgood (job|work|stuff)\b|\bnice (job|work)\b|\bfantastic\b|\bbrilliant\b|\bmega\b|\bwhat a (drive|job|race)\b|\bproud of you\b/)) s += 1.5;
  if (has(/\bmate\b/)) s += 0.5;
  if (has(/\bwe('re| are|'ll| will| have| need| can)\b/)) s += 0.5;
  // driver talk
  if (has(/\bi\b|\bi'm\b|\bi've\b|\bi'll\b|\bi'd\b|\bmy\b|\bme\b/)) s -= 1.5;
  if (has(/\bguys\b/)) s -= 1.5;
  if (has(/\bthank (you|u),? (everyone|everybody|all|team|so much,? (guys|everyone))\b|\bthanks,? (everyone|everybody|all|team)\b/)) s -= 1.5;
  else if (has(/\bthank you\b|\bthanks\b/)) s -= 0.5;
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

// the fingerprint of a stretch of audio: the average spectrum shape (dB) of its loudest frames
// (where someone's talking) with overall loudness taken out, plus how loud the talking is and
// how loud the background is between words. Each mic has its own level and its own hiss/hum.
export function voiceprint(audio, from, to) {
  const a = Math.max(0, Math.floor(from * SR)), b = Math.min(audio.length, Math.ceil(to * SR));
  const frames = [];
  for (let i = a; i + N <= b; i += HOP) {
    const p = fftPower(audio.subarray(i, i + N));
    let total = 1e-10;
    const bands = BANK.map(([l, c, h]) => {
      let e = 1e-10;
      for (let k = Math.ceil(l); k <= Math.floor(h); k++) e += p[k] * (k <= c ? (k - l) / (c - l || 1) : (h - k) / (h - c || 1));
      total += e;
      return 10 * Math.log10(e);
    });
    frames.push({ e: 10 * Math.log10(total), bands });
  }
  if (frames.length < 4) return null;
  frames.sort((x, y) => y.e - x.e);
  const voiced = frames.slice(0, Math.max(3, Math.ceil(frames.length * 0.4)));
  const v = Array.from({ length: BANDS }, (_, k) => voiced.reduce((acc, f) => acc + f.bands[k], 0) / voiced.length);
  const m = v.reduce((x, y) => x + y, 0) / BANDS;
  return { shape: v.map((x) => x - m), level: voiced.reduce((acc, f) => acc + f.e, 0) / voiced.length, floor: frames[Math.floor(frames.length * 0.85)].e };
}

// how different two stretches sound (roughly dB): spectrum shape, talking level, background level
export const voiceGap = (x, y) => Math.sqrt(x.shape.reduce((acc, xi, i) => acc + (xi - y.shape[i]) ** 2, 0) / BANDS) * 2 + Math.abs(x.level - y.level) * 0.5 + Math.abs(x.floor - y.floor) * 0.35;

const dist = (x, y) => Math.sqrt(x.reduce((acc, xi, i) => acc + (xi - y[i]) ** 2, 0));
const mean = (vs) => vs[0].map((_, k) => vs.reduce((acc, v) => acc + v[k], 0) / vs.length);

// two groups by voice; sep = how far apart the groups are compared with how spread out each is
function twoVoices(fps) {
  const prints = fps.map((p) => (p ? [...p.shape, p.level * 0.5, p.floor * 0.35] : null));
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
// A clip is a run of "turns", and the speaker swaps at each handover — there are only two people.
// So: find the handovers, label the turns whose words are clear, and the turns in between take
// the opposite of their neighbour.
const SURE = 1.5;     // text score needed to call a sentence or turn on its words alone
const SOUND = 4.5;    // how different (≈dB) two sentences must sound to count as a different mic
const ACK = /^(copy|copy that|okay|ok|yeah|yes|yep|understood|roger|got it|thanks|thank you|cheers)\b/i;

export function label(segs, audio, fullName = "", explain = false) {
  const sents = sentences(segs);
  const n = sents.length;
  if (!n) return [];
  const score = sents.map((x) => textScore(x.text, fullName));
  const byText = score.map((v) => (v >= SURE ? "Team" : v <= -SURE ? "Driver" : null));
  const prints = audio ? sents.map((x) => voiceprint(audio, x.from, x.to)) : sents.map(() => null);
  const voices = audio ? twoVoices(prints) : null;
  const first = fullName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const names = first ? [first, ...(NICK[first] ?? [])] : [];
  const startsWithName = (t) => names.some((nm) => new RegExp(`^\\W*${reEsc(nm)}\\b`, "i").test(t));

  // evidence for a handover between sentence i and i + 1 (> 1 means yes)
  const why = [];
  const handover = [];
  let turnStart = 0;
  for (let i = 0; i + 1 < n; i++) {
    let e = 0;
    const notes = [];
    // the new sentence against the whole turn so far (a single short sentence is a poor sample)
    const a = audio ? voiceprint(audio, sents[turnStart].from, sents[i].to) : null, b = prints[i + 1];
    if (a && b) {
      const d = voiceGap(a, b), trust = Math.min(1, (sents[i + 1].to - sents[i + 1].from) / 1.5);
      e += (trust * (d - SOUND)) / 2; notes.push(`sound ${d.toFixed(1)}${trust < 1 ? ` (short, ×${trust.toFixed(1)})` : ""}`);
    }
    if (voices?.group.has(i) && voices.group.has(i + 1) && voices.sep >= 1.5) {
      const differ = voices.group.get(i) !== voices.group.get(i + 1), w = Math.min(1.5, voices.sep / 3);
      e += differ ? w : -w; notes.push(`${differ ? "voice groups differ" : "same voice group"} (${voices.sep.toFixed(1)})`);
    }
    const gap = sents[i + 1].from - sents[i].to;
    if (gap >= 0.7) { e += gap >= 1.5 ? 0.8 : 0.4; notes.push(`pause ${gap.toFixed(1)}s`); }
    const next = sents[i + 1].text.trim(), prev = sents[i].text.trim();
    if (startsWithName(next) && !startsWithName(prev)) { e += 1; notes.push("starts with his name"); }
    if (ACK.test(next) && !ACK.test(prev)) { e += 0.5; notes.push("reply word"); }
    if (/\?\s*$/.test(prev)) { e += 0.6; notes.push("after a question"); }
    if (byText[i] && byText[i + 1]) { e += byText[i] !== byText[i + 1] ? 3 : -3; notes.push(byText[i] !== byText[i + 1] ? "words disagree" : "words agree"); }
    handover.push(e > 1);
    if (e > 1) turnStart = i + 1;
    why.push(`${i}|${i + 1}: ${e.toFixed(1)} (${notes.join(", ")})`);
  }

  // turns
  const turns = [[0]];
  for (let i = 1; i < n; i++) { if (handover[i - 1]) turns.push([i]); else turns.at(-1).push(i); }
  const tScore = turns.map((t) => t.reduce((acc, i) => acc + score[i], 0));
  const tWho = tScore.map((v) => (v >= SURE ? "Team" : v <= -SURE ? "Driver" : null));
  // fill in from neighbours, alternating, nearest clear turn first
  for (let pass = 0; pass < turns.length; pass++) {
    for (let k = 0; k < turns.length; k++) {
      if (tWho[k]) continue;
      const left = tWho[k - 1], right = tWho[k + 1];
      if (left && right && left !== right) continue; // can't both be right — leave it
      const from = left ?? right;
      if (from) tWho[k] = from === "Team" ? "Driver" : "Team";
    }
  }
  const who = [];
  turns.forEach((t, k) => { for (const i of t) who[i] = Math.abs(score[i]) >= 3 ? byText[i] : tWho[k] ?? byText[i]; });

  // join neighbouring sentences from the same speaker into one line
  const lines = [];
  sents.forEach((x, i) => {
    const last = lines.at(-1);
    if (last && last.who === who[i] && !(i > 0 && handover[i - 1] && who[i] == null)) last.text += ` ${x.text}`;
    else lines.push({ who: who[i], text: x.text });
  });
  if (explain) return { lines, why, score, turns, voices: voices && { sep: voices.sep } };
  return lines;
}
