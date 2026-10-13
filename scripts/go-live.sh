#!/usr/bin/env bash
# One-shot mainnet go-live for CompliR. Run ONCE with a funded key. Idempotent where it can be.
#   DEPLOYER_PRIVATE_KEY=0x…  OWNER_ADDRESS=0x…  [FUND_TREASURY_USDC=50]  bash scripts/go-live.sh
# What it does: 1) sanity (chain id, USDC balance) 2) deploy AttestationRegistry 3) deploy GuardedTreasury
# 4) write REGISTRY_ADDRESS / GUARDED_TREASURY_ADDRESS / ATTESTER_PRIVATE_KEY / TREASURY_* into .env.local
# 5) optionally fund the treasury 6) run scripts/go-live-check.mjs against the running server.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=".env.local"
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY (pays USDC gas on Arc)}"
: "${OWNER_ADDRESS:?set OWNER_ADDRESS (admin of both contracts; usually the deployer address)}"
RPC="${ARC_RPC_URL:-$(grep -E '^ARC_RPC_URL=' $ENV_FILE | cut -d= -f2-)}"; RPC="${RPC:-https://rpc.mainnet.arc.io}"
USDC="${USDC_ADDRESS:-0x3600000000000000000000000000000000000000}"
EXPLORER="${ARC_EXPLORER_URL:-https://explorer.arc.io}"
command -v forge >/dev/null && command -v cast >/dev/null || { echo "forge/cast (Foundry) required"; exit 1; }

DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
CHAIN=$(cast chain-id --rpc-url "$RPC")
BAL=$(cast call "$USDC" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')
NATIVE=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
echo "chain=$CHAIN deployer=$DEPLOYER usdc(erc20,6dp)=$BAL native(18dp)=$NATIVE"
[ "$CHAIN" = "5042" ] || { echo "refusing: not Arc mainnet (5042)"; exit 1; }
[ "$NATIVE" != "0" ] || { echo "refusing: deployer has no native USDC for gas"; exit 1; }

setenv() { # setenv KEY VALUE → upsert in .env.local
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i '' "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '\n%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}

ATTESTER_ADDRESS="$DEPLOYER" # attester = deployer key (ATTESTER_PRIVATE_KEY); change later with setAttester()
pushd contracts >/dev/null
echo "== deploying AttestationRegistry =="
OWNER_ADDRESS="$OWNER_ADDRESS" ATTESTER_ADDRESS="$ATTESTER_ADDRESS" \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast -vv | tee /tmp/complir-deploy-registry.log
REGISTRY=$(grep -oE 'AttestationRegistry[^0]*0x[0-9a-fA-F]{40}' /tmp/complir-deploy-registry.log | grep -oE '0x[0-9a-fA-F]{40}' | tail -1)
[ -n "$REGISTRY" ] || REGISTRY=$(python3 -c "import json,glob; f=sorted(glob.glob('broadcast/Deploy.s.sol/5042/run-latest.json'))[-1]; d=json.load(open(f)); print([t['contractAddress'] for t in d['transactions'] if t.get('contractName')=='AttestationRegistry'][-1])")
echo "REGISTRY=$REGISTRY"

echo "== deploying GuardedTreasury =="
REGISTRY_ADDRESS="$REGISTRY" TOKEN_ADDRESS="$USDC" OWNER_ADDRESS="$OWNER_ADDRESS" \
  forge script script/Deploy.s.sol:DeployGuardedTreasury --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast -vv | tee /tmp/complir-deploy-treasury.log
TREASURY=$(grep -oE 'GuardedTreasury[^0]*0x[0-9a-fA-F]{40}' /tmp/complir-deploy-treasury.log | grep -oE '0x[0-9a-fA-F]{40}' | tail -1)
[ -n "$TREASURY" ] || TREASURY=$(python3 -c "import json,glob; d=json.load(open('broadcast/Deploy.s.sol/5042/run-latest.json')); print([t['contractAddress'] for t in d['transactions'] if t.get('contractName')=='GuardedTreasury'][-1])")
echo "TREASURY=$TREASURY"

echo "== verifying (best effort, Sourcify) =="
forge verify-contract "$REGISTRY" src/AttestationRegistry.sol:AttestationRegistry --chain-id 5042 --verifier sourcify \
  --constructor-args "$(cast abi-encode 'constructor(address,address)' "$OWNER_ADDRESS" "$ATTESTER_ADDRESS")" || echo "(sourcify verify failed; verify manually on $EXPLORER)"
forge verify-contract "$TREASURY" src/examples/GuardedTreasury.sol:GuardedTreasury --chain-id 5042 --verifier sourcify \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address)' "$REGISTRY" "$USDC" "$OWNER_ADDRESS")" || echo "(sourcify verify failed; verify manually)"
popd >/dev/null

echo "== writing $ENV_FILE =="
setenv REGISTRY_ADDRESS "$REGISTRY"
setenv GUARDED_TREASURY_ADDRESS "$TREASURY"
setenv ATTESTER_PRIVATE_KEY "$DEPLOYER_PRIVATE_KEY"
setenv TREASURY_PRIVATE_KEY "$DEPLOYER_PRIVATE_KEY"
setenv TREASURY_MODE "live"
setenv OWN_WALLETS "$(printf '%s,%s' "$DEPLOYER" "$TREASURY" | tr 'A-F' 'a-f')"

if [ -n "${FUND_TREASURY_USDC:-}" ]; then
  AMT=$(python3 -c "print(int(float('$FUND_TREASURY_USDC')*1_000_000))")
  echo "== funding treasury with $FUND_TREASURY_USDC USDC =="
  cast send "$USDC" "transfer(address,uint256)" "$TREASURY" "$AMT" --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY"
fi

echo
echo "Registry:  $EXPLORER/address/$REGISTRY"
echo "Treasury:  $EXPLORER/address/$TREASURY"
echo "Restart the app (env changed), then: node scripts/go-live-check.mjs"
