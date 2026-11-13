"use client";

/**
 * The order panel. Market orders only, which is the honest offering: a limit
 * order would need a keeper to watch the pool and WinCut has none.
 *
 * Two numbers drive the whole panel and they come from different places on
 * purpose:
 *
 *   - the estimate updates on every keystroke from the live pool reserves,
 *     using Rhea's own formula, so dragging a percentage button is instant
 *   - the confirmation comes from Rhea's `get_return` and, on the sell side,
 *     from the contract's `quote_sell_fee`
 *
 * The fee shown on the sell side is not computed here. It is read from the
 * contract, which runs the very function the settlement callback will run, so
 * what the button says is what gets charged.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import type { LeaderboardRow, Position, TokenConfig } from "@/lib/contract";
import type { Route } from "@/lib/queries";
import {
  useInternalBalance,
  useMaxNetworkFee,
  useNearBalance,
  useOnChainQuote,
  useRefreshAfterTrade,
  useSellQuote,
  useWalletUsdc,
} from "@/lib/queries";
import { quoteRoute, withSlippage } from "@/lib/rhea";
import * as act from "@/lib/actions";
import { TRADE_GAS } from "@/lib/actions";
import { useWallet } from "@/lib/wallet";
import { useToast } from "./Toast";
import { ConnectCta } from "./Gate";
import { FeeExplainer } from "./FeeExplainer";
import { Card, Tabs } from "./ui";
import {
  price as fmtPrice,
  pct,
  shortAccount,
  signedUsd,
  tokens as fmtTokens,
  toNumber,
  toRaw,
  usd,
  usdFromNumber,
} from "@/lib/format";
import { USDC_DECIMALS, isDeployed } from "@/lib/near";

const SLIPPAGE_CHOICES = [50, 100, 300, 500] as const;
const PERCENTS = [25, 50, 75, 100] as const;
const YOCTO_PER_NEAR = 10n ** 24n;

type Side = "buy" | "sell";

export function OrderPanel({
  token,
  route,
  position,
  traders,
  followed,
  onFollowedChange,
  referrer,
  presetUsd,
}: {
  token: TokenConfig;
  route: Route | undefined;
  position: Position | null | undefined;
  /** Leaderboard, offered as the copy-trader choices. */
  traders: LeaderboardRow[] | undefined;
  followed: string | null;
  onFollowedChange: (who: string | null) => void;
  /** From ?ref= on the URL, remembered across sessions. */
  referrer: string | undefined;
  /** A size clicked in the depth ladder. */
  presetUsd?: number;
}) {
  const { accountId, sign } = useWallet();
  const toast = useToast();
  const refresh = useRefreshAfterTrade(accountId);

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [busy, setBusy] = useState(false);

  const balance = useInternalBalance(accountId);
  const walletUsdc = useWalletUsdc(accountId);
  const nearBalance = useNearBalance(accountId);
  const maxFee = useMaxNetworkFee(TRADE_GAS);

  useEffect(() => {
    if (presetUsd !== undefined && side === "buy") setAmount(String(presetUsd));
  }, [presetUsd, side]);

  // Clear a stale amount when flipping side: $100 of USDC and 100 tokens are
  // very different orders and carrying the digits over invites a mis-click.
  useEffect(() => setAmount(""), [side]);

  const decimals = side === "buy" ? USDC_DECIMALS : token.decimals;
  const amountRaw = useMemo(() => toRaw(amount, decimals), [amount, decimals]);

  const spendable =
    side === "buy" ? (balance.data ?? 0n) : BigInt(position?.amount ?? 0);

  /** Instant, from the reserves. */
  const localOut = useMemo(() => {
    if (!route || amountRaw === 0n) return 0n;
    try {
      return quoteRoute(amountRaw, side === "buy" ? route.buy : route.sell);
    } catch {
      return 0n;
    }
  }, [route, amountRaw, side]);

  /** Rhea's own answer, debounced. */
  const debounced = useDebounced(amountRaw, 400);
  const onChain = useOnChainQuote(side === "buy" ? route?.buy : route?.sell, debounced);
  const expectedOut = onChain.data !== undefined && debounced === amountRaw ? onChain.data : localOut;

  const minOut = withSlippage(expectedOut, slippageBps);

  // Sell side: the contract's own settlement for this exact sale.
  const sellQuote = useSellQuote(
    accountId,
    side === "sell" ? token.token_id : undefined,
    amountRaw,
    expectedOut,
  );

  const positionAmount = BigInt(position?.amount ?? 0);
  const costBasis = BigInt(position?.cost_basis_usdc ?? 0);
  const entryPrice =
    positionAmount > 0n
      ? toNumber(costBasis, USDC_DECIMALS) / toNumber(positionAmount, token.decimals)
      : NaN;
  const unrealised = useMemo(() => {
    if (!route || positionAmount === 0n) return undefined;
    const nowWorth = quoteRoute(positionAmount, route.sell);
    return { nowWorth, pnl: nowWorth - costBasis };
  }, [route, positionAmount, costBasis]);

  const effectivePrice = useMemo(() => {
    if (amountRaw === 0n || expectedOut === 0n) return NaN;
    return side === "buy"
      ? toNumber(amountRaw, USDC_DECIMALS) / toNumber(expectedOut, token.decimals)
      : toNumber(expectedOut, USDC_DECIMALS) / toNumber(amountRaw, token.decimals);
  }, [amountRaw, expectedOut, side, token.decimals]);

  const impact = route && Number.isFinite(effectivePrice) ? ((effectivePrice - route.mid) / route.mid) * 100 : NaN;

  const lowOnGas =
    nearBalance.data !== undefined &&
    maxFee.data !== undefined &&
    nearBalance.data < maxFee.data;

  const tooMuch = amountRaw > spendable;
  const canSubmit =
    isDeployed &&
    !!accountId &&
    !!route &&
    token.registered &&
    amountRaw > 0n &&
    !tooMuch &&
    expectedOut > 0n &&
    !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    const label =
      side === "buy"
        ? `Buying ${token.symbol} with ${usd(amountRaw)}`
        : `Selling ${fmtTokens(amountRaw, token.decimals)} ${token.symbol}`;
    const id = toast.push({ kind: "pending", title: label, detail: "waiting for the wallet…" });
    try {
      const args =
        side === "buy"
          ? act.buy({
              tokenId: token.token_id,
              usdcIn: amountRaw,
              minOut,
              followed,
              referrer: referrer ?? null,
            })
          : act.sell({ tokenId: token.token_id, amount: amountRaw, minOutUsdc: minOut });

      const hash = await sign(args);
      toast.update(id, {
        kind: "confirmed",
        title: side === "buy" ? `Bought ${token.symbol}` : `Sold ${token.symbol}`,
        detail:
          side === "buy"
            ? "The swap and the settlement land over the next few blocks."
            : sellQuote.data && BigInt(sellQuote.data.fee) === 0n
              ? "No WinCut fee on this one."
              : "Fee taken from the profit only.",
        hash,
      });
      setAmount("");
      refresh();
    } catch (e) {
      const message = (e as Error).message ?? "the wallet refused";
      toast.update(id, {
        kind: "failed",
        title: side === "buy" ? "Buy failed" : "Sell failed",
        detail: friendly(message),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-3">
        <Tabs
          options={[
            { id: "buy" as const, label: "Buy" },
            { id: "sell" as const, label: "Sell" },
          ]}
          value={side}
          onChange={(v) => setSide(v as Side)}
        />

        <p className="mt-2 text-[10px] text-secondary">
          Market order, filled by Rhea.{" "}
          <span className={side === "buy" ? "font-semibold text-profit" : ""}>
            {side === "buy" ? "WinCut fee: 0%." : "WinCut fee: 10% of profit only."}
          </span>
        </p>

        {/* ------------------------------------------------------- amount */}
        <div className="mt-3">
          <div className="flex items-baseline justify-between">
            <label htmlFor="order-amount" className="text-[10px] font-medium tracking-wide text-secondary uppercase">
              {side === "buy" ? "You pay" : "You sell"}
            </label>
            <button
              type="button"
              onClick={() => setAmount(formatMax(spendable, decimals))}
              className="text-[10px] text-secondary transition-colors hover:text-text"
              title={side === "buy" ? "Your USDC inside WinCut" : `Your ${token.symbol} position`}
            >
              balance{" "}
              <span className="num text-text">
                {side === "buy" ? usd(spendable) : fmtTokens(spendable, token.decimals)}
              </span>
            </button>
          </div>

          <div className="mt-1.5 flex items-center gap-2 rounded-btn border border-border bg-bg px-3 py-2 focus-within:border-accent">
            <input
              id="order-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              inputMode="decimal"
              placeholder="0.00"
              className="num min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none placeholder:text-secondary"
            />
            <span className="shrink-0 text-xs font-medium text-secondary">
              {side === "buy" ? "USDC" : token.symbol}
            </span>
          </div>

          <div className="mt-1.5 flex gap-1.5">
            {PERCENTS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={spendable === 0n}
                onClick={() => setAmount(formatMax((spendable * BigInt(p)) / 100n, decimals))}
                className="tap flex-1 rounded-btn border border-border bg-surface py-1 text-[11px] font-medium text-secondary transition-colors hover:bg-elevated hover:text-text disabled:opacity-40"
              >
                {p === 100 ? "max" : `${p}%`}
              </button>
            ))}
          </div>

          {tooMuch && (
            <p className="mt-1.5 text-[11px] text-loss">
              That is more than your{" "}
              {side === "buy" ? "WinCut USDC balance" : `${token.symbol} position`}.
            </p>
          )}
        </div>

        {/* ------------------------------------------------------ receive */}
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-medium tracking-wide text-secondary uppercase">
              You receive ≈
            </span>
            {onChain.isFetching && debounced === amountRaw && (
              <span className="text-[10px] text-secondary">confirming with Rhea…</span>
            )}
          </div>
          <p className="num mt-1 text-lg leading-tight font-semibold">
            {expectedOut === 0n
              ? "—"
              : side === "buy"
                ? `${fmtTokens(expectedOut, token.decimals)} ${token.symbol}`
                : usd(expectedOut)}
          </p>

          <dl className="mt-2 space-y-1 text-[11px]">
            <Row label="Fill price">
              {Number.isFinite(effectivePrice) ? fmtPrice(effectivePrice) : "—"}
            </Row>
            <Row
              label="Price impact"
              className={
                Number.isFinite(impact) && Math.abs(impact) > 3 ? "text-loss" : undefined
              }
            >
              {Number.isFinite(impact) ? pct(impact) : "—"}
            </Row>
            <Row label="Pool fee (Rhea LPs)">
              {route ? `${route.poolFeePct.toFixed(3)}%` : "—"}
            </Row>
            <Row
              label="WinCut fee"
              className={side === "buy" ? "font-semibold text-profit" : undefined}
            >
              {side === "buy" ? "$0.00" : sellFeeLabel(sellQuote.data?.fee)}
            </Row>
            <Row label="Network fee (max)" title="NEAR refunds whatever gas is not burnt">
              {maxFee.data === undefined
                ? "—"
                : `≤ ${(Number(maxFee.data) / Number(YOCTO_PER_NEAR)).toFixed(4)} NEAR`}
            </Row>
            <Row label="Minimum received" title={`Reverts below this. Slippage ${slippageBps / 100}%.`}>
              {minOut === 0n
                ? "—"
                : side === "buy"
                  ? `${fmtTokens(minOut, token.decimals)} ${token.symbol}`
                  : usd(minOut)}
            </Row>
          </dl>

          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-[10px] text-secondary">slippage</span>
            {SLIPPAGE_CHOICES.map((bps) => (
              <button
                key={bps}
                type="button"
                onClick={() => setSlippageBps(bps)}
                className={`rounded-pill border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  slippageBps === bps
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border text-secondary hover:text-text"
                }`}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
        </div>

        {/* --------------------------------------------- the sell summary */}
        {side === "sell" && positionAmount > 0n && (
          <div className="mt-3 border-t border-border pt-3">
            <dl className="space-y-1 text-[11px]">
              <Row label="Your position">
                {fmtTokens(positionAmount, token.decimals)} {token.symbol}
              </Row>
              <Row label="Cost basis">{usd(costBasis)}</Row>
              <Row label="Entry price">{Number.isFinite(entryPrice) ? fmtPrice(entryPrice) : "—"}</Row>
              <Row
                label="Unrealised P&L"
                className={
                  unrealised === undefined
                    ? undefined
                    : unrealised.pnl >= 0n
                      ? "text-profit"
                      : "text-loss"
                }
              >
                {unrealised === undefined
                  ? "—"
                  : usdFromNumber(toNumber(unrealised.pnl, USDC_DECIMALS), { sign: true })}
              </Row>
            </dl>

            {sellQuote.data && amountRaw > 0n && (
              <SellSettlement quote={sellQuote.data} />
            )}
          </div>
        )}

        {/* ----------------------------------------------- copy + referral */}
        {side === "buy" && (
          <CopySection
            traders={traders}
            followed={followed}
            onFollowedChange={onFollowedChange}
            referrer={referrer}
            me={accountId}
          />
        )}

        {/* ------------------------------------------------------- action */}
        <div className="mt-3">
          {!accountId ? (
            <ConnectCta label={`Connect to ${side} ${token.symbol}`} />
          ) : side === "buy" && (balance.data ?? 0n) === 0n ? (
            <DepositPrompt walletUsdc={walletUsdc.data} />
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              className={`tap w-full rounded-btn py-3 text-sm font-semibold text-white transition-colors disabled:opacity-40 ${
                side === "buy" ? "bg-profit hover:bg-profit/90" : "bg-loss hover:bg-loss/90"
              }`}
            >
              {busy
                ? "Signing…"
                : side === "buy"
                  ? `Buy ${token.symbol}`
                  : `Sell ${token.symbol}`}
            </button>
          )}

          {lowOnGas && (
            <p className="mt-1.5 text-[11px] text-loss">
              Your NEAR balance will not cover the gas for this trade. Top up and try again.
            </p>
          )}
          {isDeployed && !token.registered && (
            <p className="mt-1.5 text-[11px] text-loss">
              The contract has not registered {token.symbol} yet, so it will refuse the trade.
            </p>
          )}
        </div>
      </Card>

      <FeeExplainer
        basisUsdc={side === "buy" ? amountRaw : (sellQuote.data ? BigInt(sellQuote.data.basis_part) : costBasis)}
        lossCredit={sellQuote.data ? BigInt(sellQuote.data.loss_credit_before) : undefined}
        hasTrader={side === "buy" ? !!followed : !!position?.followed}
        hasReferrer={side === "buy" ? !!referrer : !!position?.referrer}
      />
    </div>
  );
}

/**
 * The exact settlement for this sale, read from the contract.
 *
 * The zero-fee cases are called out in words rather than left as "$0.00",
 * because that is the whole product and a quiet zero does not land.
 */
function SellSettlement({ quote }: { quote: import("@/lib/contract").SellOutcome }) {
  const fee = BigInt(quote.fee);
  const creditUsed = BigInt(quote.credit_used);
  const banked = BigInt(quote.credit_banked);
  const loss = quote.pnl.negative;

  return (
    <div
      className={`mt-2.5 rounded-btn border p-2.5 ${
        fee === 0n ? "border-profit/30 bg-profit-dim" : "border-border bg-elevated"
      }`}
    >
      <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">
        If you sell now
      </p>
      <dl className="mt-1.5 space-y-1 text-[11px]">
        <Row label="Basis sold">{usd(quote.basis_part)}</Row>
        <Row label={loss ? "Realised loss" : "Realised profit"} className={loss ? "text-loss" : "text-profit"}>
          {signedUsd(quote.pnl)}
        </Row>
        {creditUsed > 0n && (
          <Row label="Loss credit used" className="text-accent">
            −{usd(creditUsed)}
          </Row>
        )}
        {BigInt(quote.taxable_profit) > 0n && (
          <Row label="Taxable profit">{usd(quote.taxable_profit)}</Row>
        )}
        <Row label="WinCut fee" className={fee === 0n ? "font-semibold text-profit" : "font-semibold"}>
          {usd(fee)}
        </Row>
        <Row label="You receive" className="font-semibold">
          {usd(quote.user_receives)}
        </Row>
      </dl>

      {loss && (
        <p className="mt-1.5 text-[11px] leading-snug text-profit">
          No fee on a loss. {usd(banked)} is banked as credit and spent before any future profit
          fee.
        </p>
      )}
      {!loss && fee === 0n && creditUsed > 0n && (
        <p className="mt-1.5 text-[11px] leading-snug text-profit">
          Your banked credit covers this whole profit, so there is no fee.{" "}
          {usd(quote.loss_credit_after)} of credit is left over.
        </p>
      )}
      {fee > 0n && (
        <p className="mt-1.5 text-[11px] leading-snug text-secondary">
          Split {usd(quote.to_trader)} trader · {usd(quote.to_referrer)} referrer ·{" "}
          {usd(quote.to_protocol)} protocol.
        </p>
      )}
    </div>
  );
}

function CopySection({
  traders,
  followed,
  onFollowedChange,
  referrer,
  me,
}: {
  traders: LeaderboardRow[] | undefined;
  followed: string | null;
  onFollowedChange: (who: string | null) => void;
  referrer: string | undefined;
  me: string | null;
}) {
  // A trader cannot earn from their own trade, so offering yourself in the list
  // would be offering a share that silently goes to the protocol instead.
  const options = (traders ?? []).filter((t) => t.account_id !== me);

  return (
    <div className="mt-3 border-t border-border pt-3">
      <label
        htmlFor="copy-trader"
        className="text-[10px] font-medium tracking-wide text-secondary uppercase"
      >
        Copying
      </label>
      <select
        id="copy-trader"
        value={followed ?? ""}
        onChange={(e) => onFollowedChange(e.target.value || null)}
        className="mt-1.5 w-full rounded-btn border border-border bg-bg px-3 py-2 text-xs outline-none focus:border-accent"
      >
        <option value="">Nobody — their 50% goes to the protocol</option>
        {options.map((t) => (
          <option key={t.account_id} value={t.account_id}>
            {shortAccount(t.account_id)} · {signedUsd(t.realised_pnl)} realised ·{" "}
            {t.followers} copying
          </option>
        ))}
      </select>
      <p className="mt-1 text-[10px] leading-relaxed text-secondary">
        They earn 50% of the fee, and only if you exit this position in profit. Set once per
        position by the opening buy.
        {options.length === 0 && " Nobody has traded on WinCut yet, so the list is empty."}
      </p>

      <div className="mt-2 flex items-baseline justify-between text-[10px]">
        <span className="text-secondary">Referrer</span>
        {referrer ? (
          <span className="num text-text" title={referrer}>
            {shortAccount(referrer)} · 20%
          </span>
        ) : (
          <span className="text-secondary">none on this link</span>
        )}
      </div>
    </div>
  );
}

function DepositPrompt({ walletUsdc }: { walletUsdc: bigint | undefined }) {
  return (
    <div className="rounded-btn border border-accent/30 bg-accent-dim p-3">
      <p className="text-xs font-semibold text-accent">No USDC inside WinCut yet</p>
      <p className="mt-1 text-[11px] leading-relaxed text-secondary">
        WinCut settles from an internal USDC balance, so trades need no approval per swap. Your
        wallet holds {walletUsdc === undefined ? "…" : usd(walletUsdc)}.
      </p>
      <Link
        href="/me"
        className="tap mt-2 block w-full rounded-btn bg-accent py-2 text-center text-xs font-semibold text-white hover:bg-accent/90"
      >
        Deposit USDC →
      </Link>
    </div>
  );
}

function Row({
  label,
  children,
  className = "",
  title,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <dt className="text-secondary">{label}</dt>
      <dd className={`num ${className}`}>{children}</dd>
    </div>
  );
}

function sellFeeLabel(fee: string | undefined): string {
  if (fee === undefined) return "10% of profit";
  return BigInt(fee) === 0n ? "$0.00" : usd(fee);
}

/** Trims a raw amount to a string the input can hold without rounding up. */
function formatMax(raw: bigint, decimals: number): string {
  if (raw === 0n) return "";
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Turns a chain panic into something a trader can act on. */
function friendly(message: string): string {
  if (/another settlement is in flight/.test(message))
    return "Another trade is settling on WinCut right now. It clears in a few seconds - try again.";
  if (/not enough USDC/.test(message)) return "Not enough USDC in your WinCut balance.";
  if (/ERR_MIN_AMOUNT|slippage|min_amount_out/i.test(message))
    return "The pool moved past your slippage limit. Raise it or trade a smaller size.";
  if (/User (closed|rejected|cancelled)|rejected the request/i.test(message))
    return "You cancelled the signature.";
  if (/Exceeded the prepaid gas/.test(message))
    return "The trade ran out of gas. Try again - the panel attaches 200 Tgas.";
  return message.slice(0, 220);
}

/** Holds a value still until it stops changing, so Rhea is not asked per key. */
function useDebounced<T>(value: T, ms: number): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return held;
}
