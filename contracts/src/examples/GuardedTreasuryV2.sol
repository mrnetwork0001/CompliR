// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ICompliR} from "../ICompliR.sol";

/// @dev The one extra read v2 needs beyond `ICompliR`: the stored record including its decisionHash.
///      Shape matches `AttestationRegistry.Record` / `recordOf(address)`.
interface ICompliRRecord {
    struct Record {
        ICompliR.Tier tier;
        uint8 score;
        uint64 issuedAt;
        uint64 validUntil;
        bytes32 decisionHash;
    }

    function recordOf(address subject) external view returns (Record memory);
}

/// @title GuardedTreasuryV2 — proof-of-screening on every payment
/// @notice v1 (`GuardedTreasury`) only asks the registry "is this payee allowed right now?". v2 adds
///         `releaseWithProof`: the caller names the exact verdict (its `decisionHash`) it is paying against,
///         and the contract checks that this is the verdict currently stored on the registry for the payee.
///         A payment therefore carries a binding, replayable link to the screening it was approved under —
///         if the registry has moved on (re-screen, revoke) since the agent decided, the release reverts
///         instead of paying under a verdict nobody looked at.
///
///         `release(payee, amount)` is kept for compatibility (same semantics as v1).
contract GuardedTreasuryV2 is Ownable2Step {
    using SafeERC20 for IERC20;

    ICompliR public immutable compliR;
    IERC20 public immutable token;

    /// @notice Highest tier still allowed to receive funds (MEDIUM by default; HIGH is never paid).
    ICompliR.Tier public maxTier = ICompliR.Tier.MEDIUM;

    event Released(address indexed payee, uint256 amount, bytes32 decisionHash);
    event ReleasedWithProof(address indexed payee, uint256 amount, bytes32 indexed decisionHash, ICompliR.Tier tier);
    event MaxTierChanged(ICompliR.Tier from, ICompliR.Tier to);

    constructor(address registry, address token_, address initialOwner) Ownable(initialOwner) {
        require(registry != address(0) && token_ != address(0), "GuardedTreasury: zero address");
        compliR = ICompliR(registry);
        token = IERC20(token_);
    }

    /// @notice v1-compatible release: pays if the payee's current tier is allowed.
    function release(address payee, uint256 amount) external onlyOwner {
        require(compliR.isAllowed(payee, maxTier), "CompliR: payee tier too high");
        (,, bytes32 decisionHash) = compliR.tierOf(payee);
        token.safeTransfer(payee, amount);
        emit Released(payee, amount, decisionHash);
    }

    /// @notice Release `amount` to `payee` against a specific CompliR verdict.
    /// @param decisionHash keccak256 of the canonical decision JSON (the verdict's `decisionHash`); must equal
    ///        the hash the registry currently stores for `payee`.
    function releaseWithProof(address payee, uint256 amount, bytes32 decisionHash) external onlyOwner {
        require(decisionHash != bytes32(0), "CompliR: empty decisionHash");
        require(compliR.isAllowed(payee, maxTier), "CompliR: payee tier too high");
        ICompliRRecord.Record memory r = ICompliRRecord(address(compliR)).recordOf(payee);
        require(r.decisionHash == decisionHash, "CompliR: decisionHash mismatch");
        token.safeTransfer(payee, amount);
        emit ReleasedWithProof(payee, amount, decisionHash, r.tier);
    }

    /// @notice Tighten (or loosen) the policy; e.g. LOW-only during an incident.
    function setMaxTier(ICompliR.Tier newMax) external onlyOwner {
        require(newMax != ICompliR.Tier.UNKNOWN, "GuardedTreasury: UNKNOWN never pays");
        emit MaxTierChanged(maxTier, newMax);
        maxTier = newMax;
    }

    /// @notice Owner can always pull funds back (this is a demo, not a vault).
    function withdraw(address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}
