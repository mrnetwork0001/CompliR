/**
 * Circle CCTP v2 on Arc - addresses, domains, source-chain USDC + RPCs, event ABI and the BurnMessageV2 decoder.
 *
 * Arc contracts (https://docs.arc.io/arc/references/contract-addresses, CCTP section; Arc domain 26):
 *   MessageTransmitterV2 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64   TokenMessengerV2 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d
 *   (the same CREATE2 addresses Circle uses on every CCTP v2 EVM chain except EDGE - developers.circle.com/cctp/evm-smart-contracts)
 * Verified live 2026-10-14 on Arc mainnet: 220 MessageReceived logs in the last 50k blocks; sample
 *   tx 0x92cc25bc… sourceDomain=3 (Arbitrum), sender=TokenMessengerV2, body = BurnMessageV2 v1 with burnToken = Arbitrum USDC
 *   0xaf88…5831, amount 5000 USDC, matching MintAndWithdraw(mintRecipient, 5000e6, 0x3600…0000, feeCollected 0) in the same tx.
 * Events (circlefin/evm-cctp-contracts src/v2/MessageTransmitterV2.sol, src/v2/BaseTokenMessenger.sol):
 *   MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)
 *   MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)
 * BurnMessageV2 layout (src/messages/v2/BurnMessageV2.sol): version u32@0, burnToken b32@4, mintRecipient b32@36, amount u256@68,
 *   messageSender b32@100, maxFee u256@132, feeExecuted u256@164, expirationBlock u256@196, hookData @228.
 * Domains (developers.circle.com/cctp/supported-domains): Ethereum 0, Avalanche 1, OP 2, Arbitrum 3, Base 6, Polygon 7, Unichain 10,
 *   Linea 11, Codex 12, Sonic 13, World Chain 14, Monad 15, Sei 16, XDC 18, HyperEVM 19, Ink 21, Plume 22, Arc 26, Injective 29, Morph 30.
 * USDC per chain: developers.circle.com/stablecoins/usdc-contract-addresses.
 */
import { parseAbi, type Address, type Hex } from "viem";

export const ARC_CCTP = {
  domain: 26,
  messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as Address,
  tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Address,
};

export const CCTP_EVENTS = parseAbi([
  "event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)",
  "event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)",
]);

export interface SourceChain {
  domain: number;
  name: string;
  chainId: number | null;
  /** USDC on that chain (null = not an EVM FiatToken we can query) */
  usdc: Address | null;
  /** public RPC for isBlacklisted; null = no blacklist check (sanctions only) */
  rpc: string | null;
}

export const SOURCE_CHAINS: Record<number, SourceChain> = {
  0: { domain: 0, name: "ethereum", chainId: 1, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", rpc: "https://ethereum-rpc.publicnode.com" },
  1: { domain: 1, name: "avalanche", chainId: 43114, usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", rpc: "https://api.avax.network/ext/bc/C/rpc" },
  2: { domain: 2, name: "optimism", chainId: 10, usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", rpc: "https://mainnet.optimism.io" },
  3: { domain: 3, name: "arbitrum", chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", rpc: "https://arb1.arbitrum.io/rpc" },
  5: { domain: 5, name: "solana", chainId: null, usdc: null, rpc: null },
  6: { domain: 6, name: "base", chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", rpc: "https://mainnet.base.org" },
  7: { domain: 7, name: "polygon", chainId: 137, usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", rpc: "https://polygon-rpc.com" },
  10: { domain: 10, name: "unichain", chainId: 130, usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", rpc: "https://mainnet.unichain.org" },
  11: { domain: 11, name: "linea", chainId: 59144, usdc: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", rpc: "https://rpc.linea.build" },
  12: { domain: 12, name: "codex", chainId: 81224, usdc: "0xd996633a415985DBd7D6D12f4A4343E31f5037cf", rpc: null },
  13: { domain: 13, name: "sonic", chainId: 146, usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", rpc: "https://rpc.soniclabs.com" },
  14: { domain: 14, name: "worldchain", chainId: 480, usdc: "0x79A02482A880bCe3F13E09da970dC34dB4cD24D1", rpc: "https://worldchain-mainnet.g.alchemy.com/public" },
  15: { domain: 15, name: "monad", chainId: 143, usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", rpc: null },
  16: { domain: 16, name: "sei", chainId: 1329, usdc: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", rpc: "https://evm-rpc.sei-apis.com" },
  18: { domain: 18, name: "xdc", chainId: 50, usdc: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1", rpc: "https://rpc.xdcrpc.com" },
  19: { domain: 19, name: "hyperevm", chainId: 999, usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", rpc: "https://rpc.hyperliquid.xyz/evm" },
  21: { domain: 21, name: "ink", chainId: 57073, usdc: "0x2D270e6886d130D724215A266106e6832161EAEd", rpc: "https://rpc-gel.inkonchain.com" },
  22: { domain: 22, name: "plume", chainId: 98866, usdc: "0x222365EF19F7947e5484218551B56bb3965Aa7aF", rpc: "https://rpc.plume.org" },
  26: { domain: 26, name: "arc", chainId: 5042, usdc: "0x3600000000000000000000000000000000000000", rpc: "https://rpc.mainnet.arc.io" },
  29: { domain: 29, name: "injective", chainId: null, usdc: null, rpc: null },
  30: { domain: 30, name: "morph", chainId: 2818, usdc: null, rpc: null },
};

export function sourceChain(domain: number): SourceChain {
  return SOURCE_CHAINS[domain] ?? { domain, name: `domain-${domain}`, chainId: null, usdc: null, rpc: null };
}

export interface BurnMessage {
  version: number;
  burnToken: Address;
  mintRecipient: Address;
  /** raw amount in the source token's units (USDC: 6 dp) */
  amount: bigint;
  messageSender: Address;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: Hex;
}

const hex32ToAddress = (h: string, at: number): Address => ("0x" + h.slice(2 + at * 2 + 24, 2 + at * 2 + 64)).toLowerCase() as Address;
const u = (h: string, at: number, bytes: number): bigint => BigInt("0x" + h.slice(2 + at * 2, 2 + (at + bytes) * 2));

/** Decode a CCTP v2 BurnMessageV2 body (the `messageBody` of MessageReceived). null when too short / not a burn message. */
export function decodeBurnMessage(body: Hex): BurnMessage | null {
  if (!body || body.length < 2 + 228 * 2) return null;
  const version = Number(u(body, 0, 4));
  return {
    version,
    burnToken: hex32ToAddress(body, 4),
    mintRecipient: hex32ToAddress(body, 36),
    amount: u(body, 68, 32),
    messageSender: hex32ToAddress(body, 100),
    maxFee: u(body, 132, 32),
    feeExecuted: u(body, 164, 32),
    expirationBlock: u(body, 196, 32),
    hookData: ("0x" + body.slice(2 + 228 * 2)) as Hex,
  };
}

/** bytes32-padded address (CCTP `sender` / `mintRecipient`) → 0x address. */
export function bytes32ToAddress(b: Hex): Address {
  return ("0x" + b.slice(-40)).toLowerCase() as Address;
}
