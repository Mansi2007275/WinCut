#!/usr/bin/env bash
# WinCut local development stack.
#
#   ./scripts/dev.sh
#
# Starts an Anvil fork of Arc mainnet, deploys WinCutHook + WinCutLauncher,
# seeds real trading history, and writes the addresses the frontend reads.
#
# We fork MAINNET rather than using Arc testnet: the testnet RPC is live
# (chain 5042002) but has no confirmed Uniswap v4 deployment, so a fork of
# mainnet is the only way to work against the real PoolManager and the real
# Universal Router.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARC_RPC="${ARC_RPC:-https://rpc.mainnet.arc.io}"
PORT="${PORT:-8545}"
LOCAL_RPC="http://127.0.0.1:${PORT}"

# Anvil account #0 - a well-known test key. NEVER use this on a real network.
DEPLOYER_PK="${DEPLOYER_PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
DEPLOYER="${DEPLOYER:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"

# Verified on-chain. See contracts/addresses.arc.json.
export POOL_MANAGER="${POOL_MANAGER:-0x8366a39CC670B4001A1121B8F6A443A643e40951}"
export UNIVERSAL_ROUTER="${UNIVERSAL_ROUTER:-0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1}"
export QUOTE="${QUOTE:-0x0000000000000000000000000000000000000000}"   # native USDC, 18dp
# anvil[19]: kept distinct from the seeded traders so demo numbers do not collide
export TREASURY="${TREASURY:-0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199}"
export MAX_TRADE_SIZE="${MAX_TRADE_SIZE:-0}"

ANVIL_LOG="$ROOT/.anvil.log"
ANVIL_PID=""

cleanup() {
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    echo ""
    echo "[dev] stopping anvil (pid $ANVIL_PID)"
    kill "$ANVIL_PID" 2>/dev/null || true
  fi
}
[[ "${KEEP_ALIVE:-0}" == "1" ]] || trap cleanup EXIT

echo "[dev] 1/5  forking Arc mainnet from $ARC_RPC"
if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  echo "[dev]      something already listens on :$PORT, reusing it"
else
  anvil --fork-url "$ARC_RPC" --chain-id 5042 --port "$PORT" --accounts 20 --balance 3000000 --silent >"$ANVIL_LOG" 2>&1 &
  ANVIL_PID=$!
  for i in $(seq 1 60); do
    if cast chain-id --rpc-url "$LOCAL_RPC" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$ANVIL_PID" 2>/dev/null; then
      echo "[dev] ERROR: anvil died. Last lines of $ANVIL_LOG:"; tail -20 "$ANVIL_LOG"; exit 1
    fi
    sleep 1
  done
fi
echo "[dev]      chain id: $(cast chain-id --rpc-url "$LOCAL_RPC")"

echo "[dev] 2/5  sanity-checking the forked v4 deployment"
PM_SIZE=$(cast code "$POOL_MANAGER" --rpc-url "$LOCAL_RPC" | wc -c)
if [[ "$PM_SIZE" -lt 100 ]]; then
  echo "[dev] ERROR: no PoolManager bytecode on the fork. Is ARC_RPC correct?"; exit 1
fi
echo "[dev]      PoolManager OK ($(( (PM_SIZE-3)/2 )) bytes)"

echo "[dev] 3/5  deploying WinCutHook + WinCutLauncher"
cd contracts
DEPLOY_OUT=$(forge script script/Deploy.s.sol \
  --rpc-url "$LOCAL_RPC" --private-key "$DEPLOYER_PK" --broadcast --skip-simulation 2>&1)
echo "$DEPLOY_OUT" | grep -E "mined hook address|WinCutHook |WinCutLauncher |WinCutQuoter |V4Quoter |permission bits" || true

HOOK=$(echo "$DEPLOY_OUT" | grep -oiE "WinCutHook[[:space:]]*:[[:space:]]*0x[0-9a-fA-F]{40}" | grep -oE "0x[0-9a-fA-F]{40}" | tail -1)
LAUNCHER=$(echo "$DEPLOY_OUT" | grep -oiE "WinCutLauncher[[:space:]]*:[[:space:]]*0x[0-9a-fA-F]{40}" | grep -oE "0x[0-9a-fA-F]{40}" | tail -1)
QUOTER=$(echo "$DEPLOY_OUT" | grep -oiE "WinCutQuoter[[:space:]]*:[[:space:]]*0x[0-9a-fA-F]{40}" | grep -oE "0x[0-9a-fA-F]{40}" | tail -1)
V4QUOTER=$(echo "$DEPLOY_OUT" | grep -oiE "V4Quoter[[:space:]]*:[[:space:]]*0x[0-9a-fA-F]{40}" | grep -oE "0x[0-9a-fA-F]{40}" | tail -1)

if [[ -z "${HOOK:-}" || -z "${LAUNCHER:-}" ]]; then
  echo "[dev] ERROR: could not parse deployed addresses. Full output:"; echo "$DEPLOY_OUT" | tail -40; exit 1
fi
echo "[dev]      hook     = $HOOK"
echo "[dev]      launcher = $LAUNCHER"
echo "[dev]      quoter   = $QUOTER"

echo "[dev] 4/5  seeding real trades through the real Universal Router"
HOOK="$HOOK" LAUNCHER="$LAUNCHER" forge script script/SeedTrades.s.sol \
  --rpc-url "$LOCAL_RPC" --broadcast --skip-simulation 2>&1 \
  | grep -E "launched|claimable|honest|dumper|referrer|treasury|credit|coins launched|POSITIVE" || true

echo "[dev] 5/5  writing web/src/config/deployed.json"
cd "$ROOT"
mkdir -p web/src/config
cat > web/src/config/deployed.json <<JSON
{
  "chainId": 5042,
  "chainName": "Arc (local fork)",
  "rpcUrl": "$LOCAL_RPC",
  "explorer": "https://explorer.arc.io",
  "contracts": {
    "winCutHook": "$HOOK",
    "winCutLauncher": "$LAUNCHER",
    "winCutQuoter": "$QUOTER",
    "v4Quoter": "$V4QUOTER",
    "poolManager": "$POOL_MANAGER",
    "universalRouter": "$UNIVERSAL_ROUTER",
    "permit2": "0x000000000022D473030F116dDEE9F6B43aC78BA3"
  },
  "quote": {
    "address": "$QUOTE",
    "symbol": "USDC",
    "decimals": 18,
    "isNative": true
  },
  "pool": { "fee": 3000, "tickSpacing": 60 },
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
cat web/src/config/deployed.json

echo ""
echo "[dev] ready. RPC $LOCAL_RPC  (chain 5042)"
echo "[dev] import this key into your wallet for testing:"
echo "[dev]   $DEPLOYER_PK"
echo "[dev]   ^ public Anvil test key. Never use it on a real network."
if [[ "${KEEP_ALIVE:-0}" == "1" ]]; then
  echo "[dev] anvil left running (KEEP_ALIVE=1). Stop it with: kill $ANVIL_PID"
else
  echo "[dev] press Ctrl-C to stop anvil."
  wait "$ANVIL_PID" 2>/dev/null || true
fi
