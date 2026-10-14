import Link from "next/link";
import { Code, Status, Table } from "../_components/Doc";
import type { DocPage } from "./types";

const REGISTRY = `# contracts/README.md - Arc mainnet, chain id 5042, gas is USDC; use a keystore account, not a raw key
export ARC_RPC_URL=https://rpc.mainnet.arc.io
export OWNER_ADDRESS=0x…        # cold admin: rotates the attester, pauses, revokes
export ATTESTER_ADDRESS=0x…     # address of ATTESTER_PRIVATE_KEY
forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_RPC_URL --account <keystore> --sender <addr>              # simulate, check block.chainid
forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_RPC_URL --account <keystore> --sender <addr> --broadcast
# then in the app:
REGISTRY_ADDRESS=0x…
ATTESTER_PRIVATE_KEY=0x…`;

const TREASURY = `export REGISTRY_ADDRESS=<AttestationRegistry>
export TOKEN_ADDRESS=0x3600000000000000000000000000000000000000
export OWNER_ADDRESS=<address of TREASURY_PRIVATE_KEY>
forge script script/Deploy.s.sol:DeployGuardedTreasury --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY --broadcast
cast send 0x3600…0000 "transfer(address,uint256)" <GuardedTreasury> 50000000 --rpc-url $ARC_RPC_URL --private-key $PRIVATE_KEY   # ≤ 50 USDC
# app: GUARDED_TREASURY_ADDRESS, TREASURY_PRIVATE_KEY, TREASURY_MODE=live (+ REGISTRY_ADDRESS, ATTESTER_PRIVATE_KEY)`;

const CIRCLE = `CIRCLE_API_KEY=…                                   # console.circle.com → API Keys (Mainnet toggle)
node scripts/circle/setup.ts --generate-secret      # → CIRCLE_ENTITY_SECRET
node --env-file=.env.local scripts/circle/setup.ts --register     # once; keep the recovery file, it cannot be downloaded again
node --env-file=.env.local scripts/circle/setup.ts --balances     # provisions "revenue" + "ops" SCA wallets; prints X402_PAY_TO, OWN_WALLETS, CIRCLE_WALLET_SET_ID
# console → Gas Station → Mainnet → policy on ARC (max/day, per-tx) → Activate · fund ops with a few USDC
SIGNER_MODE=circle
curl -s https://…/api/internal/circle -H "Authorization: Bearer $CRON_SECRET"   # effectiveSigner: "circle", balances, hints`;

const X402 = `X402_DISABLED=0
X402_PAY_TO=<Circle revenue wallet>
X402_FACILITATOR_URL=https://api.circle.com/v1/facilitator/x402
X402_FACILITATOR_API_KEY=<Circle Console key>       # or X402_SELLER_PRIVATE_KEY for the keyless trial
X402_NETWORK=eip155:5042                            # optional, defaults from ARC_CHAIN_ID`;

const ERC8004 = `PUBLIC_BASE_URL=https://<prod host>
npx tsx --env-file=.env.local scripts/erc8004/register.ts --print            # dry run: metadata + calldata
# host scripts/erc8004/agent.built.json at $PUBLIC_BASE_URL/.well-known/agent-registration.json, or use --data-uri
ERC8004_OWNER_PRIVATE_KEY=0x… npx tsx --env-file=.env.local scripts/erc8004/register.ts [--data-uri]   # prints agentId
ERC8004_AGENT_ID=<id>   # then re-run to setAgentURI with the registrations[] back-reference`;

export const mainnetChecklist: DocPage = {
  slug: "mainnet-checklist",
  title: "Mainnet checklist",
  description: "What is live on Arc mainnet today, what is pending, and the exact keys and steps that flip each loop from dry-run to live.",
  lead: (
    <>
      <strong>Everything already points at Arc mainnet 5042; what is missing is keys, deploys and one onboarding.</strong> Each row below is one switch, in the order they
      depend on each other. Keep at most 100 USDC on-chain at any time and keep <code>COMPLIR_PAUSED=1</code> as the kill switch.
    </>
  ),
  sections: [
    {
      id: "status",
      title: "Status board",
      body: (
        <Table
          head={["Capability", "Today", "Flip"]}
          wide={[2]}
          rows={[
            ["Screening, verdicts, EIP-712 signatures", <Status key="s" kind="live">live</Status>, "ATTESTER_PRIVATE_KEY (else an ephemeral key per process)"],
            ["Watches, webhooks, blocklist reactor, Trust Map, ledger", <Status key="s" kind="live">live</Status>, "CRON_SECRET + crons or workers running"],
            ["Analyst and operator model steps", <Status key="s" kind="live">live / fallback</Status>, "LLM_PROVIDER=0g + ZEROG_API_KEY (Claude via 0G Compute Router; ANTHROPIC_API_KEY also works); deterministic fallback on timeout"],
            ["AttestationRegistry on Arc", <Status key="s" kind="live">live · 0xA82EDb5e…</Status>, "deployed + verified (Sourcify)"],
            ["Merkle anchoring", <Status key="s" kind="live">live</Status>, "anchorRoot() on every watcher tick when ≥ ANCHOR_EVERY_N decisions are pending"],
            ["GuardedTreasury / Guarded Payouts", <Status key="s" kind="live">live · 0x5465f31a…</Status>, "TREASURY_MODE=live; caps 10 USDC / payout, 20 / day"],
            ["Circle Developer-Controlled Wallets (revenue 0x9b0d…977e, ops 0xa494…7c69, SCA on ARC)", <Status key="s" kind="live">live</Status>, "provisioned; registry writes relay through the ops wallet with Gas Station sponsored gas (ERC-4337 EntryPoint); local attester key is the fallback"],
            ["x402 charging (0.01 USDC / screen, Circle Facilitator, eip155:5042)", <Status key="s" kind="live">live</Status>, "first real settlement landed in the revenue wallet"],
            ["Auto-refunds, tip bounties", <Status key="s" kind="live">live via Circle revenue wallet</Status>, "sent from the Circle revenue wallet; Gas Station policy active"],
            ["Revenue yield sweep (Circle Earn · Steakhouse Prime USDC 0xbeef0016…7298)", <Status key="s" kind="live">live · moves only above the float</Status>, "YIELD_MODE=live; Circle revenue wallet approve → deposit / redeem; today 2.02 USDC < 5 float → NONE (step 5)"],
            ["ERC-8004 identity", <Status key="s" kind="pending">pending</Status>, "step 6"],
            ["Hosted URL, yente in production", <Status key="s" kind="pending">pending</Status>, "a host + libSQL URL; a yente container the host can reach"],
          ]}
        />
      ),
    },
    {
      id: "registry",
      title: "1 · Registry",
      body: (
        <>
          <Code lang="sh" code={REGISTRY} />
          <p>
            Verdicts are mirrored on-chain from the next screen; <code>registryTx</code> stops being <code>null</code>, <code>isAllowed</code> starts answering, and the watcher anchors
            Merkle roots every 50 entries. Verify the contract on the explorer with the commands in <code>contracts/README.md</code>.
          </p>
        </>
      ),
    },
    {
      id: "treasury",
      title: "2 · GuardedTreasury",
      body: (
        <>
          <Code lang="sh" code={TREASURY} />
          <p>
            Live mode requires all four env values; <code>GET /api/v1/payouts</code> → <code>missingForLive</code> tells you which are absent. Details on{" "}
            <Link href="/docs/guarded-payouts#go-live">Guarded payouts</Link>.
          </p>
        </>
      ),
    },
    {
      id: "circle",
      title: "3 · Circle wallets and Gas Station",
      body: (
        <>
          <Code lang="sh" code={CIRCLE} />
          <ul>
            <li>
              <strong>Why SCA:</strong> Gas Station sponsorship on EVM is ERC-4337, so the relaying ops wallet must be an SCA. The attester key stays local because the registry verifies
              with <code>ECDSA.recover</code>, which an SCA signature cannot satisfy.
            </li>
            <li>
              <strong>Policies:</strong> spending caps are enforced app-side (<code>CIRCLE_*_POLICY_*</code>) because developer-controlled wallets have no policy API; Gas Station adds a
              Circle-side cap on sponsored gas. Transactions above the policy pay from the SCA&apos;s own USDC, so keep a small float in ops.
            </li>
            <li>
              <strong>Unverified:</strong> Gas Station on Arc mainnet is documented but was not exercised without an account; the first live relay should be one cheap write.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "x402",
      title: "4 · x402",
      body: (
        <>
          <Code lang="env" code={X402} />
          <p>
            Set <code>OWN_WALLETS</code> to the Circle wallets and any test payers so they are excluded from <Link href="/numbers">/numbers</Link> and listed in every report. Then
            run one paid call through the SDK and confirm <code>PAYMENT-RESPONSE</code> carries a transaction on Arc.
          </p>
        </>
      ),
    },
    {
      id: "usyc",
      title: "5 · Revenue yield (Circle Earn)",
      body: (
        <>
          <p>
            Idle revenue goes into a Circle Earn vault on Arc: Morpho USDC vaults (ERC-4626, Morpho Vault V2) with no allowlist and no minimum. The planner reads Circle&apos;s
            Earn API (<code>GET api.circle.com/v1/earnKit/vaults/explore?chain=ARC</code>, keyless), refuses any vault Circle flags <code>low_liquidity</code>, any RED warning or
            unlisted vault, requires Circle Sentinel coverage and TVL ≥ 100k, and only uses a vault whose available liquidity is at least 2× what we would need to redeem. The best
            APY among the rest wins; today that is <strong>Steakhouse Prime USDC</strong> <code>0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298</code> (≈3.1%).
          </p>
          <ol>
            <li>
              <code>YIELD_MODE=live</code> (default <code>YIELD_BACKEND=earn</code>); <code>REVENUE_WALLET</code>/<code>X402_PAY_TO</code> must be the Circle revenue wallet.
            </li>
            <li>
              Pin the revenue wallet&apos;s contract calls to USDC + the vault:{" "}
              <code>npx tsx --env-file=.env.local scripts/circle/allow-contracts.ts revenue 0x3600…0000 0xbeef0016…7298</code> (tips and refunds are plain transfers and stay unaffected).
            </li>
            <li>
              Keep <code>YIELD_FLOAT_USDC</code> (5) + obligations due 48 h liquid; deposits are capped at <code>YIELD_MAX_SWEEP_USDC</code> (25 = the per-tx policy).
            </li>
          </ol>
          <p>
            Each executed move is logged as <code>OPERATOR · YIELD_SWEEP</code> / <code>YIELD_REDEEM</code> with tx hashes on <Link href="/ledger">/ledger</Link>; plans that move nothing
            are <code>NOOP · YIELD_PLAN</code>. USYC (permissioned, ~100k minimum) stays available as <code>YIELD_BACKEND=usyc</code>: see <code>docs/YIELD.md</code>.
          </p>
        </>
      ),
    },
    {
      id: "erc8004",
      title: "6 · ERC-8004 identity",
      body: (
        <>
          <Code lang="sh" code={ERC8004} />
          <p>
            Registering mints an ERC-721 identity in the Arc <code>IdentityRegistry</code> (<code>0x8004A169FB4a3325136EB29fA0ceB6D2e539a432</code>, the same CREATE2 singleton as on
            Ethereum and Base) whose URI lists CompliR&apos;s services, including the x402 screen endpoint with its price and network. Without a key the script prints the raw
            transaction so a multisig can send it. Coinbase&apos;s x402 Bazaar indexes only CDP-settled payments on its own networks, so the ERC-8004 entry and APEX&apos;s Arc x402
            explorer are the discoverability paths that work on Arc today.
          </p>
        </>
      ),
    },
    {
      id: "last",
      title: "After the flips",
      body: (
        <ul>
          <li>
            <strong>Health:</strong> <code>/api/v1/health</code> should show the registry address, <code>x402.disabled: false</code> and <code>signer.mode: circle</code>.
          </li>
          <li>
            <strong>Integrations:</strong> replace <code>https://trycomplir.xyz</code> in <code>docs/integrations/*/PR.md</code> with the hosted URL, add the registry address to the
            CeedeBooks PR, then open the three prepared PRs (STEWARD, Vestiarion, CeedeBooks).
          </li>
          <li>
            <strong>Report:</strong> the first signed daily report publishes at 00:05 UTC; add notes and mistakes to <code>.data/report-notes.json</code>.
          </li>
        </ul>
      ),
    },
  ],
};
