// Small helpers shared by the games: scores saved in this browser (never required to work).
const PREFIX = "racelimit.games.";
export function load(key, fallback) {
  try { const v = localStorage.getItem(PREFIX + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* private mode: just don't remember */ }
}
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// share text: the phone's share sheet if there is one, otherwise copy it
export async function share(text, button) {
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    if (button) { const t = button.textContent; button.textContent = "Copied!"; setTimeout(() => { button.textContent = t; }, 1500); }
  } catch { /* cancelled */ }
}
