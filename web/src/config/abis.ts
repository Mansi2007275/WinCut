// Minimal ABIs, hand-written so the bundle stays small.
// Keep in sync with contracts/src.

export const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const winCutHookAbi = [
  {
    type: "function",
    name: "quoteFee",
    stateMutability: "view",
    inputs: [
      { name: "trader", type: "address" },
      { name: "id", type: "bytes32" },
      { name: "sellAmount", type: "uint128" },
      { name: "grossOut", type: "uint256" },
    ],
    outputs: [
      { name: "fee", type: "uint256" },
      { name: "netOut", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "positionOf",
    stateMutability: "view",
    inputs: [
      { name: "trader", type: "address" },
      { name: "id", type: "bytes32" },
    ],
    outputs: [
      { name: "amount", type: "uint128" },
      { name: "cost", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "lossCredit",
    stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "followedOf",
    stateMutability: "view",
    inputs: [
      { name: "trader", type: "address" },
      { name: "id", type: "bytes32" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "referrerOf",
    stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ type: "address" }],
  },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  // Per-trade cap in QUOTE units. 0 disables it. The hook reverts
  // TradeTooLarge() above this, so the UI reads it rather than guessing.
  { type: "function", name: "maxTradeSize", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // Declared so viem can decode the revert into a readable message.
  { type: "error", name: "TradeTooLarge", inputs: [] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "trustedRouter",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "CreditConsumed",
    inputs: [
      { name: "trader", type: "address", indexed: true },
      { name: "used", type: "uint256", indexed: false },
      { name: "remaining", type: "uint256", indexed: false },
    ],
  },
  // --- events, used to build the feed and leaderboard ---
  {
    type: "event",
    name: "Bought",
    inputs: [
      { name: "trader", type: "address", indexed: true },
      { name: "id", type: "bytes32", indexed: true },
      { name: "coins", type: "uint128", indexed: false },
      { name: "cost", type: "uint256", indexed: false },
      { name: "followed", type: "address", indexed: false },
      { name: "referrer", type: "address", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Sold",
    inputs: [
      { name: "trader", type: "address", indexed: true },
      { name: "id", type: "bytes32", indexed: true },
      { name: "coins", type: "uint128", indexed: false },
      { name: "proceeds", type: "uint256", indexed: false },
      { name: "pnl", type: "int256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeeSplit",
    inputs: [
      { name: "trader", type: "address", indexed: true },
      { name: "id", type: "bytes32", indexed: true },
      { name: "fee", type: "uint256", indexed: false },
      { name: "followed", type: "address", indexed: false },
      { name: "traderCut", type: "uint256", indexed: false },
      { name: "referrer", type: "address", indexed: false },
      { name: "referrerCut", type: "uint256", indexed: false },
      { name: "treasuryCut", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LossCredited",
    inputs: [
      { name: "trader", type: "address", indexed: true },
      { name: "loss", type: "uint256", indexed: false },
      { name: "newCredit", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const winCutLauncherAbi = [
  { type: "function", name: "coinCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "allCoins",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "poolKeyFor",
    stateMutability: "view",
    inputs: [{ name: "coinAddr", type: "address" }],
    outputs: [{ type: "tuple", components: poolKeyComponents }],
  },
  {
    type: "function",
    name: "poolIdFor",
    stateMutability: "view",
    inputs: [{ name: "coinAddr", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "launchCoin",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "initialQuote", type: "uint256" },
      { name: "initialSupply", type: "uint256" },
    ],
    outputs: [
      { name: "coinAddr", type: "address" },
      { name: "id", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "CoinLaunched",
    inputs: [
      { name: "coin", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "id", type: "bytes32", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
      { name: "seededQuote", type: "uint256", indexed: false },
      { name: "seededCoin", type: "uint256", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
    ],
  },
  {
    type: "function",
    name: "launches",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "coin", type: "address" },
      { name: "creator", type: "address" },
      { name: "seededQuote", type: "uint256" },
      { name: "seededCoin", type: "uint256" },
    ],
  },
] as const;

/// The quoter is NOT view: it unlocks the PoolManager, simulates and reverts.
/// Always read it with eth_call (viem's simulateContract / readContract works).
export const winCutQuoterAbi = [
  {
    type: "function",
    name: "quoteBuy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "tuple", components: poolKeyComponents },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
    ],
    outputs: [{ name: "coinsOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteSell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "trader", type: "address" },
      { name: "key", type: "tuple", components: poolKeyComponents },
      { name: "zeroForOne", type: "bool" },
      { name: "coinIn", type: "uint128" },
    ],
    outputs: [
      { name: "grossOut", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "netOut", type: "uint256" },
      { name: "lossCredit", type: "uint256" },
      { name: "volumeFeeComparison", type: "uint256" },
    ],
  },
] as const;

export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const permit2Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * The PoolManager's own Swap event: the only honest source for a price chart.
 *
 * sqrtPriceX96 is the pool's price AFTER the swap, so a series of these is the
 * real price history. Deriving a chart from the hook's own Bought/Sold events
 * instead would show the trader's average fill, not the pool price.
 */
export const poolManagerAbi = [
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;
