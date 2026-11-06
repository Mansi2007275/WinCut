"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address } from "viem";
import { Button, Card, Chip, Row, Tabs, ErrorBox, Skeleton } from "./ui";
import { ConnectCta, FaucetLink } from "./NetworkGate";
import { useToast } from "./Toast";
import {
  useAccountState,
  useCoinBalance,
  useMaxTradeSize,
  usePosition,
  type Coin,
} from "@/lib/data";
import { addr, QUOTE, buyDirection, sellDirection } from "@/lib/chain";
import { erc20Abi, permit2Abi, universalRouterAbi } from "@/config/abis";
import { quoteBuy, quoteSell } from "@/lib/quote";
import { buildSwap, encodeAttribution, deadline, MAX_UINT160 } from "@/lib/swap";
import { readBuy, readSell, type BuyOutcome, type SellOutcome } from "@/lib/receipt";
import { usd, coins as fmtCoins, parseUsd, applySlippage, short } from "@/lib/format";

const SLIPPAGE_BPS = 50; // 0.5%

type Side = "buy" | "sell";

export type TradeResult = {
  side: Side;
  hash: `0x${string}`;
  sell?: SellOutcome;
  buy?: BuyOutcome;
  /// True when the hook recorded nothing, i.e. the swap happened but was not
  /// attributed. Worth saying out loud rather than showing a blank result.
  unattributed?: boolean;
};

export function TradePanel({
  coin,
  follow,
  referrer,
  initialSide = "buy",
  onResult,
}: {
  coin: Coin;
  follow?: Address;
  referrer?: Address;
  initialSide?: Side;
  onResult: (r: TradeResult) => void;
}) {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();
  const toast = useToast();

  const [side, setSide] = useState<Side>(initialSide);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const position = usePosition(address, coin.poolId);
  const coinBal = useCoinBalance(coin.address, address);
  const acct = useAccountState(address);
  const maxTrade = useMaxTradeSize();
  /// 0 means the owner has not set a cap. Declared here, above the quote
  /// effect that reports TradeTooLarge(), so there is no use-before-define.
  const cap = maxTrade.data ?? 0n;

  const amountQuote = side === "buy" ? parseUsd(amount) : 0n;
  const sellCoins = useMemo(() => {
    if (side !== "sell" || !amount) return 0n;
    const share = Number(amount);
    const bal = coinBal.data ?? 0n;
    if (!Number.isFinite(share) || share <= 0) return 0n;
    return (bal * BigInt(Math.round(Math.min(100, share) * 100))) / 10_000n;
  }, [side, amount, coinBal.data]);

  // ---- the quote. The fee ALWAYS comes from the contract. ----
  const [quote, setQuote] = useState<null | {
    grossOut: bigint;
    fee: bigint;
    netOut: bigint;
    lossCredit: bigint;
    volumeFee: bigint;
    coinsOut?: bigint;
  }>(null);
  const [quoting, setQuoting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!client) return setQuote(null);
      const input = side === "buy" ? amountQuote : sellCoins;
      if (input <= 0n) return setQuote(null);

      setQuoting(true);
      try {
        if (side === "buy") {
          const out = await quoteBuy(client, {
            key: coin.poolKey,
            zeroForOne: buyDirection(coin.poolKey),
            amountIn: input,
          });
          if (!cancelled)
            setQuote({
              grossOut: 0n,
              fee: 0n,
              netOut: 0n,
              lossCredit: acct.data?.lossCredit ?? 0n,
              volumeFee: (input * 50n) / 10_000n,
              coinsOut: out,
            });
        } else {
          const q = await quoteSell(client, {
            trader: address ?? addr.hook,
            key: coin.poolKey,
            zeroForOne: sellDirection(coin.poolKey),
            coinIn: input,
          });
          if (!cancelled) setQuote(q);
        }
        if (!cancelled) setError(undefined);
      } catch (e) {
        if (!cancelled) {
          setQuote(null);
          setError(reason(e, cap));
        }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    };
    const t = setTimeout(run, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [client, coin, side, amountQuote, sellCoins, address, acct.data?.lossCredit, cap]);

  /**
   * The hook caps the QUOTE side of every trade and reverts TradeTooLarge()
   * above it -- `spent` on a buy, `grossOut` on a sell. Checking both here
   * means the button is disabled before the wallet ever opens, instead of the
   * user paying gas to discover the limit.
   */
  const tradeQuoteSide = side === "buy" ? amountQuote : (quote?.grossOut ?? 0n);
  const overLimit = cap > 0n && tradeQuoteSide > cap;

  /// Profit shown in the preview is the pool's gross minus the proportional
  /// cost basis the hook is holding. The fee itself still comes from quoteFee.
  const previewProfit =
    quote && side === "sell" && position.data
      ? quote.grossOut - proportionalBasis(position.data, sellCoins)
      : undefined;

  async function submit() {
    if (!wallet || !client || !address) return;
    setBusy(true);
    setError(undefined);

    const isBuy = side === "buy";
    const toastId = toast.push({
      kind: "pending",
      title: isBuy ? `Buying ${coin.symbol}` : `Selling ${coin.symbol}`,
      detail: "Approve in your wallet",
    });

    try {
      const amountIn = isBuy ? amountQuote : sellCoins;
      // minOut is derived from netOut. A gross-derived figure makes every
      // profitable sell revert, because the router checks the POST-hook amount.
      const minOut = isBuy ? 0n : applySlippage(quote?.netOut ?? 0n, SLIPPAGE_BPS);

      if (!isBuy) {
        const allowance = await client.readContract({
          address: coin.address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, addr.permit2],
        });
        if (allowance < amountIn) {
          toast.update(toastId, { detail: "Approving the coin for Permit2" });
          const h = await wallet.writeContract({
            address: coin.address,
            abi: erc20Abi,
            functionName: "approve",
            args: [addr.permit2, 2n ** 256n - 1n],
          });
          await client.waitForTransactionReceipt({ hash: h });
        }
        toast.update(toastId, { detail: "Permitting the router" });
        const h2 = await wallet.writeContract({
          address: addr.permit2,
          abi: permit2Abi,
          functionName: "approve",
          args: [
            coin.address,
            addr.universalRouter,
            MAX_UINT160,
            Math.floor(Date.now() / 1000) + 86_400,
          ],
        });
        await client.waitForTransactionReceipt({ hash: h2 });
      }

      const plan = buildSwap({
        key: coin.poolKey,
        zeroForOne: isBuy ? buyDirection(coin.poolKey) : sellDirection(coin.poolKey),
        amountIn,
        amountOutMinimum: minOut,
        hookData: isBuy ? encodeAttribution(follow, referrer) : encodeAttribution(),
        quoteIsNative: QUOTE.isNative,
      });

      const txHash = await wallet.writeContract({
        address: addr.universalRouter,
        abi: universalRouterAbi,
        functionName: "execute",
        args: [plan.commands, plan.inputs, deadline()],
        value: plan.value,
      });
      toast.update(toastId, { detail: "Waiting for the block", hash: txHash });

      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("transaction reverted");

      // Everything on the result screen is read back out of the receipt, so the
      // numbers are the chain's, not ours.
      const sell = isBuy ? null : readSell(receipt, address);
      const buy = isBuy ? readBuy(receipt, address) : null;

      toast.update(toastId, {
        kind: "confirmed",
        title:
          !isBuy && sell
            ? sell.fee > 0n
              ? `Sold at a profit · fee ${usd(sell.fee)}`
              : "Sold at a loss · fee $0"
            : `Bought ${coin.symbol}`,
        detail: undefined,
        hash: txHash,
      });

      setAmount("");
      position.refetch();
      coinBal.refetch();
      acct.refetch();

      onResult({
        side,
        hash: txHash,
        sell: sell ?? undefined,
        buy: buy ?? undefined,
        unattributed: !sell && !buy,
      });
    } catch (e) {
      const msg = reason(e, cap);
      setError(msg);
      toast.update(toastId, { kind: "failed", title: "Transaction failed", detail: msg });
    } finally {
      setBusy(false);
    }
  }

  const bal = coinBal.data ?? 0n;
  const canSubmit =
    isConnected &&
    !!quote &&
    !busy &&
    !overLimit &&
    (side === "buy" ? amountQuote > 0n : sellCoins > 0n && sellCoins <= bal);

  return (
    <div className="flex flex-col gap-3">
      <Tabs
        options={[
          { id: "buy" as Side, label: "Buy" },
          { id: "sell" as Side, label: "Sell" },
        ]}
        value={side}
        onChange={(v) => {
          setSide(v);
          setAmount("");
        }}
      />

      {follow && (
        <div className="nb-sm bg-info px-3 py-2 text-white">
          <p className="font-display text-xs uppercase">Copying this trade</p>
          <p className="font-mono text-[10px]">
            {short(follow)} earns 50% of the fee, and only if you profit
          </p>
        </div>
      )}

      <Card className="p-4">
        <label className="mb-2 block font-display text-xs uppercase text-muted">
          {side === "buy" ? `Amount in ${QUOTE.symbol}` : "Percent of your position"}
        </label>
        <div className="flex items-center gap-2">
          <span className="font-display text-2xl">{side === "buy" ? "$" : ""}</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            aria-label={side === "buy" ? "Amount in USDC" : "Percent of position"}
            className="money w-full min-w-0 border-0 bg-transparent text-3xl outline-none"
          />
          {side === "sell" && <span className="font-display text-2xl">%</span>}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {side === "buy"
            ? ["10", "50", "100"].map((v) => (
                <Chip key={v} onClick={() => setAmount(v)}>
                  ${v}
                </Chip>
              ))
            : ["25", "50", "100"].map((v) => (
                <Chip key={v} onClick={() => setAmount(v)}>
                  {v}%
                </Chip>
              ))}
        </div>

        {side === "sell" && (
          <p className="mt-2 font-mono text-[11px] text-muted">
            holding {fmtCoins(bal)} {coin.symbol} · selling {fmtCoins(sellCoins)}
          </p>
        )}
      </Card>

      {/* ------------------------- FEE PREVIEW ------------------------- */}
      {side === "sell" && sellCoins > 0n && (
        <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {quoting && !quote ? (
            <Card className="p-4">
              <Skeleton className="mb-2 h-3 w-1/3" />
              <Skeleton className="mb-2 h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </Card>
          ) : quote ? (
            <Card tone={quote.fee > 0n ? "accent" : "profit"} className="p-4">
              <p className="mb-2 font-display text-sm uppercase">
                {quote.fee > 0n ? "You profited" : "No profit, no fee"}
              </p>
              <Row label="Gross proceeds" value={usd(quote.grossOut)} />
              {previewProfit !== undefined && (
                <Row
                  label="Your profit"
                  value={usd(previewProfit, { sign: true })}
                  tone={previewProfit >= 0n ? "profit" : "loss"}
                />
              )}
              {quote.lossCredit > 0n && (
                <Row label="Loss credit available" value={usd(quote.lossCredit)} tone="accent" />
              )}
              <div className="my-2 border-t-3 border-ink" />
              <Row
                label="WinCut fee (10% of profit)"
                value={usd(quote.fee)}
                strong
                tone={quote.fee > 0n ? "text" : "profit"}
              />
              <Row
                label="A 0.5%-of-volume app would charge"
                value={usd(quote.volumeFee)}
                tone="muted"
              />
              <div className="my-2 border-t-3 border-ink" />
              <Row label="You receive" value={usd(quote.netOut)} strong />
              <p className="mt-2 font-mono text-[10px] leading-snug text-ink/60">
                Quote from contract (WinCutQuoter → hook.quoteFee). minOut is derived from this
                net figure with {SLIPPAGE_BPS / 100}% slippage.
              </p>
            </Card>
          ) : null}
        </motion.div>
      )}

      {side === "buy" && amountQuote > 0n && (
        <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {quoting && !quote ? (
            <Card className="p-4">
              <Skeleton className="mb-2 h-3 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </Card>
          ) : quote?.coinsOut !== undefined ? (
            <Card className="p-4">
              <Row
                label="You receive"
                value={`${fmtCoins(quote.coinsOut)} ${coin.symbol}`}
                strong
              />
              <Row label="WinCut fee on buys" value="$0.00" tone="profit" />
              <p className="mt-2 font-mono text-[10px] leading-snug text-muted">
                Quote from contract. Buys are never charged — the fee only applies when you exit
                at a profit.
              </p>
            </Card>
          ) : null}
        </motion.div>
      )}

      {overLimit && (
        <ErrorBox title={maxTradeLabel(cap)} detail={capDetail(side, tradeQuoteSide)} />
      )}

      {error && <ErrorBox title="Quote or transaction failed" detail={error} />}

      {isConnected ? (
        <Button
          onClick={submit}
          disabled={!canSubmit}
          tone={side === "buy" ? "accent" : "profit"}
          className="w-full py-4 text-lg"
        >
          {busy ? "Confirming…" : side === "buy" ? `Buy ${coin.symbol}` : `Sell ${coin.symbol}`}
        </Button>
      ) : (
        <ConnectCta label={`Connect to ${side} ${coin.symbol}`} />
      )}

      {isConnected && side === "buy" && <FaucetLink className="self-start" />}
    </div>
  );
}

function proportionalBasis(pos: { amount: bigint; cost: bigint }, selling: bigint): bigint {
  if (pos.amount === 0n || selling === 0n) return 0n;
  const attributed = selling > pos.amount ? pos.amount : selling;
  return (pos.cost * attributed) / pos.amount;
}

/// The cap, phrased the one way it is phrased everywhere in the app.
export function maxTradeLabel(cap: bigint): string {
  return `Max trade on testnet is ${usd(cap)}`;
}

function capDetail(side: Side, attempted: bigint): string {
  return side === "buy"
    ? `This buy is ${usd(attempted)}. Lower the amount to continue.`
    : `This sell would return ${usd(attempted)} in gross proceeds. Sell a smaller percentage.`;
}

/// Raised when the hook rejects a trade above maxTradeSize. Declared in
/// winCutHookAbi, but the revert can also arrive wrapped by the router, so it
/// is matched on the selector too.
const TRADE_TOO_LARGE_SELECTOR = "0x04213078";

export function reason(e: unknown, cap?: bigint): string {
  if (!e) return "unknown error";
  const m = e as {
    shortMessage?: string;
    details?: string;
    message?: string;
    data?: unknown;
  };
  const text = m.shortMessage ?? m.details ?? m.message ?? String(e);
  const haystack = `${text} ${JSON.stringify(m.data ?? "")} ${String(e)}`;
  if (
    haystack.includes("TradeTooLarge") ||
    haystack.includes(TRADE_TOO_LARGE_SELECTOR)
  ) {
    return cap && cap > 0n
      ? maxTradeLabel(cap)
      : "That trade is over the testnet limit for this hook";
  }
  return text;
}
