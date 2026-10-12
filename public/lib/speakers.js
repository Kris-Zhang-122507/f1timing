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


const dist = (x, y) => Math.sqrt(x.reduce((acc, xi, i) => acc + (xi - y[i]) ** 2, 0));
const mean = (vs) => vs[0].map((_, k) => vs.reduce((acc, v) => acc + v[k], 0) / vs.length);

// ---------------- together ----------------
// Every sentence gets a score: > 0 sounds like the team, < 0 like the driver. It adds up
//   - the words (above),
//   - loudness: on real F1 clips the driver's mic is the louder one about 85% of the time,
//   - voice groups: the clip's sentences split in two by how they sound; the group that the other
//     clues lean towards gets a nudge that way,
// then the most likely sequence of speakers is picked, with a cost for each change of speaker
// (smaller right after "Copy." / "Understood", which usually means the other person). Sentences
// where both answers are about as likely stay untagged.
// tuned on 30 real clips hand-labelled sentence by sentence (about 80% right on clips it wasn't tuned on)
export const P = { wt: 1.5, wa: 2, dB: 2, gap: 5, sw: 1, sure: 0.5, clamp: 1.5, minDur: 0.6, wc: 1, csep: 1, ack: 2 };
const ACK = /^(copy|copy that|okay|ok|yeah|yes|yep|understood|roger|got it|negative|affirm|confirm|thanks|thank you|cheers)\b/i;
export function label(segs, audio, fullName = "", explain = false) {
  const sents = sentences(segs);
  const n = sents.length;
  if (!n) return explain ? { lines: [], who: [] } : [];
  const score = sents.map((x) => Math.max(-P.clamp, Math.min(P.clamp, textScore(x.text, fullName))));
  const prints = audio ? sents.map((x) => voiceprint(audio, x.from, x.to)) : sents.map(() => null);
  // loudness: the driver's mic is usually the louder one. Split the clip's sentences into a loud
  // and a quiet group; how far each sentence sits from the middle is the evidence.
  const lv = prints.map((p, i) => (p && sents[i].to - sents[i].from >= 0.25 ? p.level : null));
  const known = lv.filter((x) => x != null).sort((a, b) => a - b);
  let mid = null, spread = 0;
  if (known.length >= 2) {
    let best = Infinity, cut = 1;
    for (let k = 1; k < known.length; k++) {
      const A = known.slice(0, k), B = known.slice(k);
      const ma = A.reduce((x, y) => x + y, 0) / A.length, mb = B.reduce((x, y) => x + y, 0) / B.length;
      const ss = A.reduce((x, y) => x + (y - ma) ** 2, 0) + B.reduce((x, y) => x + (y - mb) ** 2, 0);
      if (ss < best) { best = ss; cut = k; mid = (ma + mb) / 2; spread = mb - ma; }
    }
  }
  const acoustic = lv.map((x, i) => {
    if (x == null || mid == null) return 0;
    const dur = Math.min(1, (sents[i].to - sents[i].from) / P.minDur);
    const two = Math.min(1, Math.max(0, (spread - 1.5) / P.gap)); // only if there really are two levels
    return -((x - mid) / P.dB) * two * dur; // > 0 → team (quieter)
  });
  let ev = score.map((s, i) => P.wt * s + P.wa * acoustic[i]); // > 0 → team
  // voice groups: split the sentences into two groups by how they sound (all measurements,
  // scaled within the clip). Which group is which is decided by the other evidence.
  if (P.wc && audio) {
    const F = prints.map((p, i) => (p && sents[i].to - sents[i].from >= 0.4 ? [p.level, ...p.shape] : null));
    const idx = F.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
    if (idx.length >= 3) {
      const dim = F[idx[0]].length;
      const mu = Array.from({ length: dim }, (_, k) => idx.reduce((a, i) => a + F[i][k], 0) / idx.length);
      const sd = Array.from({ length: dim }, (_, k) => Math.sqrt(idx.reduce((a, i) => a + (F[i][k] - mu[k]) ** 2, 0) / idx.length) || 1);
      const Z = new Map(idx.map((i) => [i, F[i].map((x, k) => (x - mu[k]) / sd[k])]));
      const dist2 = (a, b) => a.reduce((acc, x, k) => acc + (x - b[k]) ** 2, 0);
      let ca = null, cb = null, far = -1;
      for (const i of idx) for (const j of idx) if (i < j && dist2(Z.get(i), Z.get(j)) > far) { far = dist2(Z.get(i), Z.get(j)); ca = Z.get(i); cb = Z.get(j); }
      let g = new Map();
      for (let it = 0; it < 15; it++) {
        g = new Map(idx.map((i) => [i, dist2(Z.get(i), ca) <= dist2(Z.get(i), cb) ? 0 : 1]));
        const A = idx.filter((i) => !g.get(i)), B = idx.filter((i) => g.get(i));
        if (!A.length || !B.length) break;
        ca = Array.from({ length: dim }, (_, k) => A.reduce((a, i) => a + Z.get(i)[k], 0) / A.length);
        cb = Array.from({ length: dim }, (_, k) => B.reduce((a, i) => a + Z.get(i)[k], 0) / B.length);
      }
      const within = Math.sqrt(idx.reduce((a, i) => a + dist2(Z.get(i), g.get(i) ? cb : ca), 0) / idx.length) || 1;
      const sep = Math.sqrt(dist2(ca, cb)) / within;
      if (sep >= P.csep) {
        // polarity: does group 0 lean team or driver, by everything else we know?
        const lean = idx.reduce((a, i) => a + (g.get(i) ? -ev[i] : ev[i]), 0);
        const pol = lean >= 0 ? 1 : -1;
        const strength = Math.min(1, Math.abs(lean) / 3) * Math.min(1, (sep - P.csep + 0.5) / 1.5);
        ev = ev.map((e, i) => (g.has(i) ? e + P.wc * strength * (g.get(i) ? -pol : pol) : e));
      }
    }
  }
  // best sequence: each sentence's evidence, with a cost for every change of speaker
  const st = ["Team", "Driver"], sign = [1, -1];
  const fw = [[sign[0] * ev[0], sign[1] * ev[0]]];
  // a reply ("Copy.", "Understood") usually means the other person is talking now
  const sw = sents.map((x, i) => (i && ACK.test(x.text.trim()) && !ACK.test(sents[i - 1].text.trim()) ? P.sw - P.ack : P.sw));
  for (let i = 1; i < n; i++) fw.push([0, 1].map((k) => sign[k] * ev[i] + Math.max(fw[i - 1][k], fw[i - 1][1 - k] - sw[i])));
  const bw = Array.from({ length: n }, () => [0, 0]);
  for (let i = n - 2; i >= 0; i--) bw[i] = [0, 1].map((k) => Math.max(sign[k] * ev[i + 1] + bw[i + 1][k], sign[1 - k] * ev[i + 1] + bw[i + 1][1 - k] - sw[i + 1]));
  const who = sents.map((_, i) => {
    const t = fw[i][0] + bw[i][0], d = fw[i][1] + bw[i][1];
    return Math.abs(t - d) < P.sure ? null : t > d ? "Team" : "Driver";
  });
  const lines = [];
  sents.forEach((x, i) => {
    const last = lines.at(-1);
    if (last && last.who === who[i]) last.text += ` ${x.text}`;
    else lines.push({ who: who[i], text: x.text });
  });
  if (explain) return { lines, who, ev, acoustic, score };
  return lines;
}
