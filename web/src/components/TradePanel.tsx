"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address } from "viem";
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
import { usd, parseUsd, applySlippage } from "@/lib/format";

export const SLIPPAGE_BPS = 50; // 0.5%

export type Side = "buy" | "sell";

export type TradeResult = {
  side: Side;
  hash: `0x${string}`;
  sell?: SellOutcome;
  buy?: BuyOutcome;
  /// True when the hook recorded nothing, i.e. the swap happened but was not
  /// attributed. Worth saying out loud rather than showing a blank result.
  unattributed?: boolean;
};

export type Quote = {
  grossOut: bigint;
  fee: bigint;
  netOut: bigint;
  lossCredit: bigint;
  volumeFee: bigint;
  coinsOut?: bigint;
};

/// Which of the three signatures a sell is on. A buy is a single step, so it
/// only ever reaches "sell".
export type Step = "approve" | "permit" | "sell";

/**
 * Everything a trade needs, with no markup attached.
 *
 * Split out of the panel so the buy and sell sheets can lay the same numbers
 * out very differently without either of them owning a copy of the logic --
 * and so that the one rule that matters, minOut derived from netOut, exists
 * exactly once.
 */
export function useTrade({
  coin,
  side,
  follow,
  referrer,
  onResult,
}: {
  coin: Coin;
  side: Side;
  follow?: Address;
  referrer?: Address;
  onResult: (r: TradeResult) => void;
}) {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();
  const toast = useToast();

  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step | null>(null);
  const [done, setDone] = useState<Step[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);

  const position = usePosition(address, coin.poolId);
  const coinBal = useCoinBalance(coin.address, address);
  const acct = useAccountState(address);
  const maxTrade = useMaxTradeSize();
  /// 0 means the owner has not set a cap.
  const cap = maxTrade.data ?? 0n;

  const amountQuote = side === "buy" ? parseUsd(amount) : 0n;
  const bal = coinBal.data ?? 0n;

  const sellCoins = useMemo(() => {
    if (side !== "sell" || !amount) return 0n;
    const share = Number(amount);
    if (!Number.isFinite(share) || share <= 0) return 0n;
    return (bal * BigInt(Math.round(Math.min(100, share) * 100))) / 10_000n;
  }, [side, amount, bal]);

  // ---- the quote. The fee ALWAYS comes from the contract. ----
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
  const basis = position.data ? proportionalBasis(position.data, sellCoins) : 0n;
  const previewProfit = quote && side === "sell" ? quote.grossOut - basis : undefined;

  // minOut is derived from netOut. A gross-derived figure makes every
  // profitable sell revert, because the router checks the POST-hook amount.
  const minOut = side === "buy" ? 0n : applySlippage(quote?.netOut ?? 0n, SLIPPAGE_BPS);

  const canSubmit =
    isConnected &&
    !!quote &&
    !busy &&
    !overLimit &&
    (side === "buy" ? amountQuote > 0n : sellCoins > 0n && sellCoins <= bal);

  async function submit() {
    if (!wallet || !client || !address) return;
    setBusy(true);
    setError(undefined);
    setDone([]);

    const isBuy = side === "buy";
    const toastId = toast.push({
      kind: "pending",
      title: isBuy ? `Buying ${coin.symbol}` : `Selling ${coin.symbol}`,
      detail: "Approve in your wallet",
    });

    try {
      const amountIn = isBuy ? amountQuote : sellCoins;

      if (!isBuy) {
        setStep("approve");
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
        setDone((d) => [...d, "approve"]);

        setStep("permit");
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
        setDone((d) => [...d, "permit"]);
      }

      setStep("sell");
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

      // Everything on the result screen is read back out of the receipt, so
      // the numbers are the chain's, not ours.
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
      setDone((d) => [...d, "sell"]);
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
      setStep(null);
    }
  }

  return {
    amount,
    setAmount,
    amountQuote,
    sellCoins,
    balance: bal,
    position: position.data,
    basis,
    quote,
    quoting,
    previewProfit,
    minOut,
    cap,
    overLimit,
    tradeQuoteSide,
    busy,
    step,
    done,
    error,
    canSubmit,
    isConnected,
    submit,
  };
}

export function proportionalBasis(
  pos: { amount: bigint; cost: bigint },
  selling: bigint,
): bigint {
  if (pos.amount === 0n || selling === 0n) return 0n;
  const attributed = selling > pos.amount ? pos.amount : selling;
  return (pos.cost * attributed) / pos.amount;
}

/// The cap, phrased the one way it is phrased everywhere in the app.
export function maxTradeLabel(cap: bigint): string {
  return `Max trade on testnet is ${usd(cap)}`;
}

export function capDetail(side: Side, attempted: bigint): string {
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
  if (haystack.includes("TradeTooLarge") || haystack.includes(TRADE_TOO_LARGE_SELECTOR)) {
    return cap && cap > 0n
      ? maxTradeLabel(cap)
      : "That trade is over the testnet limit for this hook";
  }
  return text;
}
