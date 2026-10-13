import type { Metadata } from "next";
import Link from "next/link";
import styles from "./tools.module.css";

export const metadata: Metadata = {
  title: "Tools - browser extension, Telegram bot, payment links",
  description: "Three ways to use CompliR verdicts without writing code: tier chips next to every address you browse, a Telegram bot that screens and watches wallets, and payment links that screen the payer.",
};

const EXT_STEPS = [
  { n: "01", t: "Download and unzip", b: "Grab complir-extension.zip and unzip it anywhere you keep it; the folder must stay in place after loading." },
  { n: "02", t: "Open the extensions page", b: "Chrome / Brave / Edge: chrome://extensions (edge://extensions). Switch on Developer mode in the top-right corner." },
  { n: "03", t: "Load unpacked", b: "Click Load unpacked and pick the unzipped folder. The CompliR icon appears in the toolbar; pin it." },
  { n: "04", t: "Point it at a CompliR host", b: "Open the popup and set the CompliR URL (default: this site). http://localhost:3000 works for a local dev server." },
];
const BOT_CMDS = [
  ["/check 0x…", "plain-language verdict, tier, link to the public report (or just paste an address)"],
  ["/watch 0x…", "30 days of re-screening; a message lands in the chat when the tier changes"],
  ["/report", "today's signed traction report summary + link"],
  ["/start", "what the bot does"],
];

export default function ToolsPage() {
  const bot = process.env.NEXT_PUBLIC_TELEGRAM_BOT?.replace(/^@/, "") ?? "";
  return (
    <div className={`container ${styles.wrap}`}>
      <div className="pageHead">
        <div>
          <p className="small muted">oracle · tools · no code required</p>
          <h1>Tools</h1>
          <p className="muted">
            The same signed verdicts the API serves, where you already are: in the browser, in Telegram, and on a payment link.
            All three read the public attestation endpoint; nothing here needs an API key.
          </p>
        </div>
      </div>

      <section className={styles.tool}>
        <div className="sec-bar"><span className="sec-n">01</span><span>Browser extension</span><span className="sec-meta">Manifest V3 · Chrome, Brave, Edge</span></div>
        <h2>A tier chip after every address you see</h2>
        <p className="muted">
          The content script finds EVM addresses on any page, asks CompliR for the latest stored verdict and injects a small LOW / MEDIUM / HIGH chip
          after each one, linking to the public report. If an address you type into a send form is HIGH, a banner tells you not to send. Results are
          cached for ten minutes; nothing else leaves the browser.
        </p>
        <div className={styles.actions}>
          <a className="btn btnPrimary" href="/downloads/complir-extension.zip" download>Download zip</a>
          <a className="btn" href="https://github.com/mrnetwork0001/CompliR/tree/main/packages/extension" rel="noreferrer">Source</a>
          <span className="small muted">No build step: plain JS, loads unpacked.</span>
        </div>
        <ol className={`rail ${styles.steps}`}>
          {EXT_STEPS.map((s) => (
            <li key={s.n}>
              <span className="rail-n">{s.n}</span>
              <div><strong>{s.t}</strong><p className="muted small" style={{ marginTop: 4 }}>{s.b}</p></div>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.tool}>
        <div className="sec-bar"><span className="sec-n">02</span><span>Telegram bot</span><span className="sec-meta">long polling · dependency-free</span></div>
        <h2>Screen and watch wallets from a chat</h2>
        <div className={styles.cols}>
          <div>
            <p className="muted">
              Paste an address, get the verdict. <code>/watch</code> registers a 30-day watch whose webhook posts tier changes straight back to the chat.
              Run it yourself with Node 20+; it needs only a bot token from @BotFather.
            </p>
            <div className={styles.actions}>
              {bot ? <a className="btn btnPrimary" href={`https://t.me/${bot}`} rel="noreferrer">Open @{bot}</a> : <span className="chip">Public bot not configured</span>}
              <a className="btn" href="https://github.com/mrnetwork0001/CompliR/tree/main/packages/bot" rel="noreferrer">Source</a>
            </div>
            <dl className="dl">
              {BOT_CMDS.map(([c, d]) => <div key={c}><dt style={{ textTransform: "none" }}>{c}</dt><dd>{d}</dd></div>)}
            </dl>
          </div>
          <div>
            <pre><code>{`TELEGRAM_BOT_TOKEN=123:abc \\
COMPLIR_URL=${process.env.PUBLIC_BASE_URL ?? "https://complir.example"} \\
BOT_WEBHOOK_SECRET=change-me \\
node packages/bot/bot.mjs`}</code></pre>
            <p className="small muted" style={{ marginTop: 10 }}>
              Optional <code>COMPLIR_PAYER_PRIVATE_KEY</code> pays for fresh screens and watches over x402; without it the bot reads the free attestation endpoint.
              Set the same <code>BOT_WEBHOOK_SECRET</code> on the CompliR server so watch webhooks are accepted.
            </p>
          </div>
        </div>
      </section>

      <section className={styles.tool}>
        <div className="sec-bar"><span className="sec-n">03</span><span>Payment links</span><span className="sec-meta">/pay</span></div>
        <h2>Screen the payer before you accept</h2>
        <p className="muted">
          Create a USDC payment request on Arc. The payer declares the wallet they will send from, CompliR screens it, and only a LOW-risk wallet is
          shown the destination and an EIP-681 QR code. MEDIUM waits for your accept, HIGH is declined before any funds move.
        </p>
        <div className={styles.actions}>
          <Link className="btn btnPrimary" href="/pay">Create a payment link</Link>
          <span className="small muted">Free · same-origin · merchant key stays in your browser.</span>
        </div>
      </section>
    </div>
  );
}
