import Link from "next/link";
import { Code, Kv } from "../_components/Doc";
import type { DocPage } from "./types";

const FLOW = `client                              CompliR                                 Circle facilitator (Arc)
  │  POST /api/v1/screen                │                                        │
  │ ───────────────────────────────────►│                                        │
  │  402 + PAYMENT-REQUIRED             │                                        │
  │ ◄───────────────────────────────────│                                        │
  │  sign EIP-3009 TransferWithAuthorization (USDC, 0.01) with the payer key      │
  │  POST again + PAYMENT-SIGNATURE     │                                        │
  │ ───────────────────────────────────►│  /verify ────────────────────────────► │
  │                                     │ ◄──────────────────────── isValid      │
  │                                     │  run the handler (screen)              │
  │                                     │  /settle (payment-identifier = nonce) ►│
  │                                     │ ◄──────────────── transaction, payer   │
  │  200 + PAYMENT-RESPONSE + verdict   │                                        │
  │ ◄───────────────────────────────────│                                        │`;

const REQUIRED = `// 402 body and PAYMENT-REQUIRED (base64 of the same object)
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": { "url": "https://trycomplir.xyz/api/v1/screen", "description": "CompliR screen: one address", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact", "network": "eip155:5042", "amount": "10000",            // 0.01 USDC in 6-dp atomic units
    "asset": "0x3600000000000000000000000000000000000000", "payTo": "0x…",    // X402_PAY_TO (the Circle revenue wallet)
    "maxTimeoutSeconds": 60,
    "extra": { "assetTransferMethod": "eip3009", "name": "USDC", "version": "2" }  // EIP-712 domain of USDC on Arc
  }]
}`;

export const x402: DocPage = {
  slug: "x402",
  title: "x402 payments",
  description: "How CompliR charges per call over x402 v2 with Circle's facilitator on Arc: the 402 flow, requirements, idempotency, and the same-origin free rule.",
  lead: (
    <>
      <strong>CompliR has no API keys; a request pays for itself.</strong> The first call answers 402 with what to sign, the client signs a USDC authorization, retries, and
      CompliR verifies and settles it through Circle&apos;s facilitator on Arc before returning the verdict. Nothing is charged when the handler fails; nothing settled is ever
      silently kept.
    </>
  ),
  sections: [
    {
      id: "flow",
      title: "The 402 flow",
      body: (
        <>
          <Code lang="text" code={FLOW} />
          <Code lang="json" code={REQUIRED} />
          <p>
            Protocol: x402 v2 (<code>x402Version: 2</code>), scheme <code>exact</code> on <code>eip155:5042</code>, transfer method <code>eip3009</code>. The CompliR{" "}
            <Link href="/docs/sdk">SDK</Link> and <Link href="/docs/mcp">MCP server</Link> implement the client side; the header and status reference is on{" "}
            <Link href="/docs/http-api#x402-headers">HTTP API</Link>.
          </p>
        </>
      ),
    },
    {
      id: "server",
      title: "What the server guarantees",
      body: (
        <>
          <ul>
            <li>
              <strong>Fail closed.</strong> Any verify or settle problem answers 402 or 502 and the handler&apos;s body is never leaked.
            </li>
            <li>
              <strong>Handler first, then settle</strong> (default): a failing or refusing handler is never charged. <code>settleFirst</code> is used only where the side effect must
              not happen unpaid (the tip stake); anything that fails after that settlement is auto-refunded.
            </li>
            <li>
              <strong>Idempotent per nonce for 5 minutes.</strong> A retry after a settled payment replays the cached response without a second settle; a retry after{" "}
              <code>settlement_pending</code> re-settles without re-running the handler; concurrent duplicates share one in-flight attempt.
            </li>
            <li>
              <strong>Requirements are re-checked</strong> against the signed payload: scheme, network, asset, payTo, amount, authorization.to, authorization.value, validAfter and
              validBefore. Signing for less than the current price is rejected before anything runs.
            </li>
            <li>
              <strong>One payment per authorization on Circle too:</strong> the settle call carries the <code>payment-identifier</code> extension derived from the EIP-3009 nonce
              (<code>complir_&lt;nonce&gt;</code>), so a client retry converges on one payment.
            </li>
            <li>
              <strong>Pending settlements</strong> are polled up to 3 times (<code>X402_PENDING_POLLS</code>) via the facilitator&apos;s status endpoint before the client is asked to
              retry with the same authorization.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "facilitator",
      title: "Facilitator and config",
      body: (
        <Kv
          mono
          rows={[
            { k: "X402_DISABLED", v: "1 today (every call free, X-CompliR-Payment: disabled). Set 0 to charge." },
            { k: "X402_FACILITATOR_URL", v: "https://api.circle.com/v1/facilitator/x402 (Circle Facilitator Service, Arc native)" },
            { k: "X402_FACILITATOR_API_KEY", v: "Circle Console key → Authorization: Bearer; required for production settle" },
            { k: "X402_SELLER_PRIVATE_KEY", v: "alternative keyless trial: Facilitator-Seller-Proof signed by the X402_PAY_TO key" },
            { k: "X402_PAY_TO", v: "where USDC lands - the Circle revenue wallet once provisioned" },
            { k: "X402_NETWORK", v: "CAIP-2; defaults to eip155:$ARC_CHAIN_ID" },
            { k: "X402_ASSET_NAME / _VERSION", v: "EIP-712 domain of the token, default USDC / 2" },
            { k: "PRICE_SCREEN_USDC / PRICE_WATCH_USDC", v: "config defaults 0.01 / 0.05; the operator may move them inside its bounds" },
          ]}
        />
      ),
    },
    {
      id: "same-origin",
      title: "The same-origin free rule",
      body: (
        <>
          <p>
            Requests whose browser sends <code>Sec-Fetch-Site: same-origin</code> bypass x402 on <code>/api/v1/screen</code>, <code>/api/v1/watch</code> and{" "}
            <code>/api/v1/tips</code>. That is what keeps the hosted Explorer, Shadow and Tips pages free to use: they are thin views over the same handlers. An API client, a curl
            from another host or an agent never sends that header and always pays (unless <code>X402_DISABLED=1</code>). Screens made this way are recorded under the internal client
            id <code>web-explorer</code> and never count as traction.
          </p>
          <p>
            Gateway-batched x402 (Circle Nanopayments) is not implemented: it would fit the buyer side of the tip stake, but the SDK is not installed and Arc settlement here goes
            through the standard facilitator.
          </p>
        </>
      ),
    },
  ],
};
