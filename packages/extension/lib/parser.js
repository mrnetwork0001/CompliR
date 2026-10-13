/**
 * CompliR extension: pure address parsing helpers. No DOM, no chrome.* - loaded as a classic script in the content
 * script (exposes globalThis.ComplirParser) and required by the vitest unit test (module.exports).
 */
(function (root) {
  "use strict";
  /** Global-flag regex for scanning text; the non-global one validates a single value. */
  var ADDR_G = /0x[0-9a-fA-F]{40}/g;
  var ADDR = /^0x[0-9a-fA-F]{40}$/;
  var TIERS = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" };

  /** Find every 0x address in a string. Returns [{ address (lowercased), raw, index }], word-bounded (not inside a longer hex run). */
  function findAddresses(text) {
    var out = [];
    if (typeof text !== "string" || text.length < 42) return out;
    ADDR_G.lastIndex = 0;
    var m;
    while ((m = ADDR_G.exec(text)) !== null) {
      var start = m.index, end = start + 42;
      var before = start > 0 ? text[start - 1] : "";
      var after = end < text.length ? text[end] : "";
      // reject when embedded in a longer hex string (tx hash, bytes32) or an identifier
      if (/[0-9a-zA-Z_]/.test(before) || /[0-9a-fA-F]/.test(after)) continue;
      out.push({ address: m[0].toLowerCase(), raw: m[0], index: start });
    }
    return out;
  }

  /** Unique lowercase addresses from a list of texts, in first-seen order. */
  function uniqueAddresses(texts) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < texts.length; i++) {
      var found = findAddresses(texts[i]);
      for (var j = 0; j < found.length; j++) {
        var a = found[j].address;
        if (!seen[a]) { seen[a] = true; out.push(a); }
      }
    }
    return out;
  }

  function isAddress(v) { return typeof v === "string" && ADDR.test(v.trim()); }
  function normalize(v) { return isAddress(v) ? v.trim().toLowerCase() : null; }

  /** Attestation response (or 404/none) → chip model. */
  function tierFromResponse(status, body) {
    if (status === 200 && body && TIERS[body.tier]) {
      return { tier: body.tier, score: typeof body.score === "number" ? body.score : null, decisionId: body.decisionId || null, known: true };
    }
    return { tier: "UNKNOWN", score: null, decisionId: null, known: false };
  }

  /** Short label for a chip. */
  function chipLabel(t) {
    if (t.tier === "UNKNOWN") return "?";
    return t.score == null ? t.tier : t.tier + " " + t.score;
  }
  function chipTitle(t, address) {
    if (t.tier === "UNKNOWN") return "CompliR: no verdict stored for " + address + " - click to screen it";
    return "CompliR: " + t.tier + " risk" + (t.score == null ? "" : " (score " + t.score + "/100)") + " - click for the public report";
  }

  /** Cache entries older than ttlMs are stale. */
  function isFresh(entry, now, ttlMs) { return !!entry && typeof entry.at === "number" && now - entry.at < ttlMs; }

  /** Chunk a list into batches of n (fetches are per-address; we cap concurrency). */
  function chunk(list, n) { var out = []; for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }

  var api = { ADDR: ADDR, findAddresses: findAddresses, uniqueAddresses: uniqueAddresses, isAddress: isAddress, normalize: normalize, tierFromResponse: tierFromResponse, chipLabel: chipLabel, chipTitle: chipTitle, isFresh: isFresh, chunk: chunk, CACHE_TTL_MS: 10 * 60 * 1000 };
  root.ComplirParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
