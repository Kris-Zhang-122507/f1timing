// Keeps a copy of the whole live-timing state and applies the feed's partial updates.
// F1 sends a full snapshot once, then only the bits that changed ("deltas").
// This file runs both in Node (server.js) and in the browser (GitHub Pages version).

// Topics ending in .z arrive as base64-encoded, raw-deflate-compressed JSON.
// `inflate(base64) -> string` is passed in by Node; the browser skips these topics.
export function decode(topic, data, inflate) {
  if (topic.endsWith(".z")) {
    if (!inflate || typeof data !== "string") return null;
    return { topic: topic.slice(0, -2), data: JSON.parse(inflate(data)) };
  }
  return { topic, data };
}

// Deep-merge an update into the existing state.
// Quirk: F1 often updates arrays by sending an object keyed by index, e.g.
// { Sectors: { "1": { Value: "28.1" } } } means "change Sectors[1]".
export function merge(target, update) {
  if (update === null || typeof update !== "object") return update;
  if (Array.isArray(update)) return update.slice();

  if (Array.isArray(target)) {
    const out = target.slice();
    for (const [k, v] of Object.entries(update)) {
      const i = Number(k);
      if (Number.isInteger(i)) out[i] = merge(out[i], v);
    }
    return out;
  }

  const out = target && typeof target === "object" ? { ...target } : {};
  for (const [k, v] of Object.entries(update)) {
    if (k === "_deleted") {
      for (const key of v) delete out[key];
      continue;
    }
    out[k] = merge(out[k], v);
  }
  return out;
}

export class LiveState {
  constructor({ inflate } = {}) {
    this.inflate = inflate;
    this.data = {};
    this.messages = 0;
    this.lastMessageAt = null;
  }

  applySnapshot(snapshot) {
    for (const [rawTopic, rawData] of Object.entries(snapshot || {})) {
      this.apply(rawTopic, rawData);
    }
  }

  apply(rawTopic, rawData) {
    const decoded = decode(rawTopic, rawData, this.inflate);
    if (!decoded) return;
    const { topic, data } = decoded;
    // Event-like topics: keep a running list instead of merging.
    if (topic === "RaceControlMessages" || topic === "TeamRadio") {
      const key = topic === "TeamRadio" ? "Captures" : "Messages";
      const prev = this.data[topic]?.[key] ?? [];
      const incoming = data?.[key];
      // a full list (sent when you connect or reconnect) replaces what we had;
      // a single new message arrives as { "<index>": message } and is added on
      this.data[topic] = Array.isArray(incoming) ? { [key]: [...incoming] } : { [key]: [...prev, ...Object.values(incoming ?? {})] };
    } else {
      this.data[topic] = merge(this.data[topic], data);
    }
    this.messages++;
    this.lastMessageAt = Date.now();
  }

  // A simple, sorted list of drivers for display.
  leaderboard() {
    const lines = this.data.TimingData?.Lines ?? {};
    const drivers = this.data.DriverList ?? {};
    const stints = this.data.TimingAppData?.Lines ?? {};
    return Object.entries(lines)
      .map(([num, l]) => {
        const d = drivers[num] ?? {};
        const driverStints = stints[num]?.Stints;
        const stintList = Array.isArray(driverStints)
          ? driverStints
          : Object.values(driverStints ?? {});
        const stint = stintList[stintList.length - 1];
        return {
          num,
          pos: Number(l.Position) || 99,
          tla: d.Tla ?? num,
          colour: d.TeamColour ?? "888888",
          gap: l.GapToLeader ?? l.Stats?.[0]?.TimeDiffToFastest ?? "",
          interval: l.IntervalToPositionAhead?.Value ?? "",
          last: l.LastLapTime?.Value ?? "",
          best: l.BestLapTime?.Value ?? "",
          laps: l.NumberOfLaps ?? "",
          pit: !!l.InPit,
          pitStops: l.NumberOfPitStops ?? 0,
          out: !!(l.Retired || l.Stopped),
          tyre: stint?.Compound ?? "",
          tyreAge: stint?.TotalLaps ?? "",
        };
      })
      .sort((a, b) => a.pos - b.pos);
  }
}
