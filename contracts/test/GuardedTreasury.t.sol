// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {ICompliR} from "../src/ICompliR.sol";
import {GuardedTreasury} from "../src/examples/GuardedTreasury.sol";

/// @dev Stand-in for USDC (6 decimals) in tests.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract GuardedTreasuryTest is Test {
    AttestationRegistry internal registry;
    GuardedTreasury internal treasury;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("attester");
    address internal treasuryOwner = makeAddr("treasuryOwner");
    address internal payee = makeAddr("payee");

    uint64 internal constant T0 = 1_700_000_000;
    uint256 internal constant FUNDS = 1_000_000e6;
    uint256 internal constant AMOUNT = 250e6;

    event Released(address indexed payee, uint256 amount, bytes32 decisionHash);
    event MaxTierChanged(ICompliR.Tier from, ICompliR.Tier to);

    function setUp() public {
        vm.warp(T0);
        registry = new AttestationRegistry(owner, attester);
        usdc = new MockUSDC();
        treasury = new GuardedTreasury(address(registry), address(usdc), treasuryOwner);
        usdc.mint(address(treasury), FUNDS);
    }

    function _dh(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("decision", n));
    }

    function _attest(ICompliR.Tier tier, uint64 validUntil) internal {
        vm.prank(attester);
        registry.attestDirect(payee, tier, 10, _dh(uint256(uint8(tier))), T0, validUntil);
    }

    function _release() internal {
        vm.prank(treasuryOwner);
        treasury.release(payee, AMOUNT);
    }

    // ─────────────────────────── happy paths ───────────────────────────

    function test_release_passesForLow() public {
        _attest(ICompliR.Tier.LOW, T0 + 7 days);

        vm.expectEmit(true, false, false, true, address(treasury));
        emit Released(payee, AMOUNT, _dh(1));
        _release();

        assertEq(usdc.balanceOf(payee), AMOUNT);
        assertEq(usdc.balanceOf(address(treasury)), FUNDS - AMOUNT);
    }

    function test_release_passesForMedium() public {
        _attest(ICompliR.Tier.MEDIUM, T0 + 1 days);
        _release();
        assertEq(usdc.balanceOf(payee), AMOUNT);
    }

    // ─────────────────────────── blocked paths ───────────────────────────

    function test_release_revertsForHigh() public {
        _attest(ICompliR.Tier.HIGH, T0 + 1 hours);
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.release(payee, AMOUNT);
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_release_revertsForUnknown() public {
        // Never screened.
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.release(payee, AMOUNT);
    }

    function test_release_revertsAfterRevoke() public {
        _attest(ICompliR.Tier.LOW, T0 + 7 days);
        vm.prank(owner);
        registry.revoke(payee);

        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.release(payee, AMOUNT);
    }

    function test_release_revertsWhenExpired() public {
        _attest(ICompliR.Tier.LOW, T0 + 100);
        _release(); // fine while valid

        vm.warp(T0 + 100); // validUntil == now → expired (strict >)
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.release(payee, AMOUNT);
        assertEq(usdc.balanceOf(payee), AMOUNT, "only the first release went through");
    }

    function test_release_respectsTightenedMaxTier() public {
        _attest(ICompliR.Tier.MEDIUM, T0 + 1 days);

        vm.expectEmit(false, false, false, true, address(treasury));
        emit MaxTierChanged(ICompliR.Tier.MEDIUM, ICompliR.Tier.LOW);
        vm.prank(treasuryOwner);
        treasury.setMaxTier(ICompliR.Tier.LOW);

        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("CompliR: payee tier too high"));
        treasury.release(payee, AMOUNT);
    }

    function test_release_onlyOwner() public {
        _attest(ICompliR.Tier.LOW, T0 + 7 days);
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payee));
        treasury.release(payee, AMOUNT);
    }

    // ─────────────────────────── admin ───────────────────────────

    function test_setMaxTier_rejectsUnknown() public {
        vm.prank(treasuryOwner);
        vm.expectRevert(bytes("GuardedTreasury: UNKNOWN never pays"));
        treasury.setMaxTier(ICompliR.Tier.UNKNOWN);
    }

    function test_setMaxTier_onlyOwner() public {
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payee));
        treasury.setMaxTier(ICompliR.Tier.LOW);
    }

    function test_withdraw_bypassesScreeningForOwnerOnly() public {
        address vault = makeAddr("vault");
        vm.prank(treasuryOwner);
        treasury.withdraw(vault, AMOUNT);
        assertEq(usdc.balanceOf(vault), AMOUNT);

        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payee));
        treasury.withdraw(payee, AMOUNT);
    }

    function test_immutables() public view {
        assertEq(address(treasury.compliR()), address(registry));
        assertEq(address(treasury.token()), address(usdc));
        assertEq(uint8(treasury.maxTier()), uint8(ICompliR.Tier.MEDIUM));
        assertEq(treasury.owner(), treasuryOwner);
    }
}
