# ---------------------------------------------------------------------------
# WinCut environment. Copy to .env and fill in. NEVER commit .env.
# All addresses below were verified on-chain with cast on 2026-11-06,
# block 29830463. See contracts/addresses.arc.json for the evidence.
# ---------------------------------------------------------------------------

# Arc mainnet. Develop against an Anvil FORK of this, not the testnet:
# the testnet RPC is live (chain 5042002) but has no confirmed v4 deployment.
ARC_RPC=https://rpc.mainnet.arc.io
ARC_CHAIN_ID=5042

# --- verified Uniswap v4 on Arc mainnet ------------------------------------
# PoolManager: owner() returns 0xbCA30b5429935205037069cF5b8A165F55d05a75
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951

# Universal Router: execute() selectors present AND msgSender() (0xd737d0c7)
# present in bytecode, with a live call returning address(0) without reverting.
# This is what makes trader attribution possible.
UNIVERSAL_ROUTER=0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1

POSITION_MANAGER=0x6049c9a0e26405C0985f9E3685C87d0aE917f82B
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3

# --- QUOTE currency: NATIVE USDC ------------------------------------------
# DECIDED FROM EVIDENCE, not assumed. 129 sampled Initialize events on real
# Arc pools have currency0 == address(0), so Arc v4 pools pair against NATIVE
# USDC at 18 decimals.
#
# The ERC-20 interface at 0x3600000000000000000000000000000000000000 is the
# SAME MONEY at 6 decimals - a 1e12 difference. Do not mix them.
QUOTE=0x0000000000000000000000000000000000000000
QUOTE_DECIMALS=18

# For reference only. Do NOT use as QUOTE unless you re-verify that pools
# actually pair against it.
USDC_ERC20=0x3600000000000000000000000000000000000000

# --- deployment config -----------------------------------------------------
TREASURY=
# Per-trade cap in QUOTE units (18dp here). 0 disables. 10000e18 = $10k.
MAX_TRADE_SIZE=0

# --- filled in by scripts/dev.sh and Deploy.s.sol -------------------------
HOOK=
LAUNCHER=

# --- never commit these ----------------------------------------------------
# PRIVATE_KEY=
