// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {ICompliR} from "../src/ICompliR.sol";
import {GuardedTreasuryV2} from "../src/examples/GuardedTreasuryV2.sol";

contract MockUSDC2 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract GuardedTreasuryV2Test is Test {
    AttestationRegistry internal registry;
    GuardedTreasuryV2 internal treasury;
    MockUSDC2 internal usdc;

    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("attester");
    address internal treasuryOwner = makeAddr("treasuryOwner");
    address internal payee = makeAddr("payee");

    uint64 internal constant T0 = 1_700_000_000;
    uint256 internal constant FUNDS = 1_000_000e6;
    uint256 internal constant AMOUNT = 250e6;

    event Released(address indexed payee, uint256 amount, bytes32 decisionHash);
    event ReleasedWithProof(address indexed payee, uint256 amount, bytes32 indexed decisionHash, ICompliR.Tier tier);
    event MaxTierChanged(ICompliR.Tier from, ICompliR.Tier to);

    function setUp() public {
        vm.warp(T0);
        registry = new AttestationRegistry(owner, attester);
        usdc = new MockUSDC2();
        treasury = new GuardedTreasuryV2(address(registry), address(usdc), treasuryOwner);
        usdc.mint(address(treasury), FUNDS);
    }

    function _dh(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("decision", n));
    }

    function _attest(ICompliR.Tier tier, uint64 validUntil, uint256 n, uint64 issuedAt) internal {
        vm.prank(attester);
        registry.attestDirect(payee, tier, 10, _dh(n), issuedAt, validUntil);
    }

    // ─────────────────────────── releaseWithProof ───────────────────────────

    function test_releaseWithProof_passesWhenHashMatchesRegistry() public {
        _attest(ICompliR.Tier.LOW, T0 + 7 days, 1, T0);

        vm.expectEmit(true, true, false, true, address(treasury));
        emit ReleasedWithProof(payee, AMOUNT, _dh(1), ICompliR.Tier.LOW);
        vm.prank(treasuryOwner);
        treasury.releaseWithProof(payee, AMOUNT, _dh(1));

        assertEq(usdc.balanceOf(payee), AMOUNT);
        assertEq(usdc.balanceOf(address(treasury)), FUNDS - AMOUNT);
    }

    function test_releaseWithProof_emitsMediumTier() public {
        _attest(ICompliR.Tier.MEDIUM, T0 + 1 days, 2, T0);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit ReleasedWithProof(payee, AMOUNT, _dh(2), ICompliR.Tier.MEDIUM);
        vm.prank(treasuryOwner);
        treasury.releaseWithProof(payee, AMOUNT, _dh(2));
    }

    function test_releaseWithProof_revertsOnMismatchedDecisionHash() public {
        _attest(ICompliR.Tier.LOW, T0 + 7 days, 1, T0);
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: decisionHash mismatch"));
        treasury.releaseWithProof(payee, AMOUNT, _dh(99));
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_releaseWithProof_revertsWhenRegistryMovedOn() public {
        // The agent decided against verdict #1, but the payee was re-screened (#2) before release.
        _attest(ICompliR.Tier.LOW, T0 + 7 days, 1, T0);
        _attest(ICompliR.Tier.LOW, T0 + 7 days, 2, T0 + 1);
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: decisionHash mismatch"));
        treasury.releaseWithProof(payee, AMOUNT, _dh(1));
        // paying against the current verdict works
        vm.prank(treasuryOwner);
        treasury.releaseWithProof(payee, AMOUNT, _dh(2));
        assertEq(usdc.balanceOf(payee), AMOUNT);
    }

    function test_releaseWithProof_revertsForHighEvenWithMatchingHash() public {
        _attest(ICompliR.Tier.HIGH, T0 + 1 hours, 3, T0);
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.releaseWithProof(payee, AMOUNT, _dh(3));
    }

    function test_releaseWithProof_revertsForUnknownAndEmptyHash() public {
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: empty decisionHash"));
        treasury.releaseWithProof(payee, AMOUNT, bytes32(0));

        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.releaseWithProof(payee, AMOUNT, _dh(1));
    }

    function test_releaseWithProof_revertsAfterRevokeAndExpiry() public {
        _attest(ICompliR.Tier.LOW, T0 + 100, 1, T0);
        vm.warp(T0 + 100);
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.releaseWithProof(payee, AMOUNT, _dh(1));

        vm.warp(T0);
        vm.prank(owner);
        registry.revoke(payee);
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.releaseWithProof(payee, AMOUNT, _dh(1));
    }

    function test_releaseWithProof_onlyOwner() public {
        _attest(ICompliR.Tier.LOW, T0 + 7 days, 1, T0);
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payee));
        treasury.releaseWithProof(payee, AMOUNT, _dh(1));
    }

    function test_releaseWithProof_respectsTightenedMaxTier() public {
        _attest(ICompliR.Tier.MEDIUM, T0 + 1 days, 2, T0);
        vm.expectEmit(false, false, false, true, address(treasury));
        emit MaxTierChanged(ICompliR.Tier.MEDIUM, ICompliR.Tier.LOW);
        vm.prank(treasuryOwner);
        treasury.setMaxTier(ICompliR.Tier.LOW);

        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.releaseWithProof(payee, AMOUNT, _dh(2));
    }

    // ─────────────────────────── v1 compatibility ───────────────────────────

    function test_release_stillWorksLikeV1() public {
        _attest(ICompliR.Tier.LOW, T0 + 7 days, 1, T0);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit Released(payee, AMOUNT, _dh(1));
        vm.prank(treasuryOwner);
        treasury.release(payee, AMOUNT);
        assertEq(usdc.balanceOf(payee), AMOUNT);

        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payee));
        treasury.release(payee, AMOUNT);
    }

    function test_release_revertsForHigh() public {
        _attest(ICompliR.Tier.HIGH, T0 + 1 hours, 3, T0);
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.release(payee, AMOUNT);
    }

    // ─────────────────────────── admin ───────────────────────────

    function test_setMaxTier_rejectsUnknown() public {
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("GuardedTreasury: UNKNOWN never pays"));
        treasury.setMaxTier(ICompliR.Tier.UNKNOWN);
    }

    function test_withdraw_ownerOnly() public {
        address vault = makeAddr("vault");
        vm.prank(treasuryOwner);
        treasury.withdraw(vault, AMOUNT);
        assertEq(usdc.balanceOf(vault), AMOUNT);

        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payee));
        treasury.withdraw(payee, AMOUNT);
    }

    function test_ownable2Step() public {
        address next = makeAddr("next");
        vm.prank(treasuryOwner);
        treasury.transferOwnership(next);
        assertEq(treasury.owner(), treasuryOwner, "owner unchanged until accepted");
        assertEq(treasury.pendingOwner(), next);
        vm.prank(next);
        treasury.acceptOwnership();
        assertEq(treasury.owner(), next);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(bytes("GuardedTreasury: zero address"));
        new GuardedTreasuryV2(address(0), address(usdc), treasuryOwner);
    }

    function test_immutables() public view {
        assertEq(address(treasury.compliR()), address(registry));
        assertEq(address(treasury.token()), address(usdc));
        assertEq(uint8(treasury.maxTier()), uint8(ICompliR.Tier.MEDIUM));
        assertEq(treasury.owner(), treasuryOwner);
    }
}
