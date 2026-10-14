/**
 * CompliR extension service worker: the only place that talks to the CompliR host (host permissions live here, so the
 * content script never fights page CORS). Caches verdicts in chrome.storage.local for 10 minutes and remembers the
 * flagged addresses per tab for the popup.
 */
importScripts("lib/parser.js");
const P = self.ComplirParser;
const DEFAULT_URL = "https://trycomplir.xyz";
const FETCH_TIMEOUT_MS = 12000;
const CONCURRENCY = 4;

async function baseUrl() {
  const { complirUrl } = await chrome.storage.local.get("complirUrl");
  const u = (complirUrl || DEFAULT_URL).trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(u) ? u : DEFAULT_URL;
}

async function readCache(addresses) {
  const keys = addresses.map((a) => "att:" + a);
  const got = await chrome.storage.local.get(keys);
  const now = Date.now(), hit = {}, miss = [];
  for (const a of addresses) {
    const e = got["att:" + a];
    if (P.isFresh(e, now, P.CACHE_TTL_MS)) hit[a] = e.tier; else miss.push(a);
  }
  return { hit, miss };
}

async function fetchTier(base, address) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/api/v1/attestation/${address}`, { signal: ctl.signal, headers: { Accept: "application/json" } });
    let body = null;
    try { body = await r.json(); } catch { /* not json */ }
    return P.tierFromResponse(r.status, body);
  } catch {
    return { tier: "UNKNOWN", score: null, decisionId: null, known: false, error: true };
  } finally { clearTimeout(t); }
}

/** addresses → { [address]: {tier, score, decisionId, known} } */
async function lookup(addresses) {
  const list = [...new Set(addresses.filter(P.isAddress).map((a) => a.toLowerCase()))].slice(0, 200);
  const { hit, miss } = await readCache(list);
  const out = { ...hit };
  if (miss.length) {
    const base = await baseUrl();
    const toStore = {};
    for (const batch of P.chunk(miss, CONCURRENCY)) {
      const results = await Promise.all(batch.map((a) => fetchTier(base, a)));
      batch.forEach((a, i) => {
        out[a] = results[i];
        if (!results[i].error) toStore["att:" + a] = { at: Date.now(), tier: results[i] };
      });
    }
    if (Object.keys(toStore).length) await chrome.storage.local.set(toStore);
  }
  return out;
}

const tabResults = new Map(); // tabId → { url, addresses: {addr: tier} }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === "lookup") {
      const tiers = await lookup(msg.addresses || []);
      if (sender.tab && sender.tab.id != null) {
        const prev = tabResults.get(sender.tab.id) || { url: sender.tab.url, addresses: {} };
        Object.assign(prev.addresses, tiers);
        prev.url = sender.tab.url;
        tabResults.set(sender.tab.id, prev);
      }
      sendResponse({ tiers });
    } else if (msg && msg.type === "tab-results") {
      sendResponse(tabResults.get(msg.tabId) || { addresses: {} });
    } else if (msg && msg.type === "base-url") {
      sendResponse({ url: await baseUrl() });
    } else {
      sendResponse({ error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

chrome.tabs.onRemoved.addListener((tabId) => tabResults.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === "loading") tabResults.delete(tabId); });
