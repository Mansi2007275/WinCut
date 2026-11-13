"use client";

/**
 * Deposit USDC from another chain, through NEAR Intents 1Click.
 *
 * The honest shape of this is "here is an address, send to it" - WinCut signs
 * nothing, holds nothing and cannot move the funds. So the panel's job is to
 * get the address right, say exactly what will arrive and where, and then
 * tell the truth about what is happening while it does.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import * as intents from "@/lib/intents";
import { chainLabel } from "@/lib/intents";
import { useWallet } from "@/lib/wallet";
import { useRefreshAfterTrade } from "@/lib/queries";
import { isAccountId } from "@/lib/referral";
import { CONTRACT_ID, isDeployed } from "@/lib/near";
import { shortAccount, toRaw } from "@/lib/format";
import { Card, SectionHeading } from "./ui";

/** 1Click's USDC is 6 decimals on every chain but BNB, which uses 18. */
const decimalsOf = (token: intents.OneClickToken) => token.decimals ?? 6;

export function BridgeDeposit() {
  const { accountId } = useWallet();
  const refresh = useRefreshAfterTrade(accountId);

  const [originId, setOriginId] = useState<string>("");
  const [amount, setAmount] = useState("25");
  const [refundTo, setRefundTo] = useState("");
  const [intoWinCut, setIntoWinCut] = useState(false);
  const [quote, setQuote] = useState<intents.Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const origins = useQuery({
    queryKey: ["1click-usdc-origins"],
    queryFn: ({ signal }) => intents.supportedUsdcOrigins(signal),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const origin = useMemo(
    () => origins.data?.find((t) => t.assetId === originId),
    [origins.data, originId],
  );

  // Default to Base: cheap, fast, and the USDC people most often have spare.
  useEffect(() => {
    if (!originId && origins.data?.length) {
      const base = origins.data.find((t) => t.blockchain === "base");
      setOriginId((base ?? origins.data[0]).assetId);
    }
  }, [origins.data, originId]);

  const amountRaw = useMemo(
    () => (origin ? toRaw(amount, decimalsOf(origin)) : 0n),
    [amount, origin],
  );

  // A live estimate, which reserves nothing.
  const preview = useQuery({
    queryKey: ["1click-preview", originId, amountRaw.toString()],
    queryFn: ({ signal }) =>
      intents.priceOnly(
        { originAsset: originId, amount: amountRaw.toString(), nearAccount: accountId!, intoWinCut: false },
        signal,
      ),
    enabled: !!originId && amountRaw > 0n && !!accountId,
    staleTime: 20_000,
    retry: 0,
  });

  const status = useQuery({
    queryKey: ["1click-status", quote?.depositAddress],
    queryFn: ({ signal }) => intents.swapStatus(quote!.depositAddress, quote?.depositMemo, signal),
    enabled: !!quote,
    refetchInterval: 5_000,
    retry: 1,
  });

  // Once it lands, the balances on screen are stale by definition.
  useEffect(() => {
    if (status.data?.status === "SUCCESS") refresh();
  }, [status.data?.status, refresh]);

  const refundLooksWrong =
    refundTo.length > 0 &&
    origin !== undefined &&
    !looksLikeAddressFor(origin.blockchain, refundTo);

  async function getQuote() {
    if (!accountId || !origin || amountRaw === 0n) return;
    setBusy(true);
    setError(null);
    try {
      const q = await intents.requestQuote({
        originAsset: origin.assetId,
        amount: amountRaw.toString(),
        refundTo,
        nearAccount: accountId,
        intoWinCut,
      });
      setQuote(q);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!accountId) return null;

  return (
    <Card className="p-3">
      <SectionHeading right={<span className="text-[10px] text-secondary">NEAR Intents</span>}>
        Bring USDC from another chain
      </SectionHeading>
      <p className="mt-1 text-[11px] leading-relaxed text-secondary">
        A 1Click swap bridges USDC from Ethereum, Base, Arbitrum, Solana and others into native
        USDC on NEAR. WinCut never holds the funds in between - you send to an address 1Click
        gives you, and a solver delivers on this side.
      </p>

      {origins.isError ? (
        <p className="mt-2 rounded-btn border border-loss/30 bg-loss-dim px-3 py-2 text-[11px] text-loss">
          Could not reach NEAR Intents: {(origins.error as Error).message}
        </p>
      ) : !quote ? (
        <div className="mt-3 flex flex-col gap-2.5">
          <label className="block">
            <span className="text-[10px] font-medium tracking-wide text-secondary uppercase">
              From
            </span>
            <select
              value={originId}
              onChange={(e) => setOriginId(e.target.value)}
              disabled={origins.isPending}
              className="mt-1 w-full rounded-btn border border-border bg-bg px-3 py-2 text-xs outline-none focus:border-accent"
            >
              {origins.isPending && <option>Loading chains…</option>}
              {origins.data?.map((t) => (
                <option key={t.assetId} value={t.assetId}>
                  USDC on {chainLabel(t.blockchain)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[10px] font-medium tracking-wide text-secondary uppercase">
              Amount
            </span>
            <div className="mt-1 flex items-center gap-2 rounded-btn border border-border bg-bg px-3 py-2 focus-within:border-accent">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                inputMode="decimal"
                className="num min-w-0 flex-1 bg-transparent text-base font-semibold outline-none"
              />
              <span className="shrink-0 text-xs text-secondary">USDC</span>
            </div>
            <span className="mt-1 block text-[10px] text-secondary">
              {preview.data
                ? `≈ ${preview.data.amountOutFormatted} USDC on NEAR, about ${preview.data.timeEstimate}s`
                : preview.isFetching
                  ? "pricing…"
                  : preview.isError
                    ? `1Click will not quote that: ${(preview.error as Error).message}`
                    : " "}
            </span>
          </label>

          <label className="block">
            <span className="text-[10px] font-medium tracking-wide text-secondary uppercase">
              Refund address on {origin ? chainLabel(origin.blockchain) : "the origin chain"}
            </span>
            <input
              value={refundTo}
              onChange={(e) => setRefundTo(e.target.value.trim())}
              placeholder={origin?.blockchain === "sol" ? "your Solana address" : "0x…"}
              className="num mt-1 w-full rounded-btn border border-border bg-bg px-3 py-2 text-[11px] outline-none focus:border-accent"
            />
            <span className="mt-1 block text-[10px] leading-relaxed text-secondary">
              Where the USDC goes back to if the swap does not complete. Use the address you are
              sending from.
            </span>
            {refundLooksWrong && (
              <span className="mt-1 block text-[10px] text-loss">
                That does not look like a {chainLabel(origin!.blockchain)} address.
              </span>
            )}
          </label>

          {isDeployed && (
            <label className="flex items-start gap-2 rounded-btn border border-border bg-elevated p-2.5">
              <input
                type="checkbox"
                checked={intoWinCut}
                onChange={(e) => setIntoWinCut(e.target.checked)}
                className="mt-0.5 shrink-0 accent-accent"
              />
              <span className="text-[11px] leading-relaxed">
                <span className="font-semibold">Deliver straight into my WinCut balance</span>
                <span className="block text-secondary">
                  Saves a second signature. It relies on 1Click&apos;s{" "}
                  <code>customRecipientMsg</code>, which its own docs call highly experimental, so
                  it is off by default. Leave it off and the USDC lands in your NEAR wallet, where
                  one more click deposits it.
                </span>
              </span>
            </label>
          )}

          {error && (
            <p className="rounded-btn border border-loss/30 bg-loss-dim px-3 py-2 text-[11px] break-words text-loss">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void getQuote()}
            disabled={busy || amountRaw === 0n || !refundTo || !origin}
            className="tap w-full rounded-btn bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            {busy ? "Asking 1Click…" : "Get a deposit address"}
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2.5">
          <div className="rounded-btn border border-accent/30 bg-accent-dim p-3">
            <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">
              Send exactly {quote.amountInFormatted} USDC on{" "}
              {origin ? chainLabel(origin.blockchain) : "the origin chain"} to
            </p>
            <div className="mt-1.5 flex items-start gap-2">
              <code className="num min-w-0 flex-1 break-all rounded-btn border border-border bg-bg px-2.5 py-2 text-[11px]">
                {quote.depositAddress}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(quote.depositAddress);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
                className="tap shrink-0 rounded-btn border border-border bg-surface px-2.5 py-2 text-[11px] font-medium hover:bg-elevated"
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>
            {quote.depositMemo && (
              <p className="num mt-1.5 text-[11px] text-loss">
                Memo required: {quote.depositMemo} — the deposit is lost without it.
              </p>
            )}
            <dl className="mt-2.5 space-y-1 text-[11px]">
              <Row label="You receive">≈ {quote.amountOutFormatted} USDC on NEAR</Row>
              <Row label="At worst">{formatRaw(quote.minAmountOut)} USDC</Row>
              <Row label="Lands in">
                {quote.intoWinCut
                  ? `your WinCut balance (${shortAccount(CONTRACT_ID)})`
                  : `your NEAR wallet (${shortAccount(quote.recipient)})`}
              </Row>
              <Row label="Usually takes">about {quote.timeEstimate}s once confirmed</Row>
              {quote.deadline && (
                <Row label="Address expires">
                  {new Date(quote.deadline).toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Row>
              )}
            </dl>
          </div>

          <StatusBox
            result={status.data}
            loading={status.isPending}
            intoWinCut={quote.intoWinCut}
          />

          <button
            type="button"
            onClick={() => {
              setQuote(null);
              setError(null);
            }}
            className="tap w-full rounded-btn border border-border py-2 text-[11px] font-medium text-secondary hover:text-text"
          >
            Start another deposit
          </button>
        </div>
      )}
    </Card>
  );
}

function StatusBox({
  result,
  loading,
  intoWinCut,
}: {
  result: intents.StatusResult | undefined;
  loading: boolean;
  intoWinCut: boolean;
}) {
  if (loading || !result) {
    return (
      <p className="rounded-btn border border-border bg-elevated px-3 py-2 text-[11px] text-secondary">
        Watching for your deposit…
      </p>
    );
  }
  const d = intents.describeStatus(result.status, intoWinCut);
  const tone = {
    pending: "border-border bg-elevated text-text",
    done: "border-profit/30 bg-profit-dim text-profit",
    failed: "border-loss/30 bg-loss-dim text-loss",
  }[d.tone];

  return (
    <div className={`rounded-btn border px-3 py-2 ${tone}`}>
      <p className="text-xs font-semibold">{d.label}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-secondary">{d.detail}</p>
      {result.destinationTxHashes.length > 0 && (
        <a
          href={`https://nearblocks.io/txns/${result.destinationTxHashes[0]}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-[11px] text-accent underline underline-offset-2"
        >
          view the NEAR transaction ↗
        </a>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-secondary">{label}</dt>
      <dd className="num text-right">{children}</dd>
    </div>
  );
}

/** 1Click returns raw 6-decimal units for USDC on every supported chain. */
function formatRaw(raw: string): string {
  const n = Number(raw) / 1e6;
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

/**
 * A shape check on the refund address, not a validation.
 *
 * Getting this wrong means a refund goes nowhere recoverable, so it is worth
 * catching an obviously pasted-from-the-wrong-chain address. It deliberately
 * only warns: an unknown chain should not block a deposit.
 */
function looksLikeAddressFor(chain: string, address: string): boolean {
  if (/^(eth|arb|base|pol|bsc|op|avax|gnosis|monad)$/.test(chain)) {
    return /^0x[0-9a-fA-F]{40}$/.test(address);
  }
  if (chain === "sol") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (chain === "near") return isAccountId(address);
  return true;
}
