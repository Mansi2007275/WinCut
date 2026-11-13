/**
 * Disclosure for the parts of this testnet that WinCut operates itself.
 *
 * Testnet has no traders, so left alone the pools sit untouched and every chart
 * is a flat line. WinCut fixes that by running a real market: its own token,
 * its own pool, a market maker that keeps the pool's price tracking real
 * mainnet NEAR, and three trader bots that disagree with each other. Every
 * price that comes out of it is the price a real on-chain swap executed at.
 *
 * None of that is a problem. Presenting it as an independent market would be.
 * So this module exists to make sure the site says, wherever those accounts and
 * that market appear, exactly what they are - and the labels are deliberately
 * specific rather than a vague "demo" notice, because the useful question for
 * a viewer is not "is this testnet" but "who decided this price".
 */

/** Accounts WinCut runs as trader bots, marked wherever they are shown. */
export const BOT_ACCOUNTS: string[] = (process.env.NEXT_PUBLIC_BOT_ACCOUNTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** The market maker. Not a trader, and not ranked as one. */
export const MM_ACCOUNT = process.env.NEXT_PUBLIC_MM_ACCOUNT?.trim() || undefined;

/** The token whose pool WinCut operates and pegs. */
export const MIRROR_TOKEN_ID = process.env.NEXT_PUBLIC_MIRROR_TOKEN_ID?.trim() || undefined;

const botSet = new Set(BOT_ACCOUNTS);

export const isBot = (accountId: string | undefined): boolean => Boolean(accountId && botSet.has(accountId));

export const isMarketMaker = (accountId: string | undefined): boolean =>
  Boolean(accountId && MM_ACCOUNT && accountId === MM_ACCOUNT);

/** True for any account WinCut operates rather than a person. */
export const isOperated = (accountId: string | undefined): boolean =>
  isBot(accountId) || isMarketMaker(accountId);

export const isMirrorMarket = (tokenId: string | undefined): boolean =>
  Boolean(tokenId && MIRROR_TOKEN_ID && tokenId === MIRROR_TOKEN_ID);

export const BOT_NOTE =
  "This is one of WinCut's own trading bots, not a person. It runs a fixed strategy on a timer so that testnet has trades in it at all. Its results are real and read from the contract, but copying it is copying a script, and it is not tuned to be profitable.";

export const MM_NOTE =
  "This account is WinCut's market maker, not a trader. It does not trade through WinCut; it swaps on the exchange to keep the pool's price tracking real mainnet NEAR, which is what stops the bots walking the price somewhere meaningless.";

export const MIRROR_MARKET_NOTE =
  "WinCut operates this market. The token was minted by us, the pool is ours, and its price is steered toward the live mainnet NEAR price by our own market maker while three of our bots trade against each other inside it. Every candle is a real on-chain swap at a real executed price - but this is a market with a known operator, not independent price discovery.";

export const MIRROR_MARKET_WHY =
  "It exists because testnet has no traders. A pool nobody touches gives a flat chart, and the alternative to running a real market was generating candles that only looked like one.";
