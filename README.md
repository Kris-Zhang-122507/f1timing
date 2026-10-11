# Undercut (working title)

F1 live timing that *explains* the race. Unofficial fan project — not associated with Formula 1.

Needs Node.js 18 or newer (`node --version` to check; get it from nodejs.org).

```
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

`npm start` connects to F1's live timing feed, shows it on the page, and records every
message to `recordings/<time>.jsonl` (so you don't also need the old capture script).
Stop it with Ctrl+C.

## Replay a recording

```
npm run replay -- recordings/<your-file>.jsonl --speed 10
```

Works with recordings from `npm start` and from the older `npm run live` capture script.

## What's on the page

- Session, lap count, track status (SC / VSC / red flag), clock, weather
- Lap strip: one block per lap, coloured when a safety car, yellow flag or pit rush happened
- Timing table: gaps, intervals, last/best lap, sector times, minisectors, speed trap, tyres
  (dashed ring = used set), pit stops
- Battles: cars within a second of the car ahead, with closing/dropping-back trend
- What just happened: pit stops, overtakes, fastest laps, safety cars, retirements — detected automatically
- Race control: every FIA message with a plain-English explanation, filterable

## Files

- `server.js` — runs the web page and pushes updates to it (live or replay)
- `f1feed.js` — connects to livetiming.formula1.com
- `state.js` — keeps the full timing state and merges F1's partial updates
- `race.js` — turns raw timing into battles, the race story and race control notes
- `public/` — the web page (`index.html`, `style.css`, `app.js`)
- `capture.js` — the original terminal-only capture script
