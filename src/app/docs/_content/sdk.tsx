import Link from "next/link";
import { Code, Kv, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const USAGE = `import { CompliR, CompliRPaymentError } from "@complir/sdk";
import { privateKeyToAccount } from "viem/accounts";

const c = new CompliR({
  baseUrl: "https://trycomplir.xyz",
  account: privateKeyToAccount(process.env.PAYER_KEY as \`0x\${string}\`), // any viem LocalAccount: holds USDC on Arc
  maxPriceUsdc: 0.05,          // refuse to sign above this per call (default 1)
  network: "eip155:5042",      // only accept requirements on Arc mainnet (default: any eip155:*)
});

try {
  const v = await c.screen("0xPayee", { amountUsdc: 120, name: "Lela Design", payeeBook: myPayees, clientId: "treasury-7" });
  if (v.tier === "HIGH") hold(v.rationale);
  else pay(Math.min(120, v.recommendedLimits.maxPerTxUsdc));
  console.log(c.lastPayment);  // settle receipt from PAYMENT-RESPONSE: { transaction, payer, amount, network }

  await c.watch("0xPayee", { webhookUrl: "https://treasury.example/complir", clientId: "treasury-7" });
  const att = await c.attestation("0xPayee");                       // free; null on 404
  const ok = await CompliR.verifyAttestation(v.attestation, { expectedChainId: 5042 });
} catch (e) {
  if (e instanceof CompliRPaymentError) console.error(e.requirements, e.receipt);  // 402 after signing
}`;

const RAW = `// Any paid route, the x402 dance handled for you (bodies must be re-sendable strings).
const res = await c.paidFetch("/api/v1/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });

// Pieces, if you bring your own HTTP client:
import { readPaymentRequired, readReceipt, usdcToAtomic, atomicToUsdc, tierForScore } from "@complir/sdk";`;

export const sdk: DocPage = {
  slug: "sdk",
  title: "SDK",
  description: "@complir/sdk: the TypeScript client with the x402 402 → sign → retry loop, offline attestation verification and typed verdicts.",
  lead: (
    <>
      <strong><code>@complir/sdk</code> is a small TypeScript client that pays for you.</strong> On a 402 it reads the requirements, signs an EIP-3009{" "}
      <code>TransferWithAuthorization</code> with a viem account, retries once with <code>PAYMENT-SIGNATURE</code>, and exposes the settle receipt. Verification of an attestation
      needs no network at all.
    </>
  ),
  sections: [
    {
      id: "install",
      title: "Install",
      body: (
        <>
          <p>
            The package lives in <code>packages/sdk</code> of the repository and depends only on <code>viem</code>. It is not published to npm yet; install it from the repo (
            <code>npm install ./packages/sdk</code> or a workspace link; it ships TypeScript sources, <code>main: ./src/index.ts</code>). Node 20+ or any runtime with{" "}
            <code>fetch</code>, <code>crypto.getRandomValues</code> and <code>btoa</code>.
          </p>
        </>
      ),
    },
    {
      id: "usage",
      title: "Usage",
      body: <Code lang="ts" code={USAGE} />,
    },
    {
      id: "api",
      title: "API",
      body: (
        <>
          <Table
            head={["Member", "Does"]}
            wide={[1]}
            rows={[
              [<code key="a">new CompliR({`{ baseUrl, account, maxPriceUsdc?, network?, authorizationSlackSeconds?, fetch? }`})</code>, "baseUrl and a viem account with signTypedData are required. Slack (default 540 s) is added to the server's maxTimeoutSeconds for the authorization's validBefore."],
              [<code key="b">screen(address, {`{ name?, amountUsdc?, payeeBook?, clientId?, depth? }`})</code>, "POST /api/v1/screen → Verdict"],
              [<code key="c">watch(address, {`{ webhookUrl, clientId?, payeeBook? }`})</code>, "POST /api/v1/watch → Watch"],
              [<code key="d">attestation(address)</code>, "GET /api/v1/attestation/:address → Attestation | null"],
              [<code key="e">verifyAttestation(att, opts?)</code>, "static and instance: offline EIP-712 check; never throws, returns boolean. opts: now, ignoreExpiry, expectedAttester, expectedChainId, expectedVerifyingContract"],
              [<code key="f">paidFetch(path, init?)</code>, "fetch with the 402 → sign → retry loop; path relative to baseUrl or absolute"],
              [<code key="g">lastPayment</code>, "PaymentReceipt from the most recent paid call, or null"],
              [<code key="h">CompliRError / CompliRPaymentError</code>, "status, code, body; payment errors add requirements and receipt"],
            ]}
          />
          <Code lang="ts" code={RAW} />
        </>
      ),
    },
    {
      id: "payment",
      title: "How a payment is signed",
      body: (
        <Kv
          rows={[
            { k: "Requirement", v: "the first accepts[] entry with scheme exact on an eip155:* network (or the configured one); amount ≤ maxPriceUsdc or CompliRPaymentError" },
            { k: "Domain", v: "{ name: extra.name ?? \"USDC\", version: extra.version ?? \"2\", chainId from the CAIP-2 network, verifyingContract: asset }" },
            { k: "Authorization", v: "from = account, to = payTo, value = amount, validAfter 0, validBefore = now + maxTimeoutSeconds + slack, nonce = 32 random bytes" },
            { k: "Retry", v: "exactly one, with PAYMENT-SIGNATURE = base64 { x402Version: 2, resource, accepted, payload: { signature, authorization } }" },
            { k: "Second 402", v: "throws CompliRPaymentError with the server's error (settlement pending, mismatch …) and the receipt when present" },
          ]}
        />
      ),
    },
    {
      id: "types",
      title: "Types",
      body: (
        <p>
          <code>Verdict</code>, <code>Attestation</code>, <code>AttestationTypedData</code>, <code>Reason</code>, <code>Watch</code>, <code>PayeeBookEntry</code>,{" "}
          <code>PaymentRequired</code>, <code>PaymentRequirements</code>, <code>PaymentReceipt</code> mirror <code>src/lib/types.ts</code> (the SDK types{" "}
          <code>evidence</code> as <code>unknown</code>). Field meanings are on <Link href="/docs/screening">Screening & verdicts</Link>. The MCP server uses this SDK for its paid
          tools.
        </p>
      ),
    },
  ],
};
