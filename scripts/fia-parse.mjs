// Parsers for two FIA documents, from `pdftotext -layout` text:
//   "PU Elements used per Driver up to now"  -> how many of each power unit element each driver has used
//   "Car Presentation Submissions"           -> each team's upgrades for the weekend
// The car presentation tables wrap text inside cells, so components, reasons and descriptions
// are rebuilt by column position; the count of updates per team is exact (numbered rows).

export const PU_ELEMENTS = ["ICE", "TC", "EXH", "MGU-K", "ES", "PU-CE", "PU-ANC"];
// season allowance per driver before grid penalties (2026 sporting regulations)
export const PU_ALLOWANCE = { ICE: 4, TC: 4, EXH: 4, "MGU-K": 3, ES: 3, "PU-CE": 3, "PU-ANC": 6 };

export function parsePu(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d{1,2})\s{2,}(.+?)\s{2,}(\S.*?)\s{2,}(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    const used = Object.fromEntries(PU_ELEMENTS.map((e, i) => [e, Number(m[4 + i])]));
    rows.push({ n: String(Number(m[1])), car: m[2].trim(), driver: m[3].trim(), used });
  }
  return rows;
}

// split a line into chunks of text separated by 2+ spaces, with their centre column
function chunks(line) {
  const out = [];
  const re = /\S+(?: \S+)*/g;
  let m;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length, mid: m.index + m[0].length / 2 });
  return out;
}

const TYPE = (reason) => {
  const r = reason.toLowerCase();
  if (r.startsWith("performance")) return "Performance";
  if (r.startsWith("circuit")) return "Circuit specific";
  if (r.startsWith("reliab")) return "Reliability";
  return reason ? reason.split(/\s*-\s*/)[0] : "Other";
};

export function parseCarPresentation(text) {
  const lines = text.split("\n");
  const teams = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/Car Presentation\s+[–-]/.test(line)) {
      // the team name is the next non-empty line
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      cur = { team: lines[j].trim(), lines: [], header: null };
      teams.push(cur);
      i = j;
      continue;
    }
    if (!cur) continue;
    if (!cur.header && /Updated/.test(line) && /Primary/.test(line)) { cur.header = chunks(line); continue; }
    if (cur.header && /^\s*component\b/i.test(line)) continue; // second header line
    cur.lines.push(line);
  }
  return teams.map((t) => {
    const none = t.lines.some((l) => /No updates?\b/i.test(l));
    if (!t.header || none) return { team: t.team, updates: [] };
    // column centres from the header: component, reason, geometry, description
    const cols = t.header.map((c) => c.mid);
    const body = t.lines.map((l) => chunks(l)).filter((cs) => cs.length);
    // a row starts at a line with an item number in the first few columns
    const numbered = [];
    body.forEach((cs, idx) => { const first = cs[0]; if (first.start < 6 && /^\d{1,2}$/.test(first.text.split(" ")[0])) numbered.push(idx); });
    if (!numbered.length) return { team: t.team, updates: [] };
    const rows = numbered.map(() => [[], [], [], []]);
    body.forEach((cs, idx) => {
      // nearest numbered line (ties go to the later row: cells are centred on their row)
      let best = 0;
      numbered.forEach((nIdx, r) => { if (Math.abs(nIdx - idx) <= Math.abs(numbered[best] - idx)) best = r; });
      for (const c of cs) {
        let text = c.text;
        if (c.start < 6) { text = text.replace(/^\d{1,2}\s*/, ""); if (!text) continue; }
        const mid = c.start < 6 ? c.start + 4 + text.length / 2 : c.mid;
        let col = 0;
        cols.forEach((x, k) => { if (Math.abs(x - mid) < Math.abs(cols[col] - mid)) col = k; });
        rows[best][col].push(text);
      }
    });
    const join = (xs) => xs.join(" ").replace(/\s+-\s*$/, "").replace(/\s+/g, " ").replace(/ - (\w)/g, " - $1").trim();
    return {
      team: t.team,
      updates: rows.map(([comp, reason, geo, desc]) => {
        const r = join(reason).replace(/(\w)- (\w)/g, "$1-$2");
        return { component: join(comp), reason: r, type: TYPE(r), geometry: join(geo), description: join(desc) };
      }),
    };
  });
}
