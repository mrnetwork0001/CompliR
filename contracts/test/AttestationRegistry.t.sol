// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {ICompliR} from "../src/ICompliR.sol";

contract AttestationRegistryTest is Test {
    // ─────────────────────────── EIP-712 parity with the TypeScript signer ───────────────────────────
    //
    // Hard-coded copies of the constants in /src/lib/attest/eip712.ts
    // (ATTESTATION_TYPE_STRING, ATTESTATION_DOMAIN_NAME, ATTESTATION_DOMAIN_VERSION). If either side
    // changes, `test_typehash_matchesTypeScriptSigner` / `test_domainSeparator_matchesManualDerivation`
    // must be updated together with the TS file.
    string internal constant TS_ATTESTATION_TYPE_STRING =
        "Attestation(address subject,uint8 tier,uint8 score,bytes32 decisionHash,uint64 issuedAt,uint64 validUntil)";
    string internal constant TS_DOMAIN_NAME = "CompliR";
    string internal constant TS_DOMAIN_VERSION = "1";
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ─────────────────────────── Fixtures ───────────────────────────

    AttestationRegistry internal registry;

    address internal owner = makeAddr("owner");
    uint256 internal attesterPk = 0xA11CE;
    address internal attester;
    uint256 internal strangerPk = 0xB0B;
    address internal stranger;
    address internal relayer = makeAddr("relayer");
    address internal subject = makeAddr("subject");

    uint64 internal constant T0 = 1_700_000_000;

    // Mirrors of the ICompliR events so `vm.expectEmit` can reference them.
    event Attested(address indexed subject, ICompliR.Tier tier, uint64 validUntil, bytes32 decisionHash);
    event TierChanged(address indexed subject, ICompliR.Tier from, ICompliR.Tier to);
    event Anchored(bytes32 indexed root, uint256 fromSeq, uint256 toSeq);
    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    function setUp() public {
        attester = vm.addr(attesterPk);
        stranger = vm.addr(strangerPk);
        vm.warp(T0);
        registry = new AttestationRegistry(owner, attester);
    }

    // ─────────────────────────── Helpers ───────────────────────────

    /// @dev Domain separator derived by hand (not via the contract) so the test proves the contract
    ///      uses exactly the fields/order the TS signer uses.
    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(TS_DOMAIN_NAME)),
                keccak256(bytes(TS_DOMAIN_VERSION)),
                block.chainid,
                address(registry)
            )
        );
    }

    /// @dev Digest derived by hand, exactly as the contract (and viem's hashTypedData) computes it.
    function _digest(
        address subject_,
        ICompliR.Tier tier,
        uint8 score,
        bytes32 decisionHash,
        uint64 issuedAt,
        uint64 validUntil
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(bytes(TS_ATTESTATION_TYPE_STRING)),
                subject_,
                uint8(tier),
                score,
                decisionHash,
                issuedAt,
                validUntil
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _sign(
        uint256 pk,
        address subject_,
        ICompliR.Tier tier,
        uint8 score,
        bytes32 decisionHash,
        uint64 issuedAt,
        uint64 validUntil
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _digest(subject_, tier, score, decisionHash, issuedAt, validUntil));
        return abi.encodePacked(r, s, v);
    }

    function _dh(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("decision", n));
    }

    /// @dev Attester-signed attestation for `subject`, relayed by `relayer`.
    function _attestSigned(ICompliR.Tier tier, uint8 score, bytes32 decisionHash, uint64 issuedAt, uint64 validUntil)
        internal
    {
        bytes memory sig = _sign(attesterPk, subject, tier, score, decisionHash, issuedAt, validUntil);
        vm.prank(relayer);
        registry.attest(subject, tier, score, decisionHash, issuedAt, validUntil, sig);
    }

    function _countTierChanged(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        bytes32 topic = keccak256("TierChanged(address,uint8,uint8)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) n++;
        }
    }

    // ─────────────────────────── EIP-712 parity ───────────────────────────

    function test_typehash_matchesTypeScriptSigner() public view {
        // keccak256 of the exact ATTESTATION_TYPE_STRING in src/lib/attest/eip712.ts
        assertEq(registry.ATTESTATION_TYPEHASH(), keccak256(bytes(TS_ATTESTATION_TYPE_STRING)));
        // Pinned literal (== viem keccak256(stringToHex(ATTESTATION_TYPE_STRING)) in eip712.ts).
        // Changing the type string on either side without updating the other breaks this.
        assertEq(registry.ATTESTATION_TYPEHASH(), 0x86d4b56447401a0aa7aea88cef207cd6ff21bb50dd72f46b5e5baccf75e854db);
    }

    function test_domainSeparator_matchesManualDerivation() public view {
        assertEq(registry.domainSeparator(), _domainSeparator());
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            registry.eip712Domain();
        assertEq(name, TS_DOMAIN_NAME);
        assertEq(version, TS_DOMAIN_VERSION);
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(registry));
    }

    /// @dev End-to-end parity with viem. The digest and signature below were produced by
    ///      `hashTypedData` / `signTypedData` (viem 2.57) with the same types/domain as eip712.ts:
    ///        domain  = { name:"CompliR", version:"1", chainId:5042002, verifyingContract:0x…0C0111 }
    ///        message = { subject:0x11…11, tier:2, score:42, decisionHash:0xab…ab, issuedAt:1700000000, validUntil:1700086400 }
    ///        signer  = privateKey 0xA11CE (= attesterPk) → 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7
    function test_viemSignedAttestation_isAcceptedOnArcChainId() public {
        address registryAt = 0x00000000000000000000000000000000000C0111;
        vm.chainId(5042002);
        deployCodeTo("AttestationRegistry.sol:AttestationRegistry", abi.encode(owner, attester), registryAt);
        AttestationRegistry reg = AttestationRegistry(registryAt);
        assertEq(attester, 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7);

        address subj = 0x1111111111111111111111111111111111111111;
        bytes32 dh = 0xabababababababababababababababababababababababababababababababab;
        bytes32 viemDigest = 0x157bd949d35bd284f6c37bb3483dd82dbec1280ff5e8f9d9eab29a506ebb4ae2;
        bytes memory viemSig =
            hex"04734e3937212d7b4b5656c8b413b47dbb8e7dd7c266fb86f19c68078825e3193e4cf38921a95339c7af920f4a715af13300ac8a5a407701b1e57ecc551118461b";

        assertEq(reg.hashAttestation(subj, ICompliR.Tier.MEDIUM, 42, dh, 1_700_000_000, 1_700_086_400), viemDigest);

        vm.prank(relayer);
        reg.attest(subj, ICompliR.Tier.MEDIUM, 42, dh, 1_700_000_000, 1_700_086_400, viemSig);
        assertTrue(reg.isAllowed(subj, ICompliR.Tier.MEDIUM));
        assertFalse(reg.isAllowed(subj, ICompliR.Tier.LOW));
    }

    function test_hashAttestation_matchesManualDigest() public view {
        bytes32 expected = _digest(subject, ICompliR.Tier.MEDIUM, 42, _dh(7), T0, T0 + 86_400);
        assertEq(registry.hashAttestation(subject, ICompliR.Tier.MEDIUM, 42, _dh(7), T0, T0 + 86_400), expected);
    }

    // ─────────────────────────── constructor ───────────────────────────

    function test_constructor_setsRoles() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.attester(), attester);
        assertFalse(registry.paused());
    }

    function test_constructor_rejectsZeroAttester() public {
        vm.expectRevert(AttestationRegistry.ZeroAddress.selector);
        new AttestationRegistry(owner, address(0));
    }

    // ─────────────────────────── attest (signed) ───────────────────────────

    function test_attest_storesRecordAndEmits() public {
        uint64 validUntil = T0 + 7 days;
        bytes memory sig = _sign(attesterPk, subject, ICompliR.Tier.LOW, 5, _dh(1), T0, validUntil);

        vm.expectEmit(true, false, false, true, address(registry));
        emit Attested(subject, ICompliR.Tier.LOW, validUntil, _dh(1));
        vm.expectEmit(true, false, false, true, address(registry));
        emit TierChanged(subject, ICompliR.Tier.UNKNOWN, ICompliR.Tier.LOW);

        vm.prank(relayer); // anyone can relay
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, validUntil, sig);

        (ICompliR.Tier tier, uint64 vu, bytes32 dh) = registry.tierOf(subject);
        assertEq(uint8(tier), uint8(ICompliR.Tier.LOW));
        assertEq(vu, validUntil);
        assertEq(dh, _dh(1));
        assertTrue(registry.usedDecisionHash(_dh(1)));

        AttestationRegistry.Record memory rec = registry.recordOf(subject);
        assertEq(rec.score, 5);
        assertEq(rec.issuedAt, T0);

        assertTrue(registry.isAllowed(subject, ICompliR.Tier.LOW));
        assertTrue(registry.isAllowed(subject, ICompliR.Tier.MEDIUM));
        assertTrue(registry.isAllowed(subject, ICompliR.Tier.HIGH));
    }

    function test_attest_replayRejected() public {
        bytes memory sig = _sign(attesterPk, subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days, sig);

        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.DecisionHashUsed.selector, _dh(1)));
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days, sig);
    }

    function test_attest_decisionHashCannotBeReusedForAnotherSubject() public {
        _attestSigned(ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);
        address other = makeAddr("other");
        bytes memory sig = _sign(attesterPk, other, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.DecisionHashUsed.selector, _dh(1)));
        registry.attest(other, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days, sig);
    }

    function test_attest_expiredRejected() public {
        uint64 validUntil = T0 - 1;
        bytes memory sig = _sign(attesterPk, subject, ICompliR.Tier.LOW, 5, _dh(1), T0 - 100, validUntil);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.Expired.selector, validUntil, uint256(T0)));
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(1), T0 - 100, validUntil, sig);

        // validUntil == now is also expired (strict >)
        sig = _sign(attesterPk, subject, ICompliR.Tier.LOW, 5, _dh(2), T0 - 100, T0);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.Expired.selector, T0, uint256(T0)));
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(2), T0 - 100, T0, sig);
    }

    function test_attest_wrongSignerRejected() public {
        bytes memory sig = _sign(strangerPk, subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidSigner.selector, stranger, attester));
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days, sig);
    }

    function test_attest_tamperedPayloadRejected() public {
        // Signed for LOW, submitted as MEDIUM: recovery yields a different address.
        bytes memory sig = _sign(attesterPk, subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);
        vm.expectPartialRevert(AttestationRegistry.InvalidSigner.selector);
        registry.attest(subject, ICompliR.Tier.MEDIUM, 5, _dh(1), T0, T0 + 1 days, sig);
    }

    function test_attest_malformedSignatureRejected() public {
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 3));
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days, hex"010203");
    }

    function test_attest_signatureFromOldAttesterRejectedAfterRotation() public {
        bytes memory sig = _sign(attesterPk, subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);
        vm.prank(owner);
        registry.setAttester(stranger);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidSigner.selector, attester, stranger));
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days, sig);
    }

    // ─────────────────────────── TierChanged semantics ───────────────────────────

    function test_tierChanged_emittedOnlyWhenTierDiffers() public {
        _attestSigned(ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 7 days);

        // Same tier, fresh decision: Attested yes, TierChanged no.
        vm.recordLogs();
        _attestSigned(ICompliR.Tier.LOW, 9, _dh(2), T0 + 1, T0 + 7 days);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only Attested expected");
        assertEq(_countTierChanged(logs), 0);

        // Different tier: TierChanged(LOW -> HIGH).
        vm.expectEmit(true, false, false, true, address(registry));
        emit TierChanged(subject, ICompliR.Tier.LOW, ICompliR.Tier.HIGH);
        _attestSigned(ICompliR.Tier.HIGH, 90, _dh(3), T0 + 2, T0 + 1 hours);

        assertFalse(registry.isAllowed(subject, ICompliR.Tier.MEDIUM));
        assertTrue(registry.isAllowed(subject, ICompliR.Tier.HIGH));
    }

    function test_attest_staleIssuedAtRejected() public {
        _attestSigned(ICompliR.Tier.LOW, 5, _dh(1), T0 + 10, T0 + 7 days);
        bytes memory sig = _sign(attesterPk, subject, ICompliR.Tier.HIGH, 95, _dh(2), T0 + 5, T0 + 7 days);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.StaleAttestation.selector, T0 + 5, T0 + 10));
        registry.attest(subject, ICompliR.Tier.HIGH, 95, _dh(2), T0 + 5, T0 + 7 days, sig);
    }

    function test_isAllowed_failsClosedAfterExpiry() public {
        _attestSigned(ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 100);
        assertTrue(registry.isAllowed(subject, ICompliR.Tier.LOW));
        vm.warp(T0 + 100);
        assertFalse(registry.isAllowed(subject, ICompliR.Tier.LOW), "validUntil == now must be expired");
        // tierOf still returns the raw record; callers must check validUntil.
        (ICompliR.Tier tier,,) = registry.tierOf(subject);
        assertEq(uint8(tier), uint8(ICompliR.Tier.LOW));
    }

    function test_isAllowed_falseForUnknown() public view {
        assertFalse(registry.isAllowed(subject, ICompliR.Tier.HIGH));
    }

    // ─────────────────────────── attestDirect validation ───────────────────────────

    function test_attestDirect_onlyAttester() public {
        vm.prank(stranger);
        vm.expectRevert(AttestationRegistry.NotAttester.selector);
        registry.attestDirect(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);

        vm.prank(owner); // owner is not the attester either
        vm.expectRevert(AttestationRegistry.NotAttester.selector);
        registry.attestDirect(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);

        vm.prank(attester);
        registry.attestDirect(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);
        assertTrue(registry.isAllowed(subject, ICompliR.Tier.LOW));
    }

    function test_attestDirect_inputValidation() public {
        vm.startPrank(attester);

        vm.expectRevert(AttestationRegistry.ZeroAddress.selector);
        registry.attestDirect(address(0), ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);

        vm.expectRevert(AttestationRegistry.InvalidTier.selector);
        registry.attestDirect(subject, ICompliR.Tier.UNKNOWN, 5, _dh(1), T0, T0 + 1 days);

        vm.expectRevert(AttestationRegistry.InvalidScore.selector);
        registry.attestDirect(subject, ICompliR.Tier.LOW, 101, _dh(1), T0, T0 + 1 days);

        vm.expectRevert(AttestationRegistry.InvalidDecisionHash.selector);
        registry.attestDirect(subject, ICompliR.Tier.LOW, 5, bytes32(0), T0, T0 + 1 days);

        vm.expectRevert(
            abi.encodeWithSelector(
                AttestationRegistry.InvalidValidity.selector, uint64(T0 + 2 days), uint64(T0 + 1 days)
            )
        );
        registry.attestDirect(subject, ICompliR.Tier.LOW, 5, _dh(1), T0 + 2 days, T0 + 1 days);

        vm.stopPrank();
    }

    // ─────────────────────────── attestBatch ───────────────────────────

    function test_attestBatch_writesAll() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        address c = makeAddr("c");
        AttestationRegistry.AttestationInput[] memory items = new AttestationRegistry.AttestationInput[](3);
        items[0] = AttestationRegistry.AttestationInput(a, ICompliR.Tier.LOW, 1, _dh(1), T0, T0 + 7 days);
        items[1] = AttestationRegistry.AttestationInput(b, ICompliR.Tier.MEDIUM, 40, _dh(2), T0, T0 + 1 days);
        items[2] = AttestationRegistry.AttestationInput(c, ICompliR.Tier.HIGH, 99, _dh(3), T0, T0 + 1 hours);

        vm.prank(attester);
        registry.attestBatch(items);

        assertTrue(registry.isAllowed(a, ICompliR.Tier.LOW));
        assertTrue(registry.isAllowed(b, ICompliR.Tier.MEDIUM));
        assertFalse(registry.isAllowed(b, ICompliR.Tier.LOW));
        assertTrue(registry.isAllowed(c, ICompliR.Tier.HIGH));
        assertFalse(registry.isAllowed(c, ICompliR.Tier.MEDIUM));
        assertEq(registry.recordOf(c).score, 99);
    }

    function test_attestBatch_isAtomic() public {
        address a = makeAddr("a");
        AttestationRegistry.AttestationInput[] memory items = new AttestationRegistry.AttestationInput[](2);
        items[0] = AttestationRegistry.AttestationInput(a, ICompliR.Tier.LOW, 1, _dh(1), T0, T0 + 7 days);
        items[1] = AttestationRegistry.AttestationInput(a, ICompliR.Tier.LOW, 1, _dh(1), T0, T0 + 7 days); // replay

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.DecisionHashUsed.selector, _dh(1)));
        registry.attestBatch(items);

        assertFalse(registry.isAllowed(a, ICompliR.Tier.HIGH));
        assertFalse(registry.usedDecisionHash(_dh(1)));
    }

    function test_attestBatch_onlyAttester() public {
        AttestationRegistry.AttestationInput[] memory items = new AttestationRegistry.AttestationInput[](0);
        vm.prank(stranger);
        vm.expectRevert(AttestationRegistry.NotAttester.selector);
        registry.attestBatch(items);
    }

    // ─────────────────────────── pause ───────────────────────────

    function test_pause_blocksAllWritesAndKeepsReads() public {
        _attestSigned(ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 7 days);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.pause();

        vm.prank(owner);
        registry.pause();
        assertTrue(registry.paused());

        bytes memory sig = _sign(attesterPk, subject, ICompliR.Tier.LOW, 5, _dh(2), T0 + 1, T0 + 7 days);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(2), T0 + 1, T0 + 7 days, sig);

        vm.prank(attester);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.attestDirect(subject, ICompliR.Tier.LOW, 5, _dh(2), T0 + 1, T0 + 7 days);

        AttestationRegistry.AttestationInput[] memory items = new AttestationRegistry.AttestationInput[](0);
        vm.prank(attester);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.attestBatch(items);

        vm.prank(attester);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.anchorRoot(bytes32(uint256(1)), 0, 1);

        vm.prank(owner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.revoke(subject);

        // Reads keep working so integrators fail closed on expiry, not on pause.
        assertTrue(registry.isAllowed(subject, ICompliR.Tier.LOW));

        vm.prank(owner);
        registry.unpause();
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(2), T0 + 1, T0 + 7 days, sig);
        assertEq(registry.recordOf(subject).decisionHash, _dh(2));
    }

    // ─────────────────────────── revoke ───────────────────────────

    function test_revoke_clearsTierAndEmits() public {
        _attestSigned(ICompliR.Tier.MEDIUM, 40, _dh(1), T0, T0 + 1 days);

        vm.expectEmit(true, false, false, true, address(registry));
        emit TierChanged(subject, ICompliR.Tier.MEDIUM, ICompliR.Tier.UNKNOWN);
        vm.prank(owner);
        registry.revoke(subject);

        (ICompliR.Tier tier, uint64 vu, bytes32 dh) = registry.tierOf(subject);
        assertEq(uint8(tier), uint8(ICompliR.Tier.UNKNOWN));
        assertEq(vu, 0);
        assertEq(dh, bytes32(0));
        assertFalse(registry.isAllowed(subject, ICompliR.Tier.HIGH));
        // issuedAt is kept as a watermark
        assertEq(registry.recordOf(subject).issuedAt, T0);
    }

    function test_revoke_onlyOwnerAndOnlyWhenAttested() public {
        vm.prank(owner);
        vm.expectRevert(AttestationRegistry.NothingToRevoke.selector);
        registry.revoke(subject);

        _attestSigned(ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attester));
        registry.revoke(subject);
    }

    function test_revoke_oldSignatureCannotResurrect() public {
        // Signature issued before the revoked record's issuedAt is stale.
        bytes memory oldSig = _sign(attesterPk, subject, ICompliR.Tier.LOW, 5, _dh(2), T0 - 1, T0 + 7 days);
        _attestSigned(ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 7 days);
        vm.prank(owner);
        registry.revoke(subject);

        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.StaleAttestation.selector, T0 - 1, T0));
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(2), T0 - 1, T0 + 7 days, oldSig);

        // A fresh attestation re-enables the subject.
        _attestSigned(ICompliR.Tier.LOW, 5, _dh(3), T0 + 1, T0 + 7 days);
        assertTrue(registry.isAllowed(subject, ICompliR.Tier.LOW));
    }

    // ─────────────────────────── anchorRoot ───────────────────────────

    function test_anchorRoot_storesAndEmits() public {
        bytes32 root = keccak256("root-1");
        vm.expectEmit(true, false, false, true, address(registry));
        emit Anchored(root, 1, 250);
        vm.prank(attester);
        registry.anchorRoot(root, 1, 250);

        (uint256 fromSeq, uint256 toSeq, uint64 anchoredAt) = registry.anchors(root);
        assertEq(fromSeq, 1);
        assertEq(toSeq, 250);
        assertEq(anchoredAt, T0);
        assertEq(registry.rootCount(), 1);
        assertEq(registry.roots(0), root);
    }

    function test_anchorRoot_validation() public {
        bytes32 root = keccak256("root-1");

        vm.prank(stranger);
        vm.expectRevert(AttestationRegistry.NotAttester.selector);
        registry.anchorRoot(root, 0, 1);

        vm.startPrank(attester);
        vm.expectRevert(AttestationRegistry.InvalidRoot.selector);
        registry.anchorRoot(bytes32(0), 0, 1);

        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.InvalidSeqRange.selector, 5, 4));
        registry.anchorRoot(root, 5, 4);

        registry.anchorRoot(root, 5, 5); // single-entry range is fine
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.RootAlreadyAnchored.selector, root));
        registry.anchorRoot(root, 6, 7);
        vm.stopPrank();
    }

    // ─────────────────────────── setAttester / ownership ───────────────────────────

    function test_setAttester_rotatesHotKey() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit AttesterChanged(attester, stranger);
        vm.prank(owner);
        registry.setAttester(stranger);
        assertEq(registry.attester(), stranger);

        vm.prank(attester);
        vm.expectRevert(AttestationRegistry.NotAttester.selector);
        registry.attestDirect(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);

        bytes memory sig = _sign(strangerPk, subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days);
        registry.attest(subject, ICompliR.Tier.LOW, 5, _dh(1), T0, T0 + 1 days, sig);
        assertTrue(registry.isAllowed(subject, ICompliR.Tier.LOW));
    }

    function test_setAttester_validation() public {
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attester));
        registry.setAttester(stranger);

        vm.prank(owner);
        vm.expectRevert(AttestationRegistry.ZeroAddress.selector);
        registry.setAttester(address(0));
    }

    function test_ownership_isTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        registry.transferOwnership(newOwner);
        assertEq(registry.owner(), owner, "owner unchanged until accepted");
        assertEq(registry.pendingOwner(), newOwner);

        vm.prank(newOwner);
        registry.acceptOwnership();
        assertEq(registry.owner(), newOwner);

        vm.prank(newOwner);
        registry.pause();
        assertTrue(registry.paused());
    }

    // ─────────────────────────── fuzz ───────────────────────────

    function testFuzz_attest_roundTrip(
        address subj,
        uint8 tierRaw,
        uint8 score,
        bytes32 dh,
        uint64 issuedAt,
        uint64 ttl
    ) public {
        vm.assume(subj != address(0) && dh != bytes32(0));
        tierRaw = uint8(bound(tierRaw, 1, 3));
        score = uint8(bound(score, 0, 100));
        ttl = uint64(bound(ttl, 1, 365 days));
        issuedAt = uint64(bound(issuedAt, 0, T0));
        uint64 validUntil = T0 + ttl;
        ICompliR.Tier tier = ICompliR.Tier(tierRaw);

        bytes memory sig = _sign(attesterPk, subj, tier, score, dh, issuedAt, validUntil);
        registry.attest(subj, tier, score, dh, issuedAt, validUntil, sig);

        (ICompliR.Tier t, uint64 vu, bytes32 h) = registry.tierOf(subj);
        assertEq(uint8(t), tierRaw);
        assertEq(vu, validUntil);
        assertEq(h, dh);
        assertTrue(registry.isAllowed(subj, tier));
    }
}
