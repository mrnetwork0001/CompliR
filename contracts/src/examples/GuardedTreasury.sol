// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ICompliR} from "../ICompliR.sol";

/// @title GuardedTreasury — the one-line CompliR integration, as a complete example
/// @notice Holds an ERC-20 (USDC on Arc) and releases it only to payees whose CompliR tier is
///         LOW or MEDIUM and still valid. An agent *proposes* a payment, the contract *decides*.
///         Drop the `require` below into any existing treasury to get the same guarantee.
contract GuardedTreasury is Ownable {
    using SafeERC20 for IERC20;

    ICompliR public immutable compliR;
    IERC20 public immutable token;

    /// @notice Highest tier still allowed to receive funds (MEDIUM by default; HIGH is never paid).
    ICompliR.Tier public maxTier = ICompliR.Tier.MEDIUM;

    event Released(address indexed payee, uint256 amount, bytes32 decisionHash);
    event MaxTierChanged(ICompliR.Tier from, ICompliR.Tier to);

    constructor(address registry, address token_, address initialOwner) Ownable(initialOwner) {
        compliR = ICompliR(registry);
        token = IERC20(token_);
    }

    /// @notice Release `amount` of `token` to `payee` — only if CompliR clears the payee.
    function release(address payee, uint256 amount) external onlyOwner {
        // ── The CompliR integration. This is the whole thing. ──
        require(compliR.isAllowed(payee, maxTier), "CompliR: payee tier too high");

        (,, bytes32 decisionHash) = compliR.tierOf(payee);
        token.safeTransfer(payee, amount);
        emit Released(payee, amount, decisionHash);
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
