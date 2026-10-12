// Season schedule in your own time zone, from Jolpica (the free Ergast replacement).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let cache = null;
export async function loadSchedule() {
  if (cache) return cache;
  const r = await fetch("https://api.jolpi.ca/ergast/f1/current.json");
  if (!r.ok) throw new Error(`schedule HTTP ${r.status}`);
  const races = (await r.json())?.MRData?.RaceTable?.Races ?? [];
  const when = (x) => (x?.date ? new Date(`${x.date}T${x.time ?? "00:00:00Z"}`) : null);
  cache = races.map((r) => {
    const sessions = [
      ["Practice 1", r.FirstPractice], ["Practice 2", r.SecondPractice], ["Practice 3", r.ThirdPractice],
      ["Sprint Qualifying", r.SprintQualifying ?? r.SprintShootout], ["Sprint", r.Sprint],
      ["Qualifying", r.Qualifying], ["Race", { date: r.date, time: r.time }],
    ].filter(([, x]) => x?.date).map(([name, x]) => ({ name, start: when(x) })).sort((a, b) => a.start - b.start);
    return {
      round: Number(r.round), name: r.raceName, circuit: r.Circuit?.circuitName ?? "",
      locality: r.Circuit?.Location?.locality ?? "", country: r.Circuit?.Location?.country ?? "",
      lat: Number(r.Circuit?.Location?.lat), lon: Number(r.Circuit?.Location?.long), sessions,
    };
  });
  return cache;
}

// The race weekend happening now, or the next one.
export function currentWeekend(races, now = Date.now()) {
  return races.find((r) => r.sessions.length && r.sessions[r.sessions.length - 1].start.getTime() + 3 * 3600e3 > now) ?? races[races.length - 1];
}

const asleep = (d) => { const h = d.getHours(); return h >= 23 || h < 7; };
const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
function countdown(ms) {
  if (ms <= 0) return "now";
  const d = Math.floor(ms / 86400e3), h = Math.floor(ms / 3600e3) % 24, m = Math.floor(ms / 60e3) % 60;
  return d ? `in ${d}d ${h}h` : h ? `in ${h}h ${m}m` : `in ${m}m`;
}

export function renderSchedule(races, now = Date.now()) {
  if (!races?.length) return `<section class="card"><div class="muted small">Couldn't load the schedule.</div></section>`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cur = currentWeekend(races, now);
  const next = cur.sessions.find((s) => s.start.getTime() + 2 * 3600e3 > now);
  const rows = cur.sessions.map((s) => {
    const t = s.start.getTime();
    const status = t + 2 * 3600e3 < now ? `<span class="badge">done · in Replays</span>`
      : t <= now ? `<span class="badge red">LIVE NOW</span>`
      : asleep(s.start) ? `<span class="badge">while you sleep · replay with spoiler shield</span>`
      : `<span class="badge green">live for you</span>`;
    return `<div class="sch-row ${t + 2 * 3600e3 < now ? "past" : ""} ${s === next ? "next" : ""}">
      <div class="sch-name">${esc(s.name)}</div>
      <div class="mono">${fmtDay(s.start)} · ${fmtTime(s.start)}</div>
      <div>${status}</div>
    </div>`;
  }).join("");

  const season = races.map((r) => {
    const last = r.sessions[r.sessions.length - 1]?.start;
    const done = last && last.getTime() + 3 * 3600e3 < now;
    return `<div class="sch-season ${done ? "past" : ""} ${r === cur ? "next" : ""}">
      <span class="mono muted">R${r.round}</span><span>${esc(r.name)}</span><span class="muted small">${last ? fmtDay(last) : ""}</span>
    </div>`;
  }).join("");

  return `<section class="card">
      <div class="card-head"><h2>${esc(cur.name)}</h2><span class="muted small">${esc(cur.circuit)} · times in your zone (${esc(tz)})</span></div>
      ${next ? `<div class="sch-next">Next: <b>${esc(next.name)}</b> ${countdown(next.start.getTime() - now)}</div>` : ""}
      <div class="sch-list">${rows}</div>
    </section>
    <section class="card"><div class="card-head"><h2>${races.length} race weekends this season</h2>
      <div class="filters"><button id="icsAll" title="Every session left this season, with a reminder 15 minutes before">Add to my calendar</button><button id="icsRaces" title="Races and sprints only">Races only</button></div></div>
      <div class="sch-grid">${season}</div>
      <p class="muted small">Downloads a calendar file — open it on your phone or computer, or import it into Google Calendar. Times are set correctly for wherever you are.</p></section>`;
}

// A calendar file (.ics) of the sessions still to come, each with a 15-minute reminder.
export function calendarFile(races, { racesOnly = false, now = Date.now() } = {}) {
  const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const length = { "Race": 120, "Sprint": 60, "Qualifying": 60, "Sprint Qualifying": 45 };
  const events = [];
  for (const r of races) for (const s of r.sessions) {
    if (s.start.getTime() < now - 3 * 3600e3) continue;
    if (racesOnly && !/^(Race|Sprint)$/.test(s.name)) continue;
    const end = new Date(s.start.getTime() + (length[s.name] ?? 60) * 60e3);
    events.push([
      "BEGIN:VEVENT",
      `UID:undercut-${r.round}-${s.name.replace(/\s+/g, "-").toLowerCase()}@undercut`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(s.start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:F1 ${r.name.replace(/ Grand Prix$/, " GP")} — ${s.name}`,
      `LOCATION:${[r.circuit, r.locality, r.country].filter(Boolean).join(", ").replace(/,/g, "\\,")}`,
      "BEGIN:VALARM", "TRIGGER:-PT15M", "ACTION:DISPLAY", `DESCRIPTION:${s.name} starts in 15 minutes`, "END:VALARM",
      "END:VEVENT",
    ].join("\r\n"));
  }
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Undercut//F1 schedule//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:F1 sessions", ...events, "END:VCALENDAR"].join("\r\n") + "\r\n";
}
