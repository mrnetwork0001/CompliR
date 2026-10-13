/**
 * CompliR content script: finds EVM addresses in page text, asks the service worker for their tier, and injects a
 * small chip after each one (shadow DOM, our tier colours). Watches inputs for a pasted/typed address and shows a
 * top banner when it is HIGH. Skips wallet-extension pages (cannot be injected anyway) and the CompliR host itself.
 */
(function () {
  "use strict";
  const P = globalThis.ComplirParser;
  if (!P || window.top !== window) return;
  const ATTR = "data-complir";
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "COMPLIR-CHIP", "COMPLIR-BANNER"]);
  const COLORS = { LOW: "#4ade80", MEDIUM: "#fbbf24", HIGH: "#f87171", UNKNOWN: "#9ba1a9" };
  const DEBOUNCE_MS = 400;
  const seenNodes = new WeakSet();
  const pending = new Map(); // address → chip elements waiting for a tier
  const known = new Map(); // address → tier object
  let base = null;
  let timer = null;
  let bannerFor = null;
  let bannerEl = null;

  chrome.runtime.sendMessage({ type: "base-url" }, (r) => {
    base = (r && r.url) || null;
    try { if (base && new URL(base).origin === location.origin) return; } catch { /* ignore */ }
    scan();
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, DEBOUNCE_MS); });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onInput, true);
    for (const el of document.querySelectorAll("input")) guard(el);
  });

  function reportUrl(address) { return (base || "https://complir.example") + "/a/" + address; }

  // ── chip ──
  function makeChip(address) {
    const host = document.createElement("complir-chip");
    host.setAttribute(ATTR, address);
    const root = host.attachShadow({ mode: "closed" });
    const a = document.createElement("a");
    a.href = reportUrl(address); a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = "…"; a.title = "CompliR: checking " + address;
    a.part = "chip";
    const style = document.createElement("style");
    style.textContent = `
      :host{display:inline-block;vertical-align:baseline;margin-left:4px;line-height:1}
      a{display:inline-block;font:500 9.5px/1 ui-monospace,"Geist Mono",Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;
        padding:2px 5px;border:1px solid #9ba1a9;border-radius:2px;color:#9ba1a9;text-decoration:none;white-space:nowrap;background:transparent;opacity:.9}
      a:hover{opacity:1}`;
    root.append(style, a);
    host._a = a;
    return host;
  }
  function paint(host, t) {
    const a = host._a; if (!a) return;
    const c = COLORS[t.tier] || COLORS.UNKNOWN;
    a.textContent = P.chipLabel(t);
    a.title = P.chipTitle(t, host.getAttribute(ATTR));
    a.style.color = c; a.style.borderColor = c;
    if (t.tier === "HIGH") a.style.background = "rgba(248,113,113,.12)";
  }

  // ── scan text nodes ──
  function scan() {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (seenNodes.has(n) || n.nodeValue.length < 42 || n.nodeValue.indexOf("0x") < 0) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName) || p.closest("complir-chip,complir-banner,[contenteditable=''],[contenteditable='true']")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    const batch = new Set();
    for (const n of nodes) {
      seenNodes.add(n);
      const found = P.findAddresses(n.nodeValue);
      if (!found.length) continue;
      // split from the end so earlier indices stay valid
      let node = n;
      for (let i = found.length - 1; i >= 0; i--) {
        const f = found[i];
        const tail = node.splitText(f.index + 42);
        seenNodes.add(tail);
        const chip = makeChip(f.address);
        node.parentNode.insertBefore(chip, tail);
        if (known.has(f.address)) paint(chip, known.get(f.address));
        else { if (!pending.has(f.address)) pending.set(f.address, []); pending.get(f.address).push(chip); batch.add(f.address); }
      }
    }
    if (batch.size) resolve([...batch]);
  }

  function resolve(addresses, cb) {
    chrome.runtime.sendMessage({ type: "lookup", addresses }, (r) => {
      const tiers = (r && r.tiers) || {};
      for (const a of addresses) {
        const t = tiers[a] || { tier: "UNKNOWN", score: null, known: false };
        if (!t.error) known.set(a, t);
        for (const chip of pending.get(a) || []) paint(chip, t);
        pending.delete(a);
      }
      if (cb) cb(tiers);
    });
  }

  // ── send guard ──
  function onInput(e) { const el = e.target; if (el && el.tagName === "INPUT") guard(el); }
  function guard(el) {
    const addr = P.normalize(el.value || "");
    if (!addr) { if (bannerFor && el.getAttribute(ATTR + "-guard") === bannerFor) hideBanner(); return; }
    el.setAttribute(ATTR + "-guard", addr);
    const show = (t) => { if (t && t.tier === "HIGH") showBanner(addr); else if (bannerFor === addr) hideBanner(); };
    if (known.has(addr)) show(known.get(addr));
    else resolve([addr], (tiers) => show(tiers[addr]));
  }
  function showBanner(addr) {
    if (bannerFor === addr) return;
    hideBanner();
    bannerFor = addr;
    const host = document.createElement("complir-banner");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host{all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;display:block}
      .b{display:flex;gap:14px;align-items:center;justify-content:center;flex-wrap:wrap;padding:10px 16px;background:#0a0b0d;color:#ecedee;
         border-bottom:2px solid #f87171;font:500 13px/1.4 -apple-system,Segoe UI,Geist,sans-serif}
      .k{font:500 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#f87171}
      code{font:12px ui-monospace,Menlo,monospace;color:#9ba1a9}
      a{color:#3fe0c8;text-decoration:none;border-bottom:1px solid #3fe0c866}
      button{all:unset;cursor:pointer;color:#9ba1a9;font:11px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;padding:3px 7px;border:1px solid #ecedee26;border-radius:2px}`;
    const b = document.createElement("div"); b.className = "b";
    b.innerHTML = `<span class="k">CompliR · HIGH</span><span>This address is sanctioned/blocklisted. Don't send.</span><code></code><a target="_blank" rel="noopener noreferrer">See why</a><button type="button">Dismiss</button>`;
    b.querySelector("code").textContent = addr;
    b.querySelector("a").href = reportUrl(addr);
    b.querySelector("button").addEventListener("click", hideBanner);
    root.append(style, b);
    document.documentElement.appendChild(host);
    bannerEl = host;
  }
  function hideBanner() { if (bannerEl) bannerEl.remove(); bannerEl = null; bannerFor = null; }
})();
