/**
 * ERC-8004 "Trustless Agents" registries on Arc - addresses + the ABI subset CompliR reads and writes.
 *
 * Addresses: https://docs.arc.io/arc/references/contract-addresses (ERC-8004 section). Verified on-chain 2026-10-14:
 *   IdentityRegistry   0x8004A169… name()="AgentIdentity", ownerOf(1)=0x024b…700c (APEX), tokenURI(1)=https://apexfaucet.xyz/.well-known/erc8004.json
 *   ReputationRegistry 0x8004BAa1… ERC-1967 proxy → impl 0x16e0fa7f…; getIdentityRegistry()=0x8004A169…; bytecode carries the selectors of
 *                      giveFeedback / getSummary / readAllFeedback / getClients / getLastIndex / readFeedback
 *   ValidationRegistry 0x8004Cc84… ERC-1967 proxy → impl 0xdb31f5d9…; getIdentityRegistry()=0x8004A169…; bytecode carries the selectors of
 *                      validationRequest / validationResponse / getValidationStatus / getSummary / getAgentValidations / getValidatorRequests
 * Signatures: https://eips.ethereum.org/EIPS/eip-8004 (Identity / Reputation / Validation registry sections).
 * Semantics that matter here (EIP + live dry-runs with `cast call --from <attester>`):
 *   - validationResponse(requestHash, …) may only be sent by the validator named in a prior validationRequest from the
 *     agent's owner/operator; an unknown requestHash reverts ("unknown"). → CompliR can only *answer* requests addressed to it.
 *   - giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash) may be called by any
 *     address that is not the agent's owner/operator (dry-run from the attester on agent #1 succeeds). → the fallback
 *     publish path when no request names us.
 */
import { parseAbi, type Address } from "viem";

export const ERC8004_ADDRESSES: Record<number, { identity: Address; reputation: Address; validation: Address }> = {
  5042: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    validation: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58",
  },
  5042002: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
  },
};

export const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
]);

export const REPUTATION_ABI = parseAbi([
  "function getIdentityRegistry() view returns (address)",
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)",
  "function getClients(uint256 agentId) view returns (address[])",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

export const VALIDATION_ABI = parseAbi([
  "function getIdentityRegistry() view returns (address)",
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 averageResponse)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[] requestHashes)",
  "function getValidatorRequests(address validatorAddress) view returns (bytes32[] requestHashes)",
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
]);
