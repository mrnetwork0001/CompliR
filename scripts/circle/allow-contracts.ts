/**
 * Add contract-call targets to a Circle wallet role's app-enforced contract allowlist (src/lib/circle/wallets.ts).
 * Used to pin the revenue wallet's contract calls to USDC + the Circle Earn vault the yield sweep deposits into.
 *
 *   npx tsx --env-file=.env.local scripts/circle/allow-contracts.ts revenue 0x3600000000000000000000000000000000000000 0xbeef0016cb2fd5c352ea7ca08a9f54739dfa7298
 *   npx tsx --env-file=.env.local scripts/circle/allow-contracts.ts revenue --show
 *
 * Plain USDC transfers (tips, refunds) are governed by `allowlist`, not this list, so they keep working.
 */
import { allowContracts, policyCliHint, policyFor, walletByRole, type WalletRole } from "../../src/lib/circle";

const [role, ...rest] = process.argv.slice(2);
if (role !== "revenue" && role !== "ops") { console.error("usage: allow-contracts.ts <revenue|ops> <0x…> [0x…] | --show"); process.exit(2); }
const targets = rest.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const main = async () => {
  if (!(await walletByRole(role as WalletRole))) { console.error(`no stored ${role} wallet (run scripts/circle/setup.ts first)`); process.exit(1); }
  const list = rest.includes("--show") || !targets.length ? (await policyFor(role as WalletRole)).contractAllowlist ?? [] : await allowContracts(role as WalletRole, targets);
  const p = await policyFor(role as WalletRole);
  console.log(JSON.stringify({ role, contractAllowlist: list, policy: p }, null, 2));
  console.log(policyCliHint((await walletByRole(role as WalletRole))!.address, p));
};
main().catch((e) => { console.error(e); process.exit(1); });
