// The Live dashboard: every panel can be moved (drag its title bar), resized (drag any edge or
// corner) and closed. Layouts are remembered in this browser; presets are a starting point.
// Uses gridstack (vendor/gridstack, MIT) for the grid itself.
const $ = (id) => document.getElementById(id);

// 24 columns so panels can be sized finely; rows are 20px.
const COLS = 24;
const PRESETS = {
  race: { name: "Race", panels: [
    { id: "timing", x: 0, y: 0, w: 13, h: 34 },
    { id: "track", x: 13, y: 0, w: 11, h: 18 },
    { id: "rcm", x: 13, y: 18, w: 6, h: 16 },
    { id: "story", x: 19, y: 18, w: 5, h: 16 },
    { id: "pitwin", x: 0, y: 34, w: 7, h: 22 },
    { id: "stewards", x: 7, y: 34, w: 6, h: 22 },
    { id: "circle", x: 13, y: 34, w: 6, h: 22 },
    { id: "battles", x: 19, y: 34, w: 5, h: 22 },
    { id: "car", x: 0, y: 56, w: 7, h: 20 },
    { id: "radio", x: 7, y: 56, w: 6, h: 20 },
    { id: "weather", x: 13, y: 56, w: 6, h: 12 },
  ] },
  quali: { name: "Qualifying", panels: [
    { id: "timing", x: 0, y: 0, w: 15, h: 36 },
    { id: "track", x: 15, y: 0, w: 9, h: 16 },
    { id: "rcm", x: 15, y: 16, w: 9, h: 20 },
    { id: "stewards", x: 0, y: 36, w: 8, h: 18 },
    { id: "radio", x: 8, y: 36, w: 8, h: 18 },
    { id: "story", x: 16, y: 36, w: 8, h: 18 },
    { id: "weather", x: 16, y: 54, w: 8, h: 10 },
  ] },
  strategy: { name: "Strategy", panels: [
    { id: "timing", x: 0, y: 0, w: 12, h: 34 },
    { id: "circle", x: 12, y: 0, w: 12, h: 34 },
    { id: "tyres", x: 0, y: 34, w: 12, h: 26 },
    { id: "pitwin", x: 12, y: 60, w: 12, h: 20 },
    { id: "car", x: 0, y: 60, w: 8, h: 20 },
    { id: "strategy", x: 12, y: 34, w: 12, h: 26 },
  ] },
  maps: { name: "Track + circle", panels: [
    { id: "track", x: 0, y: 0, w: 12, h: 30 },
    { id: "circle", x: 12, y: 0, w: 12, h: 30 },
    { id: "timing", x: 0, y: 30, w: 16, h: 30 },
    { id: "rcm", x: 16, y: 30, w: 8, h: 30 },
  ] },
};
const KEY = "undercut.layout.v1";
const SAVED = "undercut.layouts"; // your named layouts: { name: [{ id, x, y, w, h }] }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class Dashboard {
  constructor({ onChange }) {
    this.onChange = onChange;  // called with the set of panel ids on the dashboard
    this.pool = $("widgetPool");
    this.panels = [...this.pool.querySelectorAll("section.w")].map((el) => ({ id: el.id.slice(2), el, title: el.dataset.title, page: el.dataset.page || null }));
    this.grid = window.GridStack.init({
      column: COLS, cellHeight: 20, margin: 2, float: false, animate: false,
      draggable: { handle: ".w-head", cancel: "button,input,select,label,a,summary,.filters,.legend,.w-close" },
      resizable: { handles: "e,s,w,se,sw" },
      columnOpts: { columnMax: COLS, breakpoints: [{ w: 760, c: 1 }] },
    }, $("tab-overview"));
    this.grid.on("change added removed resizestop", () => this.save());
    for (const p of this.panels) this.decorate(p);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch {}
    this.apply(Array.isArray(saved) && saved.length ? saved : PRESETS.race.panels);
    this.locked = false;
    try { if (localStorage.getItem(KEY + ".locked") === "1") this.setLocked(true); } catch {}
    this.buildMenus();
  }

  // close button on every panel
  decorate(p) {
    const head = p.el.querySelector(".w-head");
    const x = document.createElement("button");
    x.className = "w-close"; x.type = "button"; x.title = `Close ${p.title}`; x.setAttribute("aria-label", `Close ${p.title}`);
    x.textContent = "×";
    x.addEventListener("click", () => this.remove(p.id));
    head.appendChild(x);
  }

  has(id) { return !!this.panels.find((p) => p.id === id)?.item; }

  apply(layout) {
    this.grid.batchUpdate();
    for (const p of this.panels) if (p.item) this.detach(p);
    for (const l of layout) {
      const p = this.panels.find((x) => x.id === l.id);
      if (p) this.attach(p, l);
    }
    this.grid.batchUpdate(false);
    this.changed();
  }

  attach(p, pos = {}) {
    const item = document.createElement("div");
    item.className = "grid-stack-item";
    item.setAttribute("gs-id", p.id);
    const content = document.createElement("div");
    content.className = "grid-stack-item-content";
    item.appendChild(content);
    content.appendChild(p.el);
    // panels that are also pages (Strategy, My driver, Rewind) borrow that page's content
    if (p.page) p.el.querySelector(`[data-slot="${p.page}"]`).appendChild($(`tab-${p.page}`));
    this.grid.el.appendChild(item);
    this.grid.makeWidget(item, { x: pos.x, y: pos.y, w: pos.w ?? 8, h: pos.h ?? 14, minW: 3, minH: 4, id: p.id, autoPosition: pos.x == null });
    p.item = item;
  }

  detach(p) {
    if (p.page) { const page = $(`tab-${p.page}`); $("tab-overview").before(page); }
    this.pool.appendChild(p.el);
    this.grid.removeWidget(p.item, true, false);
    p.item = null;
  }

  add(id) {
    const p = this.panels.find((x) => x.id === id);
    if (!p || p.item) return;
    this.attach(p, { w: id === "timing" ? 13 : 8, h: id === "timing" ? 30 : 16 });
    this.changed();
    p.item.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  remove(id) {
    const p = this.panels.find((x) => x.id === id);
    if (!p?.item) return;
    this.detach(p);
    this.changed();
  }

  save() {
    if (this.grid.getColumn() !== COLS) return; // phone layout is automatic; don't overwrite the desktop one
    const layout = this.panels.filter((p) => p.item).map((p) => {
      const n = p.item.gridstackNode;
      return { id: p.id, x: n.x, y: n.y, w: n.w, h: n.h };
    });
    try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch {}
  }

  changed() {
    this.save();
    this.buildMenus();
    this.onChange?.(new Set(this.panels.filter((p) => p.item).map((p) => p.id)));
    // let SVGs re-measure after sizes settle
    window.dispatchEvent(new Event("resize"));
  }

  setLocked(on) {
    this.locked = on;
    this.grid.setStatic(on);
    document.body.classList.toggle("dash-locked", on);
    $("lockBtn").setAttribute("aria-pressed", String(on));
    $("lockBtn").textContent = on ? "Unlock" : "Lock";
    try { localStorage.setItem(KEY + ".locked", on ? "1" : "0"); } catch {}
  }

  buildMenus() {
    const closed = this.panels.filter((p) => !p.item);
    $("addList").innerHTML = closed.length
      ? closed.map((p) => `<button type="button" data-add="${p.id}">${p.title}</button>`).join("")
      : `<div class="muted small menu-note">Every panel is already on the page.</div>`;
    const mine = this.savedLayouts();
    const names = Object.keys(mine);
    $("layoutList").innerHTML = `<form class="menu-save" id="saveLayout">
        <label class="sr" for="layoutName">Name for this layout</label>
        <input id="layoutName" maxlength="30" placeholder="Name this layout" autocomplete="off">
        <button type="submit">Save</button>
      </form>`
      + (names.length ? `<div class="menu-label muted small">Your layouts</div>${names.map((n) => `<div class="menu-row"><button type="button" data-mine="${esc(n)}">${esc(n)}</button><button type="button" class="menu-x" data-del="${esc(n)}" aria-label="Delete ${esc(n)}" title="Delete">×</button></div>`).join("")}` : "")
      + `<div class="menu-label muted small">Starting points</div>`
      + Object.entries(PRESETS).map(([k, v]) => `<button type="button" data-preset="${k}">${v.name}</button>`).join("")
      + `<div class="menu-note muted small">Drag a title bar to move a panel, any edge to resize it. Changes are kept automatically in this browser; saving a layout lets you switch back to it later.</div>`;
  }

  savedLayouts() {
    try { return JSON.parse(localStorage.getItem(SAVED)) || {}; } catch { return {}; }
  }
  current() {
    return this.panels.filter((p) => p.item).map((p) => { const n = p.item.gridstackNode; return { id: p.id, x: n.x, y: n.y, w: n.w, h: n.h }; });
  }

  wireControls() {
    $("layoutList").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("layoutName").value.trim();
      if (!name) { $("layoutName").focus(); return; }
      const all = this.savedLayouts();
      all[name] = this.current();
      try { localStorage.setItem(SAVED, JSON.stringify(all)); } catch {}
      this.buildMenus();
      $("layoutMenu").open = true;
    });
    $("addList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-add]");
      if (!b) return;
      this.add(b.dataset.add);
      $("addMenu").open = false;
    });
    $("layoutList").addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        const all = this.savedLayouts();
        delete all[del.dataset.del];
        try { localStorage.setItem(SAVED, JSON.stringify(all)); } catch {}
        this.buildMenus();
        return;
      }
      const mine = e.target.closest("[data-mine]");
      if (mine) { this.apply(this.savedLayouts()[mine.dataset.mine] ?? []); $("layoutMenu").open = false; return; }
      const b = e.target.closest("[data-preset]");
      if (!b) return;
      this.apply(PRESETS[b.dataset.preset].panels);
      $("layoutMenu").open = false;
    });
    $("lockBtn").addEventListener("click", () => this.setLocked(!this.locked));
    $("fullBtn").addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    });
    document.addEventListener("fullscreenchange", () => { $("fullBtn").textContent = document.fullscreenElement ? "Exit full screen" : "Full screen"; });
    // close a menu when clicking elsewhere
    document.addEventListener("click", (e) => {
      for (const m of [$("addMenu"), $("layoutMenu")]) if (m.open && !m.contains(e.target)) m.open = false;
    });
  }
}
