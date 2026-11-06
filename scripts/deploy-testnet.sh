#!/usr/bin/env bash
#
# Deploys WinCut to Arc TESTNET (chain 5042002) and points the app at it.
#
#   ./scripts/deploy-testnet.sh
#
# This is the real-data deploy path. It forges nothing: no fork, no
# anvil_setBalance, no seeded pools, no bot. Coins and trades come from real
# wallets afterwards.
#
# Reads from .env (gitignored, never printed):
#   DEPLOYER_PRIVATE_KEY   throwaway key that pays deploy gas
#   DEPLOYER_ADDRESS       its address
#   ARC_TESTNET_RPC        https://rpc.testnet.arc.io
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f .env ] || { echo "no .env — copy .env.example and fill it in"; exit 1; }
set -a; . ./.env; set +a

RPC="${ARC_TESTNET_RPC:?ARC_TESTNET_RPC missing from .env}"
CHAIN_ID=5042002
EXPLORER="https://testnet.arcscan.app"

# Arc testnet carries the same v4 deployment as mainnet, verified by eth_getCode.
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
UNIVERSAL_ROUTER=0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3

# Native USDC. The ERC-20 interface at 0x3600..0000 is the same money 1e12 apart,
# and the hook pins exactly one of the two.
QUOTE=0x0000000000000000000000000000000000000000

# Treasury and final hook owner. Override with TREASURY=0x.. ./scripts/deploy-testnet.sh
TREASURY="${TREASURY:-0x71aEE14669EaF0a2f55b783Eed64Ad12B66177ee}"
FINAL_OWNER="${FINAL_OWNER:-$TREASURY}"

# Generous enough that it can never bite a demo trade, small enough to prove the
# guard exists. 0 would disable it entirely.
MAX_TRADE_SIZE="${MAX_TRADE_SIZE:-10000000000000000000000}"

say() { printf '\n\033[1m[deploy] %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- preflight
say "1/4  preflight"

actual_chain=$(cast chain-id --rpc-url "$RPC")
[ "$actual_chain" = "$CHAIN_ID" ] || { echo "wrong chain: got $actual_chain, want $CHAIN_ID"; exit 1; }
echo "  chain id        $actual_chain"

# Re-verify v4 rather than trusting a file. A wrong PoolManager silently
# produces a hook that can never be reached.
for pair in "PoolManager:$POOL_MANAGER" "UniversalRouter:$UNIVERSAL_ROUTER" "Permit2:$PERMIT2"; do
  name="${pair%%:*}"; a="${pair##*:}"
  code=$(cast code "$a" --rpc-url "$RPC")
  size=$(( (${#code} - 2) / 2 ))
  [ "$size" -gt 1000 ] || { echo "  $name has no bytecode at $a"; exit 1; }
  printf '  %-16s %s bytes\n' "$name" "$size"
done

# msgSender() is how the hook learns who is really behind the router. Without it
# every trade is unattributed and the whole product stops working.
ms=$(cast call "$UNIVERSAL_ROUTER" "msgSender()(address)" --rpc-url "$RPC") || {
  echo "  msgSender() reverted — attribution would be impossible"; exit 1; }
echo "  msgSender()      ok ($ms outside a swap)"

bal=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC")
human=$(cast from-wei "$bal")
echo "  deployer         $DEPLOYER_ADDRESS"
echo "  balance          \$$human"
# ~5.8M gas at 20.25 gwei is about $0.12; 0.3 leaves room for retries.
if [ "$(echo "$human < 0.3" | bc -l)" = "1" ]; then
  echo
  echo "  NOT ENOUGH GAS. Send \$1.00 test USDC on Arc testnet to:"
  echo "      $DEPLOYER_ADDRESS"
  echo "  Faucet: https://faucet.circle.com (pick Arc Sepolia / Arc testnet)"
  exit 1
fi

# ------------------------------------------------------------------ deploy
say "2/4  deploying hook (CREATE2), launcher, quoter"
cd contracts

DEPLOY_BLOCK=$(cast block-number --rpc-url "$RPC")

out=$(POOL_MANAGER="$POOL_MANAGER" \
      QUOTE="$QUOTE" \
      UNIVERSAL_ROUTER="$UNIVERSAL_ROUTER" \
      TREASURY="$TREASURY" \
      FINAL_OWNER="$FINAL_OWNER" \
      MAX_TRADE_SIZE="$MAX_TRADE_SIZE" \
      forge script script/Deploy.s.sol:Deploy \
        --rpc-url "$RPC" \
        --private-key "$DEPLOYER_PRIVATE_KEY" \
        --broadcast \
        --slow \
        2>&1 | tee /dev/stderr)

pick() { echo "$out" | grep -E "^  $1" | tail -1 | sed -E 's/.*(0x[0-9a-fA-F]{40}).*/\1/'; }
HOOK=$(pick "WinCutHook")
LAUNCHER=$(pick "WinCutLauncher")
QUOTER=$(pick "WinCutQuoter")

for v in HOOK LAUNCHER QUOTER; do
  [[ "${!v}" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "could not read $v from deploy output"; exit 1; }
done

# ------------------------------------------------------------------ verify
say "3/4  verifying on-chain state"
cd "$ROOT"

owner=$(cast call "$HOOK" "owner()(address)" --rpc-url "$RPC")
treas=$(cast call "$HOOK" "treasury()(address)" --rpc-url "$RPC")
trusted=$(cast call "$HOOK" "trustedRouter(address)(bool)" "$UNIVERSAL_ROUTER" --rpc-url "$RPC")
bits=$(printf '0x%04x' $(( $(cast to-dec "$HOOK") & 0x3fff )))

eq() { [ "$(echo "$1" | tr 'A-Z' 'a-z')" = "$(echo "$2" | tr 'A-Z' 'a-z')" ]; }
eq "$owner" "$FINAL_OWNER" || { echo "owner() is $owner, expected $FINAL_OWNER"; exit 1; }
eq "$treas" "$TREASURY"    || { echo "treasury() is $treas, expected $TREASURY"; exit 1; }
[ "$trusted" = "true" ]    || { echo "router not trusted"; exit 1; }
[ "$bits" = "0x2044" ]     || { echo "permission bits are $bits, expected 0x2044"; exit 1; }

echo "  owner()          $owner"
echo "  treasury()       $treas"
echo "  trustedRouter    $UNIVERSAL_ROUTER = true"
echo "  permission bits  $bits"

# -------------------------------------------------------------- app config
say "4/4  pointing the app at testnet"

cat > web/src/config/deployed.json <<JSON
{
  "chainId": $CHAIN_ID,
  "chainName": "Arc Testnet",
  "rpcUrl": "$RPC",
  "explorer": "$EXPLORER",
  "faucet": "https://faucet.circle.com",
  "contracts": {
    "winCutHook": "$HOOK",
    "winCutLauncher": "$LAUNCHER",
    "winCutQuoter": "$QUOTER",
    "poolManager": "$POOL_MANAGER",
    "universalRouter": "$UNIVERSAL_ROUTER",
    "permit2": "$PERMIT2"
  },
  "quote": {
    "address": "$QUOTE",
    "symbol": "USDC",
    "decimals": 18,
    "isNative": true
  },
  "pool": { "fee": 3000, "tickSpacing": 60 },
  "treasury": "$TREASURY",
  "owner": "$FINAL_OWNER",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployedAtBlock": $DEPLOY_BLOCK
}
JSON

cat web/src/config/deployed.json

say "done"
cat <<TXT

  WinCutHook      $EXPLORER/address/$HOOK
  WinCutLauncher  $EXPLORER/address/$LAUNCHER
  WinCutQuoter    $EXPLORER/address/$QUOTER

  No coins exist yet, by design. Launch the first one from the app:
      cd web && npm run dev     ->  http://localhost:4000/launch
TXT
