import Link from "next/link";
import { Code, Kv } from "../_components/Doc";
import type { DocPage } from "./types";

const IFACE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal read interface every integrator needs. Copy this file (contracts/src/ICompliR.sol).
interface ICompliR {
    enum Tier { UNKNOWN, LOW, MEDIUM, HIGH }          // numeric values are part of the ABI

    event Attested(address indexed subject, Tier tier, uint64 validUntil, bytes32 decisionHash);
    event TierChanged(address indexed subject, Tier from, Tier to);  // also on revoke
    event Anchored(bytes32 indexed root, uint256 fromSeq, uint256 toSeq);

    /// Raw stored tier. UNKNOWN when never attested or revoked; validUntil 0 then. Check validUntil yourself.
    function tierOf(address subject) external view returns (Tier tier, uint64 validUntil, bytes32 decisionHash);

    /// true iff tier != UNKNOWN && tier <= maxTier && validUntil > block.timestamp
    function isAllowed(address subject, Tier maxTier) external view returns (bool);
}`;

const ONE_LINE = `require(ICompliR(COMPLIR_REGISTRY).isAllowed(payee, ICompliR.Tier.MEDIUM), "CompliR: payee tier too high");`;

const TREASURY = `// contracts/src/examples/GuardedTreasury.sol — the one-line integration as a complete example
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICompliR} from "../ICompliR.sol";

contract GuardedTreasury is Ownable {
    using SafeERC20 for IERC20;

    ICompliR public immutable compliR;
    IERC20 public immutable token;                       // USDC on Arc: 0x3600…0000 (6 dp)
    ICompliR.Tier public maxTier = ICompliR.Tier.MEDIUM; // HIGH is never paid

    event Released(address indexed payee, uint256 amount, bytes32 decisionHash);
    event MaxTierChanged(ICompliR.Tier from, ICompliR.Tier to);

    constructor(address registry, address token_, address initialOwner) Ownable(initialOwner) {
        compliR = ICompliR(registry);
        token = IERC20(token_);
    }

    /// An agent proposes, the contract decides.
    function release(address payee, uint256 amount) external onlyOwner {
        require(compliR.isAllowed(payee, maxTier), "CompliR: payee tier too high");
        (,, bytes32 decisionHash) = compliR.tierOf(payee);
        token.safeTransfer(payee, amount);
        emit Released(payee, amount, decisionHash);
    }

    function setMaxTier(ICompliR.Tier newMax) external onlyOwner {
        require(newMax != ICompliR.Tier.UNKNOWN, "GuardedTreasury: UNKNOWN never pays");
        emit MaxTierChanged(maxTier, newMax);
        maxTier = newMax;
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}`;

const FORGE = `cd contracts
forge build && forge test -vv            # 45 tests, incl. typehash parity with the TypeScript signer
forge build && node scripts/export-abi.mjs   # → src/lib/contracts/{registryAbi,guardedTreasuryAbi}.ts`;

export const solidity: DocPage = {
  slug: "solidity",
  title: "Solidity",
  description: "ICompliR: the read interface, the one-line require, and GuardedTreasury as a complete reference integrator.",
  lead: (
    <>
      <strong>On-chain, CompliR is one interface and one <code>require</code>.</strong> <code>AttestationRegistry</code> stores the latest tier per address with its expiry and the
      decision hash; your contract asks <code>isAllowed</code> before it moves funds. The registry is pending deploy on Arc mainnet; the code below is what it will answer.
    </>
  ),
  sections: [
    {
      id: "interface",
      title: "ICompliR",
      body: (
        <>
          <Code lang="solidity" code={IFACE} />
          <Kv
            rows={[
              { k: "Tier values", v: "UNKNOWN 0 · LOW 1 · MEDIUM 2 · HIGH 3 — mirrored in src/lib/types.ts TIER_ONCHAIN" },
              { k: "decisionHash", v: "keccak256 of the canonical decision JSON; the same value sits in the signed attestation and the ledger entry" },
              { k: "Registry", v: "AttestationRegistry.sol: Ownable2Step + Pausable, attester role, EIP-712 attest (permissionless, signature is the authority), attestDirect / attestBatch (attester), revoke, anchorRoot (onlyAttester)" },
            ]}
          />
        </>
      ),
    },
    {
      id: "one-line",
      title: "The one-line integration",
      body: (
        <>
          <Code lang="solidity" code={ONE_LINE} />
          <p>
            That is the whole integration. It fails closed: an address that was never screened is UNKNOWN, an attestation past <code>validUntil</code> is stale, and both revert
            before any transfer. Pair it with a watch so a tier change refreshes the registry before your next payout, or read <code>tierOf</code> and apply your own rule.
          </p>
        </>
      ),
    },
    {
      id: "treasury",
      title: "GuardedTreasury example",
      body: (
        <>
          <Code lang="solidity" code={TREASURY} />
          <p>
            This is the contract behind <Link href="/docs/guarded-payouts">Guarded payouts</Link>. Deployment, funding and the Foundry scripts are in <code>contracts/README.md</code>;
            gas on Arc is USDC and the broadcaster needs a USDC balance.
          </p>
        </>
      ),
    },
    {
      id: "develop",
      title: "Develop",
      body: (
        <>
          <Code lang="sh" code={FORGE} />
          <p>
            Dependencies are vendored (<code>forge-std</code>, OpenZeppelin 5.4.0); no submodules. <code>evm_version = paris</code> keeps the bytecode runnable on any post-Merge
            EVM until Arc&apos;s fork is pinned. Verified deploy addresses will appear on <Link href="/docs">Welcome</Link> and at <code>/api/v1/health</code>.
          </p>
        </>
      ),
    },
  ],
};
