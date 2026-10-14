# CompliR browser extension

Manifest V3, Chrome / Brave / Edge. Plain JavaScript, no build step, no dependencies.

What it does

- **Tier chips.** The content script finds EVM addresses (`0x` + 40 hex) in page text, asks the CompliR host for the latest
  attestation (`GET /api/v1/attestation/<addr>`, free) and injects a small chip after each one: LOW green, MEDIUM amber, HIGH red,
  unknown grey. The chip links to `<host>/a/<addr>`. Verdicts are cached in `chrome.storage.local` for 10 minutes.
- **Send guard.** When an `<input>` on any page holds an address that is HIGH, a top banner says
  "CompliR: this address is sanctioned/blocklisted. Don't send." with a link to the report. Wallet extension popups
  (MetaMask, Rabby, ...) cannot be injected by other extensions, so the guard covers dapp pages and web wallets only.
- **Popup.** Flagged addresses on the current tab, a "Check an address" field (opens `/a/<addr>`), and the CompliR host setting.

Load unpacked

1. `node packages/extension/scripts/zip.mjs` (writes `packages/extension/dist/complir-extension.zip` and regenerates the icons),
   or download the zip from `/tools` on a CompliR host. Unzip it.
2. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`) and switch on **Developer mode**.
3. **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
4. Click the toolbar icon, set the CompliR host (default `https://trycomplir.xyz`; `http://localhost:3000` for a dev server), Save.

Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: `storage`, `activeTab`, host permissions for the CompliR host |
| `lib/parser.js` | pure address parsing + chip model; also the unit-test target (`packages/extension/parser.test.ts`) |
| `content.js` | text-node scan, debounced MutationObserver, shadow-DOM chips, input guard + banner |
| `background.js` | service worker: the only network caller; cache; per-tab results for the popup |
| `popup.html` / `popup.js` | popup UI |
| `scripts/icons.mjs` | writes `icons/icon{16,48,128}.png` (raw PNG via node:zlib) |
| `scripts/zip.mjs` | dependency-free zip writer; `node scripts/zip.mjs public/downloads/complir-extension.zip` publishes it |

Notes

- `host_permissions` includes `https://*/*` so any CompliR host works after you set it in the popup; tighten it to your host before publishing.
- The attestation endpoint runs a fresh screen when it has never seen an address, so a first chip can take a few seconds.
