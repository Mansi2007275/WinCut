import { decodeEventLog, type Address, type Hex, type TransactionReceipt } from "viem";
import { winCutHookAbi, winCutLauncherAbi } from "@/config/abis";
import { addr } from "./chain";

/**
 * What actually happened, read back out of the transaction receipt.
 *
 * Everything here is decoded from events the hook emitted inside the swap. The
 * UI previously recomputed the 50/20/30 split in JavaScript, which meant the
 * result screen could disagree with the chain — it would have kept showing a
 * tidy 50/20/30 even if the contract had split differently, and it quietly
 * hid the fact that the treasury absorbs the rounding dust.
 *
 * Reading the receipt removes that whole class of lie: if the numbers on screen
 * are wrong, the chain is wrong.
 */
export type SellOutcome = {
  kind: "sell";
  coins: bigint;
  proceeds: bigint;
  /// Realised profit or loss, signed, as the hook computed it.
  pnl: bigint;
  /// 10% of profit after loss credits. 0 on a losing exit.
  fee: bigint;
  split?: {
    followed: Address;
    traderCut: bigint;
    referrer: Address;
    referrerCut: bigint;
    treasuryCut: bigint;
  };
  /// Set when this exit banked a loss.
  lossCredited?: { loss: bigint; newCredit: bigint };
  /// Set when banked losses were spent to reduce the fee.
  creditConsumed?: { used: bigint; remaining: bigint };
};

export type BuyOutcome = {
  kind: "buy";
  coins: bigint;
  cost: bigint;
  followed?: Address;
  referrer?: Address;
};

export type LaunchOutcome = {
  kind: "launch";
  coin: Address;
  poolId: Hex;
  name: string;
  symbol: string;
  seededQuote: bigint;
  seededCoin: bigint;
};

const ZERO = "0x0000000000000000000000000000000000000000";

/// Decodes only logs the given contract emitted, ignoring everything else in
/// the transaction. Anything that fails to decode is skipped rather than thrown:
/// a receipt legitimately contains PoolManager and ERC-20 logs too.
function decodeFrom<T extends readonly unknown[]>(
  receipt: TransactionReceipt,
  source: Address,
  abi: T,
): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== source.toLowerCase()) continue;
    try {
      // viem types `args` as a union of every event's shape in the ABI, which
      // collapses to `readonly unknown[] | undefined` here. Narrowing through
      // `unknown` is the documented escape hatch; the field names are then
      // checked against the ABI constants by the call sites below.
      const d = decodeEventLog({
        abi: abi as never,
        data: log.data,
        topics: log.topics,
      }) as unknown as { eventName: string; args?: Record<string, unknown> };
      out.push({ name: d.eventName, args: d.args ?? {} });
    } catch {
      continue;
    }
  }
  return out;
}

export function readSell(receipt: TransactionReceipt, trader: Address): SellOutcome | null {
  const events = decodeFrom(receipt, addr.hook, winCutHookAbi);
  const me = (v: unknown) => String(v).toLowerCase() === trader.toLowerCase();

  const sold = events.find((e) => e.name === "Sold" && me(e.args.trader));
  if (!sold) return null;

  const split = events.find((e) => e.name === "FeeSplit" && me(e.args.trader));
  const credited = events.find((e) => e.name === "LossCredited" && me(e.args.trader));
  const consumed = events.find((e) => e.name === "CreditConsumed" && me(e.args.trader));

  return {
    kind: "sell",
    coins: sold.args.coins as bigint,
    proceeds: sold.args.proceeds as bigint,
    pnl: sold.args.pnl as bigint,
    fee: sold.args.fee as bigint,
    split: split
      ? {
          followed: split.args.followed as Address,
          traderCut: split.args.traderCut as bigint,
          referrer: split.args.referrer as Address,
          referrerCut: split.args.referrerCut as bigint,
          treasuryCut: split.args.treasuryCut as bigint,
        }
      : undefined,
    lossCredited: credited
      ? { loss: credited.args.loss as bigint, newCredit: credited.args.newCredit as bigint }
      : undefined,
    creditConsumed: consumed
      ? { used: consumed.args.used as bigint, remaining: consumed.args.remaining as bigint }
      : undefined,
  };
}

export function readBuy(receipt: TransactionReceipt, trader: Address): BuyOutcome | null {
  const events = decodeFrom(receipt, addr.hook, winCutHookAbi);
  const bought = events.find(
    (e) => e.name === "Bought" && String(e.args.trader).toLowerCase() === trader.toLowerCase(),
  );
  if (!bought) return null;

  const followed = bought.args.followed as Address;
  const referrer = bought.args.referrer as Address;
  return {
    kind: "buy",
    coins: bought.args.coins as bigint,
    cost: bought.args.cost as bigint,
    followed: followed === ZERO ? undefined : followed,
    referrer: referrer === ZERO ? undefined : referrer,
  };
}

export function readLaunch(receipt: TransactionReceipt): LaunchOutcome | null {
  const events = decodeFrom(receipt, addr.launcher, winCutLauncherAbi);
  const launched = events.find((e) => e.name === "CoinLaunched");
  if (!launched) return null;
  return {
    kind: "launch",
    coin: launched.args.coin as Address,
    poolId: launched.args.id as Hex,
    name: launched.args.name as string,
    symbol: launched.args.symbol as string,
    seededQuote: launched.args.seededQuote as bigint,
    seededCoin: launched.args.seededCoin as bigint,
  };
}

/**
 * A buy emits no Bought event when the router was not trusted, or when
 * msgSender() could not identify the trader. That is a real condition worth
 * surfacing: the trade succeeded, but it earned no attribution and no position,
 * so a later sell would be unattributed too.
 */
export function wasAttributed(receipt: TransactionReceipt, trader: Address): boolean {
  return readBuy(receipt, trader) !== null || readSell(receipt, trader) !== null;
}
