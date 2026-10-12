// Penalties, investigations, warnings and track limits, read from race control messages.
// Works the same on the server, in the browser and on replays.
//
// Race control wording (2025–26), for example:
//   FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 55 (SAI) - SPEEDING IN THE PIT LANE (14:03:22)
//   FIA STEWARDS: PENALTY SERVED - 5 SECOND TIME PENALTY FOR CAR 55 (SAI) - ...
//   FIA STEWARDS: DRIVE THROUGH PENALTY FOR CAR 4 (NOR) - ...      STOP-AND-GO PENALTY FOR CAR …
//   FIA STEWARDS: INCIDENT INVOLVING CAR 1 (VER) UNDER INVESTIGATION - ...
//   CAR 22 (TSU) TIME 1:12.345 DELETED - TRACK LIMITS AT TURN 4 LAP 12 14:03:22
//   BLACK AND WHITE FLAG FOR CAR 22 (TSU) - TRACK LIMITS
const carsIn = (msg) => [...msg.matchAll(/\b(\d{1,2}) \(([A-Z]{3})\)/g)].map((m) => m[1]);
const reasonOf = (msg) => (msg.split(/ - /).slice(1).join(" - ").replace(/\s*\(\d{1,2}:\d{2}(:\d{2})?\)\s*$/, "").trim());

function kindOf(msg) {
  const t = msg.match(/(\d+) SECOND TIME PENALTY/);
  if (t) return { kind: "time", secs: Number(t[1]), label: `${t[1]}s` };
  if (/DRIVE THROUGH PENALTY/.test(msg)) return { kind: "drive", secs: 0, label: "Drive-through" };
  if (/STOP-AND-GO|STOP\/GO|STOP AND GO/.test(msg)) {
    const s = msg.match(/(\d+) SECOND STOP/);
    return { kind: "stopgo", secs: 0, label: s ? `${s[1]}s stop-go` : "Stop-go" };
  }
  if (/GRID PENALTY|PLACE GRID/.test(msg)) return { kind: "grid", secs: 0, label: "Grid penalty" };
  return null;
}

// messages: [{ Utc, Lap, Message }] oldest first
export function stewards(messages) {
  const penalties = [];      // { n, kind, secs, label, reason, lap, utc, served }
  const investigations = {}; // key -> { cars, reason, lap, utc, status }
  const trackLimits = {};    // n -> { strikes, flagged, lastLap }
  const warnings = [];       // black & white flags for other reasons, formal warnings
  for (const m of messages) {
    const msg = String(m?.Message ?? "").toUpperCase();
    const lap = Number(m?.Lap) || null, utc = m?.Utc ?? null;
    if (!msg) continue;

    // track limits: each deleted lap time is a strike (3 = black and white flag, 4th = penalty)
    if (/DELETED - TRACK LIMITS/.test(msg)) {
      for (const n of carsIn(msg).slice(0, 1)) { const t = (trackLimits[n] ??= { strikes: 0, flagged: false, lastLap: null }); t.strikes++; t.lastLap = lap; }
      continue;
    }
    if (/BLACK AND WHITE FLAG/.test(msg)) {
      for (const n of carsIn(msg)) {
        if (/TRACK LIMITS/.test(msg)) (trackLimits[n] ??= { strikes: 0, flagged: false, lastLap: null }).flagged = true;
        else warnings.push({ n, reason: reasonOf(msg) || "Black and white flag", lap, utc, flag: true });
      }
      continue;
    }
    if (/FIA STEWARDS: WARNING FOR/.test(msg)) { for (const n of carsIn(msg)) warnings.push({ n, reason: reasonOf(msg), lap, utc, flag: false }); continue; }

    // penalties served
    if (/PENALTY SERVED/.test(msg)) {
      const k = kindOf(msg);
      for (const n of carsIn(msg)) {
        const p = penalties.find((x) => x.n === n && !x.served && (!k || x.kind === k.kind));
        if (p) { p.served = true; p.servedLap = lap; }
      }
      continue;
    }
    // penalties given
    if (/^FIA STEWARDS:/.test(msg) && /PENALTY FOR CAR/.test(msg) && !/NO FURTHER|NOT INVESTIGATED/.test(msg)) {
      const k = kindOf(msg);
      if (k) for (const n of carsIn(msg).slice(0, 1)) {
        // "failing to serve time penalty correctly" replaces the earlier time penalty
        if (/FAILING TO SERVE/.test(msg)) for (const p of penalties) if (p.n === n && !p.served && p.kind === "time") { p.served = true; p.replaced = true; }
        penalties.push({ n, ...k, reason: reasonOf(msg), lap, utc, served: false });
      }
      // a penalty closes the investigation into the same car
      for (const inv of Object.values(investigations)) if (inv.cars.includes(carsIn(msg)[0]) && inv.status !== "closed") inv.status = "penalty";
      continue;
    }
    // investigations
    if (/INCIDENT INVOLVING/.test(msg)) {
      const cars = carsIn(msg);
      const reason = reasonOf(msg);
      const key = `${cars.join(",")}|${reason.replace(/\s*\(\d+(ST|ND|RD|TH) OFFENCE\)/, "")}`;
      const inv = (investigations[key] ??= { cars, reason, lap, utc, status: "noted" });
      if (/UNDER INVESTIGATION/.test(msg)) inv.status = "investigating";
      else if (/AFTER THE RACE/.test(msg)) inv.status = "after the race";
      else if (/NO FURTHER (ACTION|INVESTIGATION)|NOT INVESTIGATED|REVIEWED NO/.test(msg)) inv.status = "closed";
      else if (/NOTED/.test(msg) && inv.status === "noted") inv.status = "noted";
    }
  }
  const open = Object.values(investigations).filter((i) => i.status === "investigating" || i.status === "after the race" || i.status === "noted");
  return { penalties, investigations: Object.values(investigations), open, trackLimits, warnings };
}

// Per-driver summary for the timing table.
export function driverStewarding(st, n) {
  const pend = st.penalties.filter((p) => p.n === n && !p.served);
  return {
    pendingSecs: pend.filter((p) => p.kind === "time").reduce((a, p) => a + p.secs, 0),
    pendingOther: pend.filter((p) => p.kind === "drive" || p.kind === "stopgo").map((p) => p.label),
    tl: st.trackLimits[n]?.strikes ?? 0,
    tlFlag: !!st.trackLimits[n]?.flagged,
    investigating: st.open.some((i) => i.cars.includes(n) && i.status !== "noted"),
  };
}
