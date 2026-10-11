// Car telemetry panel: speed, gear, RPM, throttle and brake for one driver, moving with the replay.
// Data comes straight from OpenF1's car_data (about 4 samples a second), fetched two minutes at
// a time around the replay clock. F1 doesn't share car telemetry for free during live sessions,
// so live it falls back to the speed traps from the timing feed.
const API = "https://api.openf1.org/v1/car_data";
const CHUNK = 120000; // ms of data per request
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class CarTelemetry {
  constructor(box) {
    this.box = box;
    this.cache = new Map();   // `${key}:${n}` -> { rows: [{t, speed, gear, rpm, throttle, brake}], spans: [[a, b]] }
    this.pending = new Set();
    this.error = null;
    this.built = "";
  }

  key(session, n) { return `${session}:${n}`; }

  // make sure we have data around time t for this driver (fetches the next chunk early)
  ensure(session, n, t) {
    const k = this.key(session, n);
    const c = this.cache.get(k) ?? { rows: [], spans: [] };
    this.cache.set(k, c);
    for (const at of [t - 5000, t + CHUNK / 2]) {
      const start = Math.floor(at / CHUNK) * CHUNK;
      if (c.spans.some(([a, b]) => a <= start && b >= start + CHUNK)) continue;
      const id = `${k}:${start}`;
      if (this.pending.has(id)) continue;
      this.pending.add(id);
      const url = `${API}?session_key=${session}&driver_number=${n}&date>=${new Date(start).toISOString()}&date<=${new Date(start + CHUNK).toISOString()}`;
      fetch(url).then((r) => {
        if (r.status === 401) throw new Error("OpenF1 is busy with a live session right now — telemetry comes back about 30 minutes after it ends.");
        if (r.status === 429) throw new Error("Too many requests — trying again in a moment.");
        if (!r.ok) throw new Error(`OpenF1 answered ${r.status}`);
        return r.json();
      }).then((rows) => {
        for (const x of rows) c.rows.push({ t: Date.parse(x.date), speed: x.speed ?? 0, gear: x.n_gear ?? 0, rpm: x.rpm ?? 0, throttle: x.throttle ?? 0, brake: x.brake ? 100 : 0 });
        c.rows.sort((a, b) => a.t - b.t);
        c.spans.push([start, start + CHUNK]);
        this.error = null;
      }).catch((e) => {
        this.error = e.message === "Failed to fetch" ? "Couldn't reach OpenF1 for telemetry." : e.message;
        setTimeout(() => this.pending.delete(id), 8000); // allow a retry
        return;
      }).finally(() => { if (!this.error) this.pending.delete(id); });
    }
    // keep memory in check: drop data far from now
    if (c.rows.length > 4000) { c.rows = c.rows.filter((r) => Math.abs(r.t - t) < 6 * 60000); c.spans = c.spans.filter(([a, b]) => b > t - 6 * 60000 && a < t + 6 * 60000); }
  }

  sample(session, n, t) {
    const rows = this.cache.get(this.key(session, n))?.rows;
    if (!rows?.length) return null;
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rows[mid].t <= t) lo = mid; else hi = mid - 1; }
    const a = rows[lo], b = rows[lo + 1];
    if (!a || a.t > t || t - a.t > 3000) return null;
    if (!b || b.t - a.t > 3000) return a;
    const k = (t - a.t) / (b.t - a.t);
    const mix = (x, y) => x + (y - x) * k;
    return { speed: mix(a.speed, b.speed), rpm: mix(a.rpm, b.rpm), throttle: mix(a.throttle, b.throttle), brake: k < 0.5 ? a.brake : b.brake, gear: k < 0.5 ? a.gear : b.gear,
      trace: rows.filter((r) => r.t > t - 20000 && r.t <= t).map((r) => [r.t - t, r.speed]) };
  }

  // drivers: [{ n, tla, colour, name, speed (trap), bestSpeeds }]
  render({ drivers, sel, session, t, live }) {
    const me = drivers.find((d) => d.n === sel) ?? drivers[0];
    const opts = drivers.map((d) => `<option value="${esc(d.n)}" ${d === me ? "selected" : ""}>${esc(d.tla)} — ${esc(d.name)}</option>`).join("");
    const shape = `${opts.length}|${me?.n}|${live}`;
    if (shape !== this.built) {
      this.built = shape;
      this.box.innerHTML = `<div class="tele">
        <label class="muted small tele-pick">Driver <select id="teleSel">${opts}</select></label>
        <div class="tele-main">
          <div class="tele-speed"><span class="mono" id="tSpeed">–</span><span class="muted small">km/h</span></div>
          <div class="tele-gear"><span class="muted small">Gear</span><span class="mono" id="tGear">–</span></div>
        </div>
        <div class="tele-bars">
          <div><span class="muted small">Throttle</span><div class="tbar"><i id="tThr" class="thr"></i></div></div>
          <div><span class="muted small">Brake</span><div class="tbar"><i id="tBrk" class="brk"></i></div></div>
          <div><span class="muted small">RPM <span class="mono" id="tRpmN"></span></span><div class="tbar"><i id="tRpm" class="rpm"></i></div></div>
        </div>
        <svg class="tele-trace" viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="Speed over the last 20 seconds"><polyline id="tTrace" fill="none" stroke-width="2"></polyline></svg>
        <div class="muted small" id="tNote"></div>
      </div>`;
    }
    if (!me) return;
    const $ = (id) => this.box.querySelector(`#${id}`);
    $("tTrace").setAttribute("stroke", me.colour);
    const set = (s) => {
      $("tSpeed").textContent = s ? Math.round(s.speed) : "–";
      $("tGear").textContent = s ? (s.gear || "N") : "–";
      $("tThr").style.width = `${s ? Math.max(0, Math.min(100, s.throttle)) : 0}%`;
      $("tBrk").style.width = `${s ? s.brake : 0}%`;
      $("tRpm").style.width = `${s ? Math.min(100, (s.rpm / 13000) * 100) : 0}%`;
      $("tRpmN").textContent = s?.rpm ? Math.round(s.rpm).toLocaleString() : "";
      $("tTrace").setAttribute("points", s?.trace?.length ? s.trace.map(([dt, v]) => `${(300 + (dt / 20000) * 300).toFixed(1)},${(58 - (v / 360) * 56).toFixed(1)}`).join(" ") : "");
    };
    if (live || !session) {
      set(null);
      $("tSpeed").textContent = me.speed || "–";
      $("tNote").textContent = live
        ? `Live: speed at the last speed trap. F1 doesn't share live gear, throttle or RPM for free — they show here in replays of archived races.`
        : "Watch an archived race from Replays to see this driver's speed, gear, throttle, brake and RPM.";
      return;
    }
    this.ensure(session, me.n, t);
    const s = this.sample(session, me.n, t);
    set(s);
    $("tNote").textContent = this.error ?? (s ? "From OpenF1 car data, about 4 readings a second." : "Loading car data…");
  }
}
