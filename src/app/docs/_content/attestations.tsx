import Link from "next/link";
import { Addr, Code, Kv, Status } from "../_components/Doc";
import type { DocPage } from "./types";

const STRUCT = `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
  name = "CompliR", version = "1", chainId = 5042, verifyingContract = AttestationRegistry

Attestation(address subject,uint8 tier,uint8 score,bytes32 decisionHash,uint64 issuedAt,uint64 validUntil)
  typehash = 0x86d4b56447401a0aa7aea88cef207cd6ff21bb50dd72f46b5e5baccf75e854db

tier: UNKNOWN=0 · LOW=1 · MEDIUM=2 · HIGH=3
decisionHash = keccak256(utf8(canonical(decision core)))   // sorted keys, no whitespace`;

const VERIFY_SDK = `import { CompliR } from "@complir/sdk";

const ok = await CompliR.verifyAttestation(verdict.attestation, {
  expectedAttester: "0x…",      // from GET /api/v1/health → signer, or the registry's attester()
  expectedChainId: 5042,
  // ignoreExpiry: true          // when auditing history
});
// checks: primaryType, domain name/version, field list, tier ∈ {1,2,3}, score 0–100,
// validUntil > issuedAt and == att.validUntil, bytes32 decisionHash, then viem verifyTypedData.`;

const ONCHAIN = `interface ICompliR {
    enum Tier { UNKNOWN, LOW, MEDIUM, HIGH }
    function tierOf(address subject) external view returns (Tier tier, uint64 validUntil, bytes32 decisionHash);
    function isAllowed(address subject, Tier maxTier) external view returns (bool);
    // isAllowed == tier != UNKNOWN && tier <= maxTier && validUntil > block.timestamp
    event Attested(address indexed subject, Tier tier, uint64 validUntil, bytes32 decisionHash);
    event TierChanged(address indexed subject, Tier from, Tier to);
    event Anchored(bytes32 indexed root, uint256 fromSeq, uint256 toSeq);
}`;

export const attestations: DocPage = {
  slug: "attestations",
  title: "Attestations & registry",
  description: "The EIP-712 attestation every verdict carries, how long it is valid, how to verify it offline, and how it is mirrored and anchored on Arc.",
  lead: (
    <>
      <strong>Every verdict is signed as EIP-712 typed data by the CompliR attester key, so anyone can check it without asking CompliR.</strong> The same signature is what the
      on-chain registry verifies when the attestation is mirrored to Arc, and the <code>decisionHash</code> inside it links back to the replayable ledger entry.
    </>
  ),
  sections: [
    {
      id: "struct",
      title: "The struct",
      body: (
        <>
          <Code lang="eip-712" code={STRUCT} />
          <p>
            The TypeScript signer (<code>src/lib/attest/eip712.ts</code>) and the Solidity registry must stay byte-identical; two Foundry tests pin the typehash and accept a
            viem-signed attestation on the Arc chain id.
          </p>
        </>
      ),
    },
    {
      id: "validity",
      title: "Validity per tier",
      body: (
        <>
          <Kv
            rows={[
              { k: "LOW", v: "valid 7 days from issuedAt" },
              { k: "MEDIUM", v: "valid 24 hours" },
              { k: "HIGH", v: "valid 1 hour" },
            ]}
          />
          <p>
            Expiry is the whole point: a contract reading <code>isAllowed</code> never pays on a stale verdict, and a watcher re-screen refreshes the attestation before a watched LOW
            address runs out. <code>attestation.validUntil</code> always equals <code>typedData.message.validUntil</code>.
          </p>
        </>
      ),
    },
    {
      id: "isallowed",
      title: "isAllowed on-chain",
      body: (
        <>
          <Code lang="solidity" code={ONCHAIN} />
          <p>
            <code>tierOf</code> returns the raw stored tier; callers must check <code>validUntil</code> themselves. <code>isAllowed</code> folds the three conditions into one call and
            is what <code>GuardedTreasury</code> uses. UNKNOWN (never attested, or revoked) never passes.
          </p>
          <p>
            Registry on Arc mainnet: <Addr>0x… (unset)</Addr> <Status kind="pending">pending deploy</Status>. Until it is deployed, <code>verifyingContract</code> in the domain is
            the zero address and <code>registryTx</code> stays <code>null</code>. The live address will be published at <a href="/api/v1/health" target="_blank" rel="noopener noreferrer">/api/v1/health</a>.
          </p>
        </>
      ),
    },
    {
      id: "verify-offline",
      title: "Verify offline",
      body: (
        <>
          <Code lang="ts" code={VERIFY_SDK} />
          <p>
            The MCP tool <code>verify_attestation</code> does the same check and returns the decoded subject, tier, score, decisionHash and validUntil. Three steps make a full audit:
          </p>
          <ol>
            <li>Recover the signer from <code>typedData</code> + <code>signature</code> and compare with the published attester.</li>
            <li>
              Call <code>tierOf(subject)</code> on the registry: the stored <code>decisionHash</code> must equal <code>typedData.message.decisionHash</code> (once the registry is
              live).
            </li>
            <li>
              Open <code>GET /api/v1/decision/:decisionId</code> (or <Link href="/ledger">/ledger</Link> → <code>/log/:id</code>): the payload hashes into the chain and its batch
              anchor tx is on Arc.
            </li>
          </ol>
        </>
      ),
    },
    {
      id: "anchoring",
      title: "Mirroring and anchoring",
      body: (
        <>
          <ul>
            <li>
              <strong>attest() is permissionless.</strong> The signature is the authority, so any relayer may submit it. With <code>SIGNER_MODE=local</code> the attester key sends
              the tx and pays USDC gas; with <code>SIGNER_MODE=circle</code> the Circle ops wallet relays it (Gas Station-sponsored when a mainnet policy is active) and falls back to
              local on any failure.
            </li>
            <li>
              <strong>Writes never block a verdict.</strong> The registry write is fired after the response; <code>registryTx</code> is updated in the store when it lands and shows
              on the attestation endpoint and in webhooks.
            </li>
            <li>
              <strong>Duplicate protection.</strong> The contract rejects a second write of the same <code>decisionHash</code> (<code>DecisionHashUsed</code>), so a relay timeout
              followed by a local retry is safe.
            </li>
            <li>
              <strong>anchorRoot() is onlyAttester.</strong> Every <code>ANCHOR_EVERY_N</code> (default 50) ledger entries, their Merkle root is written with the sequence range and
              an <code>ANCHOR</code> entry is appended. See <Link href="/docs/ledger-reports">Ledger & reports</Link>.
            </li>
          </ul>
        </>
      ),
    },
  ],
};
