/** CompliR popup: flagged addresses on the current tab, quick check, host setting. */
(async function () {
  const P = globalThis.ComplirParser;
  const DEFAULT_URL = "https://complir.example";
  const $ = (id) => document.getElementById(id);
  const { complirUrl } = await chrome.storage.local.get("complirUrl");
  const base = (complirUrl || DEFAULT_URL).replace(/\/+$/, "");
  $("url").value = base;
  $("hostA").textContent = base;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    chrome.runtime.sendMessage({ type: "tab-results", tabId: tab.id }, (r) => {
      const entries = Object.entries((r && r.addresses) || {}).sort((a, b) => rank(b[1]) - rank(a[1]));
      if (!entries.length) return;
      $("empty").hidden = true;
      for (const [addr, t] of entries) {
        const li = document.createElement("li");
        const badge = document.createElement("span"); badge.className = "badge " + (t.tier || "UNKNOWN"); badge.textContent = P.chipLabel(t);
        const code = document.createElement("code"); code.textContent = addr; code.title = addr;
        const a = document.createElement("a"); a.href = base + "/a/" + addr; a.target = "_blank"; a.textContent = "report";
        li.append(badge, code, a);
        $("list").appendChild(li);
      }
    });
  }
  function rank(t) { return { HIGH: 3, MEDIUM: 2, LOW: 1 }[t && t.tier] || 0; }

  $("check").addEventListener("submit", (e) => {
    e.preventDefault();
    const a = P.normalize($("addr").value);
    if (!a) { $("addr").focus(); return; }
    chrome.tabs.create({ url: base + "/a/" + a });
  });
  $("settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    let u = $("url").value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(u)) u = DEFAULT_URL;
    await chrome.storage.local.set({ complirUrl: u });
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("att:")));
    $("url").value = u; $("hostA").textContent = u;
  });
})();
