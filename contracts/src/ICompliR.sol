// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICompliR — on-chain counterparty-risk tier lookup
/// @notice Minimal read interface every integrator needs. Copy this file (or install the CompliR
///         SDK npm package) and call `isAllowed` before releasing funds:
///
///         ```solidity
///         require(ICompliR(registry).isAllowed(payee, ICompliR.Tier.MEDIUM), "CompliR: payee tier too high");
///         ```
///
///         Tiers are written by the CompliR attester after an off-chain screening
///         (sanctions, USDC blacklist, 2-hop funder taint, …). Every attestation carries a
///         `decisionHash` that links back to the replayable decision log.
interface ICompliR {
    /// @dev Numeric values are part of the public ABI and mirrored in `src/lib/types.ts`
    ///      (`TIER_ONCHAIN`): UNKNOWN=0, LOW=1, MEDIUM=2, HIGH=3.
    enum Tier {
        UNKNOWN,
        LOW,
        MEDIUM,
        HIGH
    }

    /// @notice A new attestation was stored for `subject`.
    event Attested(address indexed subject, Tier tier, uint64 validUntil, bytes32 decisionHash);

    /// @notice `subject`'s tier differs from the previously stored one (also emitted on revoke).
    event TierChanged(address indexed subject, Tier from, Tier to);

    /// @notice A Merkle root of decision-log entries `[fromSeq, toSeq]` was anchored on-chain.
    event Anchored(bytes32 indexed root, uint256 fromSeq, uint256 toSeq);

    /// @notice Raw stored tier for `subject`. Callers MUST check `validUntil > block.timestamp`
    ///         themselves, or use `isAllowed`.
    /// @return tier         UNKNOWN when never attested or revoked.
    /// @return validUntil   Unix seconds; 0 when UNKNOWN.
    /// @return decisionHash keccak256 of the canonical decision JSON behind this tier.
    function tierOf(address subject) external view returns (Tier tier, uint64 validUntil, bytes32 decisionHash);

    /// @notice One-line integration helper.
    /// @return true iff `tier != UNKNOWN && tier <= maxTier && validUntil > block.timestamp`.
    function isAllowed(address subject, Tier maxTier) external view returns (bool);
}
