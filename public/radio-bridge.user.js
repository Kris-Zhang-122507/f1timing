// ==UserScript==
// @name         Undercut radio bridge
// @namespace    https://kris-zhang-122507.github.io/f1timing/
// @version      1.0
// @description  Lets Undercut read F1 team radio clips so it can write them out as text, in your browser.
// @match        https://kris-zhang-122507.github.io/f1timing/*
// @match        http://localhost/*
// @grant        GM_xmlhttpRequest
// @connect      livetiming.formula1.com
// @run-at       document-start
// ==/UserScript==
// Websites aren't allowed to read F1's radio files, but a user script you install yourself is.
// This one only fetches F1 team radio .mp3 clips, and only when the Undercut page asks for one.
(function () {
  const CLIP = /^https:\/\/livetiming\.formula1\.com\/static\/[\w\-./%]+\/TeamRadio\/[\w\-.%]+\.mp3$/;
  const reply = (msg) => window.postMessage({ type: "undercut-radio-got", ...msg }, "*");
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.type !== "undercut-radio-get") return;
    const { id, url } = e.data;
    if (!CLIP.test(String(url))) return reply({ id, ok: false, status: 400 });
    GM_xmlhttpRequest({
      method: "GET", url, responseType: "arraybuffer", timeout: 30000,
      onload: (r) => reply({ id, ok: r.status === 200, status: r.status, data: r.status === 200 ? r.response : null }),
      onerror: () => reply({ id, ok: false, status: 0 }),
      ontimeout: () => reply({ id, ok: false, status: 0 }),
    });
  });
  document.documentElement.setAttribute("data-undercut-bridge", "1.0");
})();
