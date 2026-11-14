/**
 * What the bots are, and why they exist at all.
 *
 * Testnet has no traders. The pools sit untouched for days, so a price series
 * read from them is a flat line, and a chart of a flat line looks broken even
 * though it is perfectly accurate. There are two ways to fix that. One is to
 * generate plausible-looking candles, which is lying. The other is to make real
 * trading happen on a real pool, which is what this package does: every price
 * these bots produce is the price a real on-chain swap actually executed at.
 *
 * The honest part is the labelling, not the data. Everything here is disclosed
 * on the site: the pool is WinCut's own, its price is steered toward mainnet
 * NEAR by our own market maker, and the three traders are our bots and are
 * marked as such on the leaderboard. Nobody should mistake this for an
 * independent market, because it is not one - it is a real market with a known
 * operator, which is a different thing from a fake one.
 *
 * Why its own token. The obvious design would peg a wNEAR/thUSDC pool to the
 * real NEAR price, and it does not work: a pool at $3.49 per NEAR needs wNEAR
 * and thUSDC in a 1:3.49 ratio, so the wNEAR side is the binding constraint and
 * a faucet's worth of test NEAR buys only a pool a few dollars deep. Any trade
 * big enough to see would empty it. A token we mint ourselves has no such
 * limit: we can put the depth entirely on the quote side, which is the side we
 * can actually obtain, and choose the ratio that makes one MNEAR worth one real
 * NEAR.
 */

export type Network = "testnet" | "mainnet";

const env = (k: string, fallback?: string): string => {
  const v = process.env[k]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${k} is required - see bots/README.md`);
};

const optional = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

export const NETWORK = (optional("NEAR_NETWORK") ?? "testnet") as Network;

/**
 * The testnet endpoints, in the order they are tried.
 *
 * Three that were verified to answer a real view call: FastNEAR and dRPC both
 * respond in about 350ms, and rpc.testnet.near.org takes around 3s but works.
 * `neart.lava.build` is not here because it is gone - it answers every request
 * with 410 "This endpoint has been discontinued".
 *
 * The bots lead with FastNEAR and the agent leads with dRPC, set through
 * NEAR_RPC_URLS in each package's .env. Two processes on free tiers should not
 * be queuing behind each other in one provider's bucket when there is a second
 * provider sitting idle.
 */
const DEFAULT_RPCS = [
  "https://test.rpc.fastnear.com",
  "https://near-testnet.drpc.org",
  "https://rpc.testnet.near.org",
];

const list = (k: string, fallback: string[]): string[] => {
  const raw = optional(k);
  if (!raw) return fallback;
  const parsed = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
};

export const RPC_URLS = list("NEAR_RPC_URLS", [
  optional("NEAR_RPC_URL") ?? DEFAULT_RPCS[0]!,
  ...DEFAULT_RPCS.slice(1),
]);

/** Kept for anything that still wants a single string. */
export const RPC_URL = RPC_URLS[0]!;

/** Mainnet, read-only, purely to learn what the real tokens are worth. */
export const MAINNET_RPC_URLS = list("NEAR_MAINNET_RPC_URLS", [
  optional("NEAR_MAINNET_RPC_URL") ?? "https://free.rpc.fastnear.com",
  "https://near.drpc.org",
]);

export const MAINNET_RPC_URL = MAINNET_RPC_URLS[0]!;

/**
 * How long a view may be answered from cache.
 *
 * Pool reserves and pegs move when somebody trades, and nothing here trades
 * faster than this window. Quotes used for a `min_out` are never cached: that
 * number is the only protection a trade has against the price having moved.
 */
export const VIEW_CACHE_MS = Number(optional("VIEW_CACHE_MS") ?? 12_000);

export const CONTRACT_ID = env("WINCUT_CONTRACT_ID", "wincut-mansi.testnet");
export const REF_CONTRACT = env("REF_CONTRACT", "ref-finance-101.testnet");
export const USDC_ID = env("USDC_ID", "thusdc.testnet");
export const USDC_DECIMALS = 6;

/** The first market, kept as its own export because the whole package started
 * with one and plenty of tooling still names it directly. */
export const MIRROR_TOKEN_ID = env("MIRROR_TOKEN_ID", "mnear.tkn.primitives.testnet");
export const MIRROR_SYMBOL = env("MIRROR_SYMBOL", "MNEAR");
export const MIRROR_DECIMALS = Number(optional("MIRROR_DECIMALS") ?? 24);

/** The pool the market maker keeps pegged. Set after `add_simple_pool`. */
export const MIRROR_POOL_ID = Number(env("MIRROR_POOL_ID", "0"));

// ------------------------------------------------------------- the markets

/**
 * Where a mirror token's real price comes from.
 *
 * Almost every memecoin on mainnet Rhea is quoted against wNEAR rather than
 * against a dollar stablecoin, so its dollar price is two reads: how many of it
 * one NEAR buys, and what a NEAR is worth. `viaWnear` says which shape a market
 * is, and nothing else in the code has to care.
 *
 * Read from reserves rather than `get_return`, so the number is a mid price
 * with no trade impact folded into it. Asking what one NEAR would fetch tells
 * you the price *after* your own trade, which is not the price we want to peg
 * to.
 */
export type PegSpec = {
  /** The mainnet Rhea pool holding the real token. */
  poolId: number;
  /** The real token's mainnet account, or wrap.near for the NEAR market. */
  token: string;
  decimals: number;
  /** True when the pool quotes the token against wNEAR, not against USDC. */
  viaWnear: boolean;
};

export type MarketConfig = {
  /** Our symbol, e.g. MDRAGON. */
  symbol: string;
  tokenId: string;
  decimals: number;
  /** Our testnet Rhea pool against thusdc. 0 until `add_simple_pool` has run. */
  poolId: number;
  /** The real thing this mirrors, for the log and the disclosure. */
  mirrors: string;
  peg: PegSpec;
};

/**
 * The four mirror markets.
 *
 * Hard-coded rather than read from a packed environment variable, because the
 * mainnet pool ids and decimals are facts about mainnet, not configuration: a
 * typo in a packed string would silently peg a market to the wrong token, and
 * there is no sensible way to validate it at startup. The one genuinely local
 * value is our own testnet pool id, which does not exist until the pool has
 * been created, so that is the one thing taken from the environment.
 *
 * All three memecoin mirrors use 6 decimals, where the real tokens use 24, 18
 * and 8. That is deliberate and does not change any price: a price is per whole
 * token either way. What it changes is the size of the raw integers. BLACKDRAGON
 * trades near $5.6e-9, so 400 tUSDC of depth is 7.1e10 tokens - which at 24
 * decimals is 7.1e34 raw, and Rhea's swap numerator multiplies the input amount
 * by that reserve, landing around 1e45. That is far past u128. Rhea does the
 * multiplication in u256 internally and would survive it, but seeding real
 * balances into a pool on the strength of an assumption about somebody else's
 * intermediate arithmetic is not a trade worth making. At 6 decimals every
 * number involved stays small, and 1e-6 of a token is still $5.6e-15.
 */
export const MARKETS: MarketConfig[] = [
  {
    symbol: MIRROR_SYMBOL,
    tokenId: MIRROR_TOKEN_ID,
    decimals: MIRROR_DECIMALS,
    poolId: MIRROR_POOL_ID,
    mirrors: "NEAR",
    peg: { poolId: 4512, token: "wrap.near", decimals: 24, viaWnear: false },
  },
  {
    symbol: "MDRAGON",
    tokenId: optional("MDRAGON_TOKEN_ID") ?? "mdragon.tkn.primitives.testnet",
    decimals: 6,
    poolId: Number(optional("MDRAGON_POOL_ID") ?? 0),
    mirrors: "BLACKDRAGON",
    peg: { poolId: 4276, token: "blackdragon.tkn.near", decimals: 24, viaWnear: true },
  },
  {
    symbol: "MSHITZU",
    tokenId: optional("MSHITZU_TOKEN_ID") ?? "mshitzu.tkn.primitives.testnet",
    decimals: 6,
    poolId: Number(optional("MSHITZU_POOL_ID") ?? 0),
    mirrors: "SHITZU",
    peg: { poolId: 4369, token: "token.0xshitzu.near", decimals: 18, viaWnear: true },
  },
  {
    symbol: "MLONK",
    tokenId: optional("MLONK_TOKEN_ID") ?? "mlonk.tkn.primitives.testnet",
    decimals: 6,
    poolId: Number(optional("MLONK_POOL_ID") ?? 0),
    mirrors: "LONK",
    peg: { poolId: 4314, token: "token.lonkingnearbackto2024.near", decimals: 8, viaWnear: true },
  },
];

/** The markets that actually have a pool yet. Everything live iterates these. */
export const LIVE_MARKETS = (): MarketConfig[] => MARKETS.filter((m) => m.poolId > 0);

export const marketByPool = (poolId: number): MarketConfig | undefined =>
  MARKETS.find((m) => m.poolId === poolId);

// ------------------------------------------------------------------ the peg

/**
 * Where the real NEAR price comes from: the deepest wNEAR/USDC pool on mainnet
 * Rhea, read over plain RPC. Not a price API - the same kind of source the app
 * itself uses, so there is one fewer thing that can quietly start lying.
 */
export const PEG = {
  mainnetRef: "v2.ref-finance.near",
  poolId: 4512,
  wnear: "wrap.near",
  usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  usdcDecimals: 6,
  wnearDecimals: 24,
} as const;

/**
 * How far the pool may drift from the peg before the market maker corrects it.
 *
 * Not zero. A market maker that corrects every basis point would flatten the
 * chart into the very straight line this package exists to avoid, and would
 * burn gas doing it. The band is what leaves room for the traders to actually
 * move the price.
 */
export const PEG_BAND_PCT = Number(optional("PEG_BAND_PCT") ?? 0.6);

/** Fraction of the gap the market maker closes when it does act. */
export const PEG_CORRECTION = Number(optional("PEG_CORRECTION") ?? 0.6);

/** Largest single correction, in quote units, so a bad read cannot drain a side. */
export const PEG_MAX_TRADE_USDC = Number(optional("PEG_MAX_TRADE_USDC") ?? 120);

// --------------------------------------------------------------------- bots

export type BotKind = "momentum" | "reversion" | "grid";

export type BotConfig = {
  accountId: string;
  privateKey?: string;
  kind: BotKind;
  /** One line, shown on the site next to the bot's name. */
  blurb: string;
  /** Quote units per trade. */
  sizeUsdc: number;
  /** Seconds between this bot's passes. */
  everyMs: number;
};

const botKey = (slot: number) => optional(`BOT${slot}_PRIVATE_KEY`);

/**
 * Three strategies that disagree with each other on purpose.
 *
 * A single strategy run three times would push the price one way and hold it
 * there. Momentum chases a move, reversion fades it, and the grid ignores both
 * and buys on a clock - so the three of them trade against each other, which is
 * what a market is. None of them is trying to be profitable; they are trying to
 * be a counterparty.
 */
export const BOTS: BotConfig[] = [
  {
    accountId: optional("BOT1_ACCOUNT_ID") ?? "momo.wincut-mansi.testnet",
    privateKey: botKey(1),
    kind: "momentum",
    blurb: "Buys into a move once it has run two candles, and gets out when it stalls.",
    sizeUsdc: Number(optional("BOT1_SIZE") ?? 12),
    everyMs: Number(optional("BOT1_EVERY_MS") ?? 90_000),
  },
  {
    accountId: optional("BOT2_ACCOUNT_ID") ?? "revert.wincut-mansi.testnet",
    privateKey: botKey(2),
    kind: "reversion",
    blurb: "Fades anything that moves too far from its own short average.",
    sizeUsdc: Number(optional("BOT2_SIZE") ?? 15),
    everyMs: Number(optional("BOT2_EVERY_MS") ?? 120_000),
  },
  {
    accountId: optional("BOT3_ACCOUNT_ID") ?? "grid.wincut-mansi.testnet",
    privateKey: botKey(3),
    kind: "grid",
    blurb: "Ignores the chart. Buys a fixed size on a clock and takes profit at +3%.",
    sizeUsdc: Number(optional("BOT3_SIZE") ?? 8),
    everyMs: Number(optional("BOT3_EVERY_MS") ?? 150_000),
  },
];

/** The market maker's own account. It swaps on Rhea, not through WinCut. */
export const MM_ACCOUNT_ID = optional("MM_ACCOUNT_ID") ?? "mm.wincut-mansi.testnet";
export const MM_PRIVATE_KEY = optional("MM_PRIVATE_KEY");
export const MM_EVERY_MS = Number(optional("MM_EVERY_MS") ?? 60_000);

/**
 * How often the sampling loop reads every pool.
 *
 * It was 20s, from when there was one pool. With four that is twelve reads a
 * minute for a price series whose candles are five minutes wide, which is far
 * more resolution than anything downstream uses. 35s keeps the chart smooth and
 * cuts a third of the traffic.
 */
export const TICK_MS = Number(optional("TICK_MS") ?? 35_000);

// ------------------------------------------------------------------- limits

/**
 * The same reasoning as the agent: limits live in code, and a bot that would
 * break one holds instead. These are smaller than the agent's because a bot's
 * job is to be a counterparty, not to win.
 */
export const BOT_RISK = {
  maxShareOfBalancePerTrade: 0.25,
  /**
   * The cap that actually matters, and the one that was missing.
   *
   * A limit set as a share of the trader's own balance says nothing about the
   * market it trades in. The agent's cap is 20% of its balance, which was 40
   * tUSDC - a reasonable size against the 1,000 tUSDC MNEAR pool and 8% of the
   * depth of a 400 tUSDC memecoin pool. One such buy moved MLONK 20% off its
   * peg, the maker spent the next several minutes undoing it, and the chart
   * recorded a spike that was not a price discovery of any kind: it was the
   * agent trading against itself through a pool too thin to absorb it.
   *
   * So size is capped against the pool as well. 1.5% of the quote reserve moves
   * a constant-product price by about 3%, which is a trade a market can have an
   * opinion about rather than one that overwrites it.
   */
  maxShareOfPoolDepth: 0.015,
  minTradeUsdc: 1,
  /** A bot stops buying below this, so it always has something left to trade. */
  reserveUsdc: 5,
  maxTradesPerDayEach: 400,
} as const;

export const TRADE_GAS = 250_000_000_000_000n;
export const SWAP_GAS = 180_000_000_000_000n;
export const SLIPPAGE_BPS = Number(optional("SLIPPAGE_BPS") ?? 150);

export const DRY_RUN = process.env.DRY_RUN === "1" || process.argv.includes("--dry");
export const RUN_ONCE = process.argv.includes("--once");

export const UPSTASH_URL = optional("UPSTASH_REDIS_REST_URL");
export const UPSTASH_TOKEN = optional("UPSTASH_REDIS_REST_TOKEN");

export function describeConfig(): string {
  return [
    `network    ${NETWORK}`,
    `contract   ${CONTRACT_ID}`,
    `exchange   ${REF_CONTRACT}`,
    ...MARKETS.map(
      (m) =>
        `market     ${m.symbol.padEnd(8)} ${m.tokenId.padEnd(34)} pool #${
          m.poolId || "NOT SET"
        }  mirrors ${m.mirrors}`,
    ),
    `peg        ${PEG.mainnetRef} pool #${PEG.poolId}, band ±${PEG_BAND_PCT}%`,
    `maker      ${MM_ACCOUNT_ID}${MM_PRIVATE_KEY ? "" : "  (no key - will not act)"}`,
    ...BOTS.map(
      (b) => `bot        ${b.accountId.padEnd(32)} ${b.kind}${b.privateKey ? "" : "  (no key - will not act)"}`,
    ),
    `mode       ${DRY_RUN ? "DRY RUN - decides and prints, never signs" : "live"}`,
  ].join("\n");
}
