// Qualifying: who gets through? For each driver: their best, the gap to the cut-off, and — if
// they're on a lap right now — where that lap is heading (sectors done + their best for the rest).
import { lapSeconds } from "./lib/race.js?v=mv4wen66";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const secs = (x) => { const v = lapSeconds(x) ?? parseFloat(x); return Number.isFinite(v) && v > 0 ? v : null; };
const fmt = (s) => (s == null ? "—" : s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}` : s.toFixed(3));

// Where is this driver's current lap? null if they're not on one.
function currentLap(r) {
  if (r.inPit || r.out || r.knockedOut) return null;
  const done = r.sectors.map((x) => secs(x.v));
  const best = (r.bestSectors ?? []).map(secs);
  let k = 0; // sectors finished on this lap
  if (done[0] && !done[1] && !done[2]) k = 1;
  else if (done[0] && done[1] && !done[2]) k = 2;
  else {
    // between laps the old sector times stay up: look at the minisectors of sector 1 instead
    const s1 = r.sectors[0]?.seg ?? [];
    const filled = s1.filter((x) => x && x !== 0).length;
    if (!(filled > 0 && filled < s1.length)) return null;
    return { k: 0, progress: filled / s1.length, colours: r.sectors.map((x) => x.c), predicted: null };
  }
  if ([0, 1, 2].slice(k).some((i) => !best[i])) return { k, predicted: null, colours: r.sectors.map((x) => x.c) };
  const predicted = done.slice(0, k).reduce((a, x) => a + x, 0) + best.slice(k).reduce((a, x) => a + x, 0);
  // a sector far off their best means a slow lap (cool-down or aborted), not a push
  const slow = done.slice(0, k).some((x, i) => best[i] && x > best[i] + 1.5);
  return { k, predicted: slow ? null : predicted, slow, colours: r.sectors.map((x) => x.c) };
}

export function renderKnockout(v) {
  const q = v.quali;
  if (!q) return `<div class="muted small">This fills in during qualifying: who's through, who's in the drop zone, and whether the laps they're on now will be enough.</div>`;
  const rows = v.rows.filter((r) => r.pos < 99 && !r.knockedOut);
  if (!rows.length) return `<div class="muted small">Waiting for timing data…</div>`;
  const cut = q.advance;
  const bests = rows.map((r) => ({ r, best: secs(r.best), now: currentLap(r) }));
  const cutRow = cut ? bests.find((b) => b.r.pos === cut) : null;
  const cutTime = cutRow?.best ?? null;
  const pole = bests.find((b) => b.r.pos === 1)?.best ?? null;
  // where a predicted lap would put them, against everyone's current bests
  const placeOf = (t, self) => 1 + bests.filter((b) => b !== self && b.best != null && b.best < t).length;
  const improving = bests.filter((b) => b.now?.predicted && (!b.best || b.now.predicted < b.best));
  const lines = bests.map((b) => {
    const { r, best, now } = b;
    const inZone = cut && r.pos > cut;
    let verdict = "", cls = "";
    const pred = now?.predicted && (!best || now.predicted < best) ? now.predicted : null;
    const predPos = pred ? placeOf(pred, b) : null;
    if (cut) {
      if (pred && inZone) { verdict = predPos <= cut ? `on a lap — on course for P${predPos}, would get through` : `on a lap — heading for P${predPos}, not enough yet`; cls = predPos <= cut ? "good" : "warn"; }
      else if (pred && !inZone) { verdict = `on a lap — heading for P${predPos}`; cls = "good"; }
      else if (inZone) { verdict = r.inPit ? "in the pits — needs another run" : now ? "on a lap" : best ? `needs ${cutTime ? `−${(best - cutTime + 0.001).toFixed(3)}` : "a faster lap"}` : "no time yet"; cls = "bad"; }
      else {
        // could someone below bump them out?
        // each car that goes ahead pushes them down one place; they're out once enough do
        const threats = improving.filter((x) => x.r.pos > r.pos && x.now.predicted < (best ?? Infinity));
        const room = cut - r.pos + 1; // places they can lose and still get through
        const atRisk = threats.length >= room;
        verdict = atRisk ? `could be bumped out by ${threats.map((x) => esc(x.r.tla)).join(", ")}` : r.pos === cut ? "on the bubble" : threats.length && room <= 3 ? `safe unless ${room} cars beat them (${threats.length} on a lap that could)` : "safe for now";
        cls = atRisk ? "bad" : threats.length || r.pos === cut ? "warn" : "";
      }
    } else {
      verdict = pred ? (predPos === 1 ? `on a lap — on course for POLE (${fmt(pred)})` : `on a lap — heading for P${predPos}`) : r.pos === 1 ? "provisional pole" : best && pole ? `+${(best - pole).toFixed(3)} to pole` : "no time yet";
      cls = pred && predPos === 1 ? "good" : "";
    }
    const dots = now ? `<span class="kq-dots">${[0, 1, 2].map((i) => `<i class="${i < now.k ? (now.colours[i] === "p" ? "p" : now.colours[i] === "g" ? "g" : "y") : ""}"></i>`).join("")}</span>` : "";
    return `<tr class="${inZone ? "zone" : ""} ${cut && r.pos === cut ? "bubble" : ""}">
      <td class="num pos">${r.pos}</td>
      <td><i class="team" style="background:${esc(r.colour)}"></i><span class="drv">${esc(r.tla)}</span></td>
      <td class="num">${fmt(best)}</td>
      <td class="num ${cut && best && cutTime ? (best <= cutTime ? "good" : "bad") : ""}">${cut && best && cutTime && r.pos !== cut ? `${best <= cutTime ? "−" : "+"}${Math.abs(best - cutTime).toFixed(3)}` : ""}</td>
      <td>${dots}${pred ? ` <span class="mono">${fmt(pred)}</span>` : ""}</td>
      <td class="small kq-verdict ${cls}">${verdict}</td>
    </tr>${cut && r.pos === cut ? `<tr class="kq-cut"><td colspan="6"><span>top ${cut} go through to Q${q.part + 1}${cutTime ? ` · cut-off ${fmt(cutTime)}` : ""}</span></td></tr>` : ""}`;
  }).join("");
  return `<div class="kq-head small muted">${q.part ? `Q${q.part}` : "Qualifying"}${v.clock?.remaining ? ` · ${esc(v.clock.remaining)} left` : ""} · laps in progress use their sectors so far plus their best for the rest</div>
    <table class="timing compact kq"><thead><tr><th class="r">P</th><th>DRV</th><th class="r">BEST</th><th class="r">TO CUT</th><th>NOW</th><th></th></tr></thead><tbody>${lines}</tbody></table>`;
}
