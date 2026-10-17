// RaceLimit Games: a small menu plus three games, one at a time, chosen by the address (#lights,
// #track, #pit) so each game has its own link you can share.
import { mountLights } from "./lights.js?v=mvc4w8sc";
import { mountTrack } from "./track-guess.js?v=mvc4w8sc";
import { mountPit } from "./pitstop.js?v=mvc4w8sc";
import { load } from "./common.js?v=mvc4w8sc";
import { soundButton } from "./sfx.js?v=mvc4w8sc";

const GAMES = {
  lights: { title: "Lights Out", mount: mountLights },
  track: { title: "Guess the Track", mount: mountTrack },
  pit: { title: "Pit Stop Challenge", mount: mountPit },
};

const app = document.getElementById("app");
const crumb = document.getElementById("crumb");
let cleanup = null;

function hub() {
  const lights = load("lights", {});
  const track = load("track.stats", {});
  const pit = load("pit", {});
  const ms = (x) => (x / 1000).toFixed(3) + "s";
  app.innerHTML = `<div class="game">
    <div class="hub-intro"><h1>Games</h1><p class="muted">Three quick F1 games, with a full racing game on the way.</p></div>
    <div class="cards">
      <a class="card-link" href="#lights">
        <div class="card-art"><div class="mini-lights"><i></i><i></i><i></i><i></i><i></i></div></div>
        <h2>Lights Out</h2>
        <p class="muted small">Five red lights. React the moment they go out, and see how you compare with an F1 driver.</p>
        <div class="card-best">${lights.best ? `Your best: <b>${ms(lights.best)}</b>` : "Not played yet"}</div>
      </a>
      <a class="card-link" href="#track">
        <div class="card-art">${trackArt()}</div>
        <h2>Guess the Track <span class="tag">Daily</span></h2>
        <p class="muted small">A circuit is revealed bit by bit. Name it in as few guesses as you can — a new one every day.</p>
        <div class="card-best">${track.played ? `Played <b>${track.played}</b> · streak <b>${track.streak ?? 0}</b>` : "Not played yet"}</div>
      </a>
      <a class="card-link" href="#pit">
        <div class="card-art">${pitArt()}</div>
        <h2>Pit Stop Challenge</h2>
        <p class="muted small">Stop on your marks, change all four tyres, and release the car. Can you beat an F1 crew?</p>
        <div class="card-best">${pit.best ? `Your best: <b>${(pit.best / 1000).toFixed(2)}s</b>` : "Not played yet"}</div>
      </a>
    </div>
    <div class="soon"><span class="tag" style="background:#3A2A0A;color:#F2C14E">Coming</span><div><b>Race the real drivers</b> — a racing game on real circuits, against ghost laps of real drivers from archived races.</div></div>
  </div>`;
}

const trackArt = () => `<svg viewBox="0 0 120 80" width="150" height="100" aria-hidden="true"><path d="M14 58 C10 40 22 28 36 30 C48 32 50 18 64 14 C80 10 98 18 104 32 C110 46 96 50 88 46 C78 42 72 52 80 60 C88 68 70 72 56 68 C40 64 20 74 14 58 Z" fill="none" stroke="#1E2430" stroke-width="5"/><path d="M14 58 C10 40 22 28 36 30 C48 32 50 18 64 14" fill="none" stroke="#FFB547" stroke-width="5" stroke-linecap="round"/></svg>`;
const pitArt = () => `<svg viewBox="0 0 120 80" width="150" height="100" aria-hidden="true"><rect x="22" y="30" width="76" height="20" rx="8" fill="#FFB547"/><rect x="92" y="34" width="14" height="12" rx="3" fill="#FFB547"/><rect x="10" y="32" width="12" height="16" rx="2" fill="#FFB547"/>${[[30, 18], [30, 50], [78, 18], [78, 50]].map(([x, y]) => `<rect x="${x}" y="${y}" width="16" height="12" rx="3" fill="#15171C" stroke="#2FD27A" stroke-width="2"/>`).join("")}</svg>`;

function route() {
  cleanup?.();
  cleanup = null;
  const id = location.hash.slice(1);
  const g = GAMES[id];
  crumb.innerHTML = g ? `/ <a href="#">Games</a> / ${g.title}` : "";
  document.title = g ? `${g.title} — RaceLimit Live` : "Games — RaceLimit Live";
  if (!g) { hub(); return; }
  app.innerHTML = "";
  cleanup = g.mount(app) ?? null;
  window.scrollTo(0, 0);
}
soundButton();
addEventListener("hashchange", route);
route();
