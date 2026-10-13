/**
 * Register CompliR in the ERC-8004 IdentityRegistry on Arc (spec C16).
 *
 *   npx tsx --env-file=.env.local scripts/erc8004/register.ts            # register (or print calldata when no key)
 *   npx tsx --env-file=.env.local scripts/erc8004/register.ts --data-uri # embed metadata as base64 data: URI (no hosting needed)
 *   npx tsx --env-file=.env.local scripts/erc8004/register.ts --print    # only print metadata + calldata
 *   ERC8004_AGENT_ID=<n> … register.ts                                   # update: setAgentURI(agentId, uri) instead of register
 *
 * Env: PUBLIC_BASE_URL (required for https agentURI), ARC_CHAIN_ID, ARC_RPC_URL,
 *      ERC8004_IDENTITY_REGISTRY (default: Arc mainnet 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 / testnet 0x8004A818BFB912233c491871b3d84c89A494BD9e),
 *      ERC8004_AGENT_URI (override; default `${PUBLIC_BASE_URL}/.well-known/agent-registration.json`),
 *      ERC8004_OWNER_PRIVATE_KEY (falls back to ATTESTER_PRIVATE_KEY). Without a key the calldata is printed.
 *
 * Sources: https://eips.ethereum.org/EIPS/eip-8004 · https://docs.arc.io/arc/references/contract-addresses ·
 *          https://docs.arc.io/arc/tutorials/register-your-first-ai-agent  (see docs/ERC8004.md)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, parseEventLogs, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

export const IDENTITY_REGISTRY: Record<number, Address> = {
  5042: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", // Arc mainnet - verified on-chain: name()="AgentIdentity", agent #1 = APEX
  5042002: "0x8004A818BFB912233c491871b3d84c89A494BD9e", // Arc testnet
};
export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

const chainId = Number(process.env.ARC_CHAIN_ID ?? 5042);
const rpc = process.env.ARC_RPC_URL ?? "https://rpc.mainnet.arc.io";
const baseUrl = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const registry = (process.env.ERC8004_IDENTITY_REGISTRY as Address | undefined) ?? IDENTITY_REGISTRY[chainId];
const agentId = process.env.ERC8004_AGENT_ID ? BigInt(process.env.ERC8004_AGENT_ID) : null;
const key = (process.env.ERC8004_OWNER_PRIVATE_KEY ?? process.env.ATTESTER_PRIVATE_KEY) as `0x${string}` | undefined;

function chain(): Chain {
  const base = chainId === arc.id ? arc : chainId === arcTestnet.id ? arcTestnet : { ...arc, id: chainId, name: `arc-${chainId}` };
  return { ...base, rpcUrls: { default: { http: [rpc] } } };
}

/** Fill the template placeholders in agent.json. */
export function buildMetadata(): Record<string, unknown> {
  const raw = readFileSync(join(here, "agent.json"), "utf8")
    .replaceAll("{{PUBLIC_BASE_URL}}", baseUrl)
    .replaceAll("{{CHAIN_ID}}", String(chainId))
    .replaceAll("{{IDENTITY_REGISTRY}}", registry ?? "0x0000000000000000000000000000000000000000")
    .replaceAll("{{AGENT_ID}}", agentId?.toString() ?? "0");
  const json = JSON.parse(raw) as Record<string, unknown>;
  if (agentId === null) delete json.registrations; // unknown until registered; re-run with ERC8004_AGENT_ID to fill it
  return json;
}

async function main() {
  if (!registry) throw new Error(`No IdentityRegistry known for chain ${chainId}; set ERC8004_IDENTITY_REGISTRY`);
  const metadata = buildMetadata();
  const metadataJson = JSON.stringify(metadata, null, 2);
  const out = join(here, "agent.built.json");
  writeFileSync(out, metadataJson + "\n");

  const agentURI = process.env.ERC8004_AGENT_URI
    ?? (args.has("--data-uri")
      ? `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString("base64")}`
      : `${baseUrl}/.well-known/agent-registration.json`);

  const fn = agentId === null ? "register" : "setAgentURI";
  const data = agentId === null
    ? encodeFunctionData({ abi: identityAbi, functionName: "register", args: [agentURI] })
    : encodeFunctionData({ abi: identityAbi, functionName: "setAgentURI", args: [agentId, agentURI] });

  console.log(`\nCompliR ERC-8004 ${fn} on chain ${chainId}`);
  console.log(`  registry : ${registry}`);
  console.log(`  agentURI : ${agentURI.length > 120 ? agentURI.slice(0, 117) + "..." : agentURI}`);
  console.log(`  metadata : ${out}`);
  if (!agentURI.startsWith("data:")) console.log(`  NOTE     : the metadata must be served at ${agentURI} (copy agent.built.json there) or pass --data-uri`);

  if (!key || args.has("--print")) {
    console.log(`\nNo ERC8004_OWNER_PRIVATE_KEY (or --print) → calldata only. Send this tx from the agent owner wallet:`);
    console.log(JSON.stringify({ chainId, to: registry, value: "0", data }, null, 2));
    return;
  }

  const account = privateKeyToAccount(key);
  const c = chain();
  const pub = createPublicClient({ chain: c, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain: c, transport: http(rpc) });
  console.log(`  owner    : ${account.address}`);
  const hash = await wallet.sendTransaction({ to: registry, data });
  console.log(`  tx       : ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  console.log(`  status   : ${receipt.status} (block ${receipt.blockNumber})`);
  if (agentId === null) {
    const logs = parseEventLogs({ abi: identityAbi, eventName: "Registered", logs: receipt.logs });
    const id = logs[0]?.args.agentId;
    if (id !== undefined) {
      console.log(`\n  agentId  : ${id}   → set ERC8004_AGENT_ID=${id} and re-run to write the registrations[] back-reference`);
      console.log(`  agentRegistry: eip155:${chainId}:${registry}`);
    }
  }
}

main().catch((e) => { console.error("[erc8004]", e?.message ?? e); process.exit(1); });
