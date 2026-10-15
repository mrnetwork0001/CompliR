// Records the real CompliR web app for the demo film, against the live production site.
//   node scripts/capture.mjs                    (BASE defaults to https://trycomplir.xyz)
//   ONLY=check,address node scripts/capture.mjs re-records just those clips (marks/meta are merged)
// Output: .cache/frames/<clip>/ (JPEG screencast + frames.json), .cache/marks.json (event times),
// .cache/meta.json (per clip: element rects in CSS px, device scale) and stills in public/stills/.
// scripts/encode.mjs turns the frames into public/footage/<clip>.mp4 (30 fps).
//
// The window is 1600x900 CSS px at device scale 2: frames are 3200x1800 and a rect {x,y,w,h}
// in CSS px maps to video pixels by multiplying by 2. The site is forced to its dark theme.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const BASE = process.env.BASE || "https://trycomplir.xyz";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FRAMES = join(ROOT, ".cache/frames");
const STILLS = join(ROOT, "public/stills");
const SCALE = 2;
const VIEW = { w: 1600, h: 900 };
const RONIN = "0x098b716b8aaf21512996dc57eb0615e2383e2f96";
const ONLY = process.env.ONLY?.split(",");
const want = (clip) => !ONLY || ONLY.includes(clip);
mkdirSync(FRAMES, { recursive: true });
mkdirSync(STILLS, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s`, ...a);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const marks = readJson(join(ROOT, ".cache/marks.json"));
const meta = readJson(join(ROOT, ".cache/meta.json"));
const mark = (k) => { marks[k] = Date.now() / 1000; log("mark", k); };

// Dark theme before first paint, a visible pointer (headless Chrome draws none), a click ring,
// an eased scroll helper, and dev overlays hidden.
const OVERLAY = `(() => {
  try { localStorage.setItem('complir.theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark'); } catch (e) {}
  window.__ease = (el, prop, to, ms) => new Promise((done) => {
    const from = el[prop]; const start = performance.now();
    const f = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => { const p = Math.min(1, (now - start) / ms); el[prop] = from + (to - from) * f(p); if (p < 1) requestAnimationFrame(step); else done(el[prop]); };
    requestAnimationFrame(step);
  });
  const add = () => {
    if (document.getElementById('__cur')) return;
    const s = document.createElement('style'); s.id = '__curcss';
    s.textContent = 'nextjs-portal,#__next-build-watcher{display:none!important}#__cur{position:fixed;left:-40px;top:-40px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(236,237,238,.96);box-shadow:0 0 0 2px rgba(63,224,200,.7),0 4px 14px rgba(0,0,0,.5);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .3s ease,transform .12s ease-out,left .8s cubic-bezier(.22,1,.36,1),top .8s cubic-bezier(.22,1,.36,1)}#__cur.down{transform:scale(.7)}.__ring{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:2px solid rgba(63,224,200,.75);z-index:2147483646;pointer-events:none;animation:__r .6s ease-out forwards}@keyframes __r{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}';
    document.head.appendChild(s);
    const c = document.createElement('div'); c.id = '__cur'; document.body.appendChild(c);
  };
  window.__overlay = add;
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
})()`;

const b = await launch({ width: VIEW.w, height: VIEW.h + 87, extraArgs: [`--force-device-scale-factor=${SCALE}`] });
const hardStop = setTimeout(() => { log("HARD TIMEOUT"); b.close(); process.exit(2); }, 1_500_000);
const js = (e) => b.js(e);

const rectOf = async (finder) => {
  const r = await b.rectOf(finder);
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
};
const byText = (sel, re) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => ${re}.test(e.textContent.trim()))`;

// --- pointer ------------------------------------------------------------------------
async function overlay() { await js(`window.__overlay && window.__overlay()`); }
async function cursorAt(x, y) {
  await js(`(() => { const k = document.getElementById('__cur'); if (!k) return; const t = k.style.transition; k.style.transition = 'opacity .3s ease'; k.style.left = '${x}px'; k.style.top = '${y}px'; k.offsetWidth; k.style.transition = t; k.style.opacity = '1'; })()`);
}
async function cursorHide() { await js(`(() => { const k = document.getElementById('__cur'); if (k) k.style.opacity = '0'; })()`); }
async function glide(x, y, settle = 900) {
  await js(`(() => { const k = document.getElementById('__cur'); if (k) { k.style.opacity = '1'; k.style.left = '${x}px'; k.style.top = '${y}px'; } })()`);
  await sleep(820);
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(Math.max(0, settle - 820));
}
async function clickAt(x, y) {
  await js(`(() => { const k = document.getElementById('__cur'); k?.classList.add('down'); const r = document.createElement('div'); r.className = '__ring'; r.style.left = '${x}px'; r.style.top = '${y}px'; document.body.appendChild(r); setTimeout(() => { k?.classList.remove('down'); r.remove(); }, 650); })()`);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(90);
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
const centerOf = (finder) => js(`(() => { const e = ${finder}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
const parkMouse = () => b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VIEW.w - 6, y: VIEW.h - 4 });
const ease = (finder, to, ms) => js(`window.__ease(${finder ?? "document.scrollingElement"}, 'scrollTop', ${to}, ${ms})`);
/** Types into the focused input one character at a time (real key events). */
async function typeText(text, perChar = 28) {
  for (const ch of text) {
    await b.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
    await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await sleep(perChar);
  }
}

// --- recording ----------------------------------------------------------------------
let stopRec = null;
async function rec(name) {
  const dir = join(FRAMES, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  stopRec = await b.screencast(dir);
  mark(`${name}:start`);
}
async function endRec(name) {
  if (!stopRec) return;
  mark(`${name}:end`);
  const frames = await stopRec();
  stopRec = null;
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  log(`${name}: ${frames.length} frames over ${span.toFixed(1)}s (${(frames.length / Math.max(span, 0.001)).toFixed(1)} fps)`);
}
function setMeta(clip, data) { meta[clip] = { url: data.url, deviceScale: SCALE, viewport: VIEW, ...data }; }
const save = () => {
  writeFileSync(join(ROOT, ".cache/marks.json"), JSON.stringify(marks, null, 1));
  writeFileSync(join(ROOT, ".cache/meta.json"), JSON.stringify(meta, null, 1));
};
async function open(path, settle = 4500) {
  await b.goto(BASE + path, settle);
  await overlay();
  await parkMouse();
  await js(`scrollTo(0, 0)`);
  await sleep(600);
  const err = await js(`/Application error|Internal error|Could not load/i.test(document.body.innerText)`);
  if (err) throw new Error(`${path}: page shows an error`);
}
const docY = (finder) => js(`(() => { const e = ${finder}; return e ? Math.round(e.getBoundingClientRect().top + scrollY) : null; })()`);

try {
  await b.send("Emulation.clearDeviceMetricsOverride");
  await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY });
  await b.goto("about:blank", 300);
  const vp = await js(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
  if (vp.w !== VIEW.w || vp.h !== VIEW.h || vp.dpr !== SCALE) throw new Error("unexpected viewport " + JSON.stringify(vp));

  // ===== landing (hero at rest, live lattice) =========================================
  if (want("landing")) {
    await open("/", 7000);
    await b.shot(join(STILLS, "landing.png"));
    await rec("landing");
    await sleep(9000);
    await endRec("landing");
    setMeta("landing", { url: "/", notes: "Landing hero at rest with the live risk lattice; nothing clicked." });
  }

  // ===== check: type the Ronin address, run the real check, the modal works, the verdict lands ==
  if (want("check")) {
    await open("/check", 5000);
    const INPUT = `document.querySelector('form input[type="text"], form input:not([type]), form input[inputmode]')`;
    const SUBMIT = `document.querySelector('form button[type="submit"]')`;
    const FORM = `document.querySelector('form.fig, form')`;
    const formRect = await rectOf(FORM);
    await cursorAt(VIEW.w - 300, VIEW.h - 120);
    await rec("check");
    await sleep(1500);
    const inp = await centerOf(INPUT);
    if (!inp) throw new Error("check: address input not found");
    await glide(inp.x - 200, inp.y, 1000);
    await clickAt(inp.x - 200, inp.y);
    await js(`(${INPUT}).focus(); (${INPUT}).select()`);
    mark("type");
    await typeText(RONIN, 26);
    await sleep(700);
    const sub = await centerOf(SUBMIT);
    await glide(sub.x, sub.y, 950);
    await clickAt(sub.x, sub.y);
    mark("submit");
    await sleep(300);
    await cursorHide();
    await parkMouse();
    // the modal: agents at work, then the signed verdict
    const MODAL = `document.querySelector('[role="dialog"][aria-modal="true"]')`;
    let modalRect = null;
    for (let i = 0; i < 20 && !modalRect; i++) { await sleep(200); modalRect = await rectOf(MODAL); }
    if (!modalRect) throw new Error("check: screening modal did not open");
    await sleep(2500);
    await b.shot(join(STILLS, "check-running.png"));
    const end = Date.now() + 120_000;
    let done = false;
    while (Date.now() < end && !done) { await sleep(400); done = await js(`!!${byText("button", "/^View full result/")}`); }
    if (!done) throw new Error("check: verdict never arrived");
    mark("verdict");
    await sleep(3200);
    const resultRect = await rectOf(MODAL);
    await b.shot(join(STILLS, "check-verdict.png"));
    const view = await centerOf(byText("button", "/^View full result/"));
    await glide(view.x, view.y, 1000);
    await clickAt(view.x, view.y);
    mark("view");
    await sleep(2600);
    await endRec("check");
    setMeta("check", {
      url: "/check",
      address: RONIN,
      rects: { form: formRect, modal: modalRect, result: resultRect },
      notes: "Real typing of the Ronin exploiter address (mark type), a real click on Check (mark submit); the screening modal runs against the live API and the signed verdict lands (mark verdict); View full result clicked (mark view).",
    });

  }
    // ===== address: the full verdict page the check opens =============================
    if (want("address")) {
      await open(`/a/${RONIN}`, 6000);
      await cursorHide();
      await parkMouse();
      await sleep(800);
      const head = await rectOf(`document.querySelector('h1')`);
      await b.shot(join(STILLS, "address.png"));
      await rec("address");
      await sleep(3500);
      const max = await js(`document.documentElement.scrollHeight - innerHeight`);
      await ease(null, Math.min(620, max), 3200);
      mark("scrolled");
      await sleep(3500);
      await endRec("address");
      setMeta("address", { url: `/a/${RONIN}`, rects: { headline: head }, notes: "The public address page for the Ronin wallet after the check: headline, reasons, attestation; eased scroll down 620px (mark scrolled)." });
    }

  // ===== ledger: hash-chained, verified, anchored ======================================
  if (want("ledger")) {
    await open("/ledger", 6000);
    for (let i = 0; i < 30; i++) { if (await js(`/chain intact/.test(document.body.innerText)`)) break; await sleep(400); }
    const badge = await rectOf(byText("*", "/^chain intact/"));
    await b.shot(join(STILLS, "ledger.png"));
    await rec("ledger");
    await sleep(3000);
    const max = await js(`document.documentElement.scrollHeight - innerHeight`);
    await ease(null, Math.min(520, max), 3000);
    mark("scrolled");
    await sleep(3000);
    await endRec("ledger");
    setMeta("ledger", { url: "/ledger", rects: { badge }, notes: "The public decision ledger with its live 'chain intact' check; eased scroll (mark scrolled)." });
  }

  // ===== company: the agent-run company ==================================================
  if (want("company")) {
    await open("/company", 7000);
    const reasoning = await rectOf(byText("section", "/^Today.s reasoning/"));
    const kpis = await rectOf(`document.querySelector('.stats, [class*="kpis"], [class*="stats"]')`);
    await b.shot(join(STILLS, "company.png"));
    await rec("company");
    await sleep(3500);
    const pricingY = await docY(byText("section", "/^Pricing/"));
    const max = await js(`document.documentElement.scrollHeight - innerHeight`);
    await ease(null, Math.min(max, Math.max(0, (pricingY ?? 700) - 140)), 3400);
    mark("pricing");
    await sleep(500);
    const pricing = await rectOf(byText("section", "/^Pricing/"));
    await sleep(3500);
    await endRec("company");
    setMeta("company", { url: "/company", rects: { reasoning, kpis, pricing }, notes: "Company page at rest (KPIs, today's reasoning), then eased scroll to Reserves / Obligations / Pricing (mark pricing; rects.pricing is at that point)." });
  }

  // ===== payouts: the treasury refusing the Ronin wallet ================================
  if (want("payouts")) {
    await open("/payouts", 6000);
    const ROW = `[...document.querySelectorAll('tr')].find((r) => /Ronin Bridge exploiter/.test(r.textContent))`;
    const heldY = await docY(ROW);
    log("held invoice y", heldY);
    await rec("payouts");
    await sleep(2500);
    const max = await js(`document.documentElement.scrollHeight - innerHeight`);
    if (heldY == null) throw new Error("payouts: HELD Ronin row not found");
    await ease(null, Math.min(max, Math.max(0, heldY - 420)), 3000);
    mark("held");
    await sleep(600);
    const held = await rectOf(ROW);
    await b.shot(join(STILLS, "payouts.png"));
    await sleep(3400);
    await endRec("payouts");
    setMeta("payouts", { url: "/payouts", rects: { held }, notes: "Guarded Payouts; eased scroll to the HELD invoice addressed to the Ronin exploiter (a test invoice we created), mark held." });
  }

  // ===== prompt: the copy-paste integration prompt ======================================
  if (want("prompt")) {
    await open("/docs/agent-prompt", 5000);
    const copy = await centerOf(byText("button", "/^Copy/"));
    const code = await rectOf(`document.querySelector('figure.fig, pre')`);
    await cursorAt(VIEW.w - 260, VIEW.h - 120);
    await rec("prompt");
    await sleep(2500);
    if (copy) {
      await ease(null, 0, 10);
      const c2 = await centerOf(byText("button", "/^Copy/"));
      await glide(c2.x, c2.y, 1000);
      await clickAt(c2.x, c2.y);
      mark("copy");
    }
    await sleep(1200);
    await cursorHide();
    const codeY = await docY(`document.querySelector('figure.fig, pre')`);
    const max = await js(`document.documentElement.scrollHeight - innerHeight`);
    await ease(null, Math.min(max, Math.max(0, (codeY ?? 400) - 90)), 2600);
    mark("prompt");
    await sleep(3500);
    await b.shot(join(STILLS, "prompt.png"));
    await endRec("prompt");
    setMeta("prompt", { url: "/docs/agent-prompt", rects: { code }, notes: "The 'Integrate with your AI agent' docs page; Copy clicked (mark copy), then eased scroll down the prompt (mark prompt)." });
  }
} catch (e) {
  log("FAILED:", e.stack || e.message);
  if (stopRec) { try { await stopRec(); } catch {} }
  process.exitCode = 1;
} finally {
  save();
  log("console:", b.consoleLines.slice(0, 8));
  clearTimeout(hardStop);
  b.close();
}
