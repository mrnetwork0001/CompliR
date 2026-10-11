// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ICompliR} from "./ICompliR.sol";

/// @title AttestationRegistry — CompliR counterparty-risk attestations on Arc
/// @notice Stores the latest risk tier per address, signed by the CompliR attester key.
///
/// ## Roles
/// - **owner** (`Ownable2Step`): rotates the attester, pauses writes, revokes tiers. Cold key.
/// - **attester**: hot key held by the CompliR service. Signs EIP-712 attestations and may
///   write directly (`attestDirect` / `attestBatch`) and anchor decision-log roots.
///
/// ## Write paths
/// - `attest(...)` — permissionless relay of an attester-signed EIP-712 message. Gas can be paid
///   by anyone (Circle Paymaster / Gas Station in USDC), so webhook-triggered writes never need
///   a gas token in the attester wallet.
/// - `attestDirect(...)` / `attestBatch(...)` — attester-only, no signature; cheapest path for
///   the long-running watcher.
///
/// ## Integrating from a treasury contract (one line)
/// ```solidity
/// require(ICompliR(registry).isAllowed(payee, ICompliR.Tier.MEDIUM), "CompliR: payee tier too high");
/// ```
/// `isAllowed` is false for UNKNOWN (never screened / revoked), for tiers above `maxTier`, and
/// once `validUntil` has passed — stale verdicts fail closed. See `examples/GuardedTreasury.sol`.
///
/// ## EIP-712
/// Domain: `name = "CompliR"`, `version = "1"`, `chainId`, `verifyingContract = this`.
/// Type:   `Attestation(address subject,uint8 tier,uint8 score,bytes32 decisionHash,uint64 issuedAt,uint64 validUntil)`
/// The TypeScript signer (`src/lib/attest/eip712.ts`) must match this byte-for-byte.
contract AttestationRegistry is ICompliR, Ownable2Step, Pausable, EIP712 {
    // ───────────────────────────── Types ─────────────────────────────

    /// @dev Packed into two storage slots: (tier,score,issuedAt,validUntil) + decisionHash.
    struct Record {
        Tier tier; // 1 byte
        uint8 score; // 1 byte, 0–100
        uint64 issuedAt; // 8 bytes, monotonic watermark per subject
        uint64 validUntil; // 8 bytes
        bytes32 decisionHash; // slot 2
    }

    /// @notice Calldata shape for `attestBatch`. Field order matches the EIP-712 struct.
    struct AttestationInput {
        address subject;
        Tier tier;
        uint8 score;
        bytes32 decisionHash;
        uint64 issuedAt;
        uint64 validUntil;
    }

    struct Anchor {
        uint256 fromSeq;
        uint256 toSeq;
        uint64 anchoredAt;
    }

    // ───────────────────────────── Constants ─────────────────────────────

    /// @notice keccak256 of the EIP-712 type string. Exposed so off-chain code can assert parity.
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address subject,uint8 tier,uint8 score,bytes32 decisionHash,uint64 issuedAt,uint64 validUntil)"
    );

    // ───────────────────────────── Storage ─────────────────────────────

    /// @notice Hot key allowed to sign / write attestations and anchor roots.
    address public attester;

    mapping(address subject => Record) private _records;

    /// @notice Replay protection: every decisionHash may be written exactly once.
    mapping(bytes32 decisionHash => bool) public usedDecisionHash;

    /// @notice Anchored Merkle roots in anchoring order.
    bytes32[] public roots;

    /// @notice Sequence range covered by an anchored root (anchoredAt == 0 ⇒ not anchored).
    mapping(bytes32 root => Anchor) public anchors;

    // ───────────────────────────── Events / errors ─────────────────────────────

    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    error NotAttester();
    error ZeroAddress();
    error InvalidTier();
    error InvalidScore();
    error InvalidDecisionHash();
    error Expired(uint64 validUntil, uint256 nowTs);
    error InvalidValidity(uint64 issuedAt, uint64 validUntil);
    error StaleAttestation(uint64 issuedAt, uint64 currentIssuedAt);
    error DecisionHashUsed(bytes32 decisionHash);
    error InvalidSigner(address recovered, address expected);
    error NothingToRevoke();
    error InvalidRoot();
    error InvalidSeqRange(uint256 fromSeq, uint256 toSeq);
    error RootAlreadyAnchored(bytes32 root);

    // ───────────────────────────── Modifiers ─────────────────────────────

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester();
        _;
    }

    // ───────────────────────────── Constructor ─────────────────────────────

    /// @param initialOwner    Admin (cold) key. Becomes owner immediately (no 2-step on deploy).
    /// @param initialAttester Hot key of the CompliR service.
    constructor(address initialOwner, address initialAttester) Ownable(initialOwner) EIP712("CompliR", "1") {
        if (initialAttester == address(0)) revert ZeroAddress();
        attester = initialAttester;
        emit AttesterChanged(address(0), initialAttester);
    }

    // ───────────────────────────── Views (ICompliR) ─────────────────────────────

    /// @inheritdoc ICompliR
    function tierOf(address subject) external view returns (Tier tier, uint64 validUntil, bytes32 decisionHash) {
        Record storage r = _records[subject];
        return (r.tier, r.validUntil, r.decisionHash);
    }

    /// @inheritdoc ICompliR
    function isAllowed(address subject, Tier maxTier) external view returns (bool) {
        Record storage r = _records[subject];
        // forge-lint: disable-next-line(block-timestamp)
        return r.tier != Tier.UNKNOWN && r.tier <= maxTier && r.validUntil > block.timestamp;
    }

    /// @notice Full stored record (adds `score` and `issuedAt` to `tierOf`).
    function recordOf(address subject) external view returns (Record memory) {
        return _records[subject];
    }

    /// @notice Number of anchored roots.
    function rootCount() external view returns (uint256) {
        return roots.length;
    }

    /// @notice EIP-712 digest the attester must sign for `attest`. Handy for tests and the TS signer.
    function hashAttestation(
        address subject,
        Tier tier,
        uint8 score,
        bytes32 decisionHash,
        uint64 issuedAt,
        uint64 validUntil
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(ATTESTATION_TYPEHASH, subject, tier, score, decisionHash, issuedAt, validUntil))
        );
    }

    /// @notice Current EIP-712 domain separator.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ───────────────────────────── Writes: attestations ─────────────────────────────

    /// @notice Relay an attester-signed attestation. Callable by anyone; the signature is the authority.
    /// @param signature 65-byte ECDSA signature by `attester` over `hashAttestation(...)`.
    function attest(
        address subject,
        Tier tier,
        uint8 score,
        bytes32 decisionHash,
        uint64 issuedAt,
        uint64 validUntil,
        bytes calldata signature
    ) external whenNotPaused {
        bytes32 digest = hashAttestation(subject, tier, score, decisionHash, issuedAt, validUntil);
        address signer = ECDSA.recover(digest, signature);
        if (signer != attester) revert InvalidSigner(signer, attester);
        _store(subject, tier, score, decisionHash, issuedAt, validUntil);
    }

    /// @notice Attester-only write without a signature (cheaper; used by the watcher).
    function attestDirect(
        address subject,
        Tier tier,
        uint8 score,
        bytes32 decisionHash,
        uint64 issuedAt,
        uint64 validUntil
    ) external onlyAttester whenNotPaused {
        _store(subject, tier, score, decisionHash, issuedAt, validUntil);
    }

    /// @notice Attester-only batched write. Reverts atomically if any item is invalid.
    function attestBatch(AttestationInput[] calldata items) external onlyAttester whenNotPaused {
        uint256 n = items.length;
        for (uint256 i = 0; i < n; ++i) {
            AttestationInput calldata it = items[i];
            _store(it.subject, it.tier, it.score, it.decisionHash, it.issuedAt, it.validUntil);
        }
    }

    /// @notice Owner kill-switch for a single subject: tier → UNKNOWN, `isAllowed` → false.
    /// @dev Keeps `issuedAt` as a watermark so an older, unused signature cannot resurrect the tier.
    function revoke(address subject) external onlyOwner whenNotPaused {
        Record storage r = _records[subject];
        Tier prev = r.tier;
        if (prev == Tier.UNKNOWN) revert NothingToRevoke();
        r.tier = Tier.UNKNOWN;
        r.score = 0;
        r.validUntil = 0;
        r.decisionHash = bytes32(0);
        emit TierChanged(subject, prev, Tier.UNKNOWN);
    }

    // ───────────────────────────── Writes: decision-log anchoring ─────────────────────────────

    /// @notice Anchor the Merkle root of hash-chained decision-log entries `[fromSeq, toSeq]`.
    function anchorRoot(bytes32 root, uint256 fromSeq, uint256 toSeq) external onlyAttester whenNotPaused {
        if (root == bytes32(0)) revert InvalidRoot();
        if (toSeq < fromSeq) revert InvalidSeqRange(fromSeq, toSeq);
        if (anchors[root].anchoredAt != 0) revert RootAlreadyAnchored(root);
        anchors[root] = Anchor({fromSeq: fromSeq, toSeq: toSeq, anchoredAt: uint64(block.timestamp)});
        roots.push(root);
        emit Anchored(root, fromSeq, toSeq);
    }

    // ───────────────────────────── Admin ─────────────────────────────

    /// @notice Rotate the hot attester key.
    function setAttester(address newAttester) external onlyOwner {
        if (newAttester == address(0)) revert ZeroAddress();
        emit AttesterChanged(attester, newAttester);
        attester = newAttester;
    }

    /// @notice Global kill-switch: blocks every write (reads keep working so integrators fail closed on expiry).
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ───────────────────────────── Internal ─────────────────────────────

    function _store(address subject, Tier tier, uint8 score, bytes32 decisionHash, uint64 issuedAt, uint64 validUntil)
        internal
    {
        if (subject == address(0)) revert ZeroAddress();
        if (tier == Tier.UNKNOWN || uint8(tier) > uint8(Tier.HIGH)) revert InvalidTier();
        if (score > 100) revert InvalidScore();
        if (decisionHash == bytes32(0)) revert InvalidDecisionHash();
        // forge-lint: disable-next-line(block-timestamp)
        if (validUntil <= block.timestamp) revert Expired(validUntil, block.timestamp);
        if (issuedAt > validUntil) revert InvalidValidity(issuedAt, validUntil);
        if (usedDecisionHash[decisionHash]) revert DecisionHashUsed(decisionHash);

        Record storage r = _records[subject];
        if (issuedAt < r.issuedAt) revert StaleAttestation(issuedAt, r.issuedAt);

        usedDecisionHash[decisionHash] = true;
        Tier prev = r.tier;
        r.tier = tier;
        r.score = score;
        r.issuedAt = issuedAt;
        r.validUntil = validUntil;
        r.decisionHash = decisionHash;

        emit Attested(subject, tier, validUntil, decisionHash);
        if (prev != tier) emit TierChanged(subject, prev, tier);
    }
}
