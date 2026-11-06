"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address } from "viem";
import { Page } from "@/components/Shell";
import { Card, Button, Chip, Tabs, Row, Loading, Empty, ErrorBox, Badge, TxState } from "@/components/ui";
import { useCoins, usePosition, useCoinBalance, useAccountState } from "@/lib/data";
import { addr, QUOTE, buyDirection, sellDirection, deployed, explorerTx } from "@/lib/chain";
import { winCutQuoterAbi, erc20Abi, permit2Abi, universalRouterAbi } from "@/config/abis";
import { buildSwap, encodeAttribution, deadline, MAX_UINT160 } from "@/lib/swap";
import { usd, coins as fmtCoins, parseUsd, applySlippage, handle, short } from "@/lib/format";
import { Result } from "@/components/Result";

const SLIPPAGE_BPS = 50; // 0.5%
const REF_KEY = "wincut.referrer";

type Side = "buy" | "sell";
type TxStatus = "idle" | "pending" | "confirmed" | "failed";

export default function TradePage() {
  return (
    <Suspense fallback={<Page><Loading label="Starting up" /></Page>}>
      <Trade />
    </Suspense>
  );
}

function Trade() {
  const params = useSearchParams();
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();

  const coinsQ = useCoins();
  const [selected, setSelected] = useState<Address | undefined>();
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<TxStatus>("idle");
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<null | {
    side: Side; pnl?: bigint; fee?: bigint; credit?: bigint; received?: bigint; hash: `0x${string}`;
  }>(null);

  // ?follow= sets who you are copying; ?ref= is remembered for later sessions.
  const follow = (params.get("follow") as Address | null) ?? undefined;
  const [referrer, setReferrer] = useState<Address | undefined>();
  useEffect(() => {
    const fromUrl = params.get("ref") as Address | null;
    if (fromUrl) {
      try { localStorage.setItem(REF_KEY, fromUrl); } catch {}
      setReferrer(fromUrl);
      return;
    }
    try {
      const saved = localStorage.getItem(REF_KEY) as Address | null;
      if (saved) setReferrer(saved);
    } catch {}
  }, [params]);

  const coin = useMemo(
    () => coinsQ.data?.find((c) => c.address === selected) ?? coinsQ.data?.[0],
    [coinsQ.data, selected],
  );

  const position = usePosition(address, coin?.poolId);
  const coinBal = useCoinBalance(coin?.address, address);
  const acct = useAccountState(address);

  const amountQuote = side === "buy" ? parseUsd(amount) : 0n;
  const sellCoins = useMemo(() => {
    if (side !== "sell" || !amount) return 0n;
    const pctOfPosition = Number(amount);
    const bal = coinBal.data ?? 0n;
    if (!Number.isFinite(pctOfPosition) || pctOfPosition <= 0) return 0n;
    return (bal * BigInt(Math.round(Math.min(100, pctOfPosition) * 100))) / 10_000n;
  }, [side, amount, coinBal.data]);

  // ---- the quote. Fee ALWAYS from the contract, never recomputed here. ----
  const [quote, setQuote] = useState<null | {
    grossOut: bigint; fee: bigint; netOut: bigint; lossCredit: bigint; volumeFee: bigint; coinsOut?: bigint;
  }>(null);
  const [quoting, setQuoting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!client || !coin) return setQuote(null);
      const input = side === "buy" ? amountQuote : sellCoins;
      if (input <= 0n) return setQuote(null);

      setQuoting(true);
      try {
        if (side === "buy") {
          const out = await client.readContract({
            address: addr.quoter,
            abi: winCutQuoterAbi,
            functionName: "quoteBuy",
            args: [coin.poolKey, buyDirection(coin.poolKey), input],
          });
          if (!cancelled) setQuote({ grossOut: 0n, fee: 0n, netOut: 0n, lossCredit: acct.data?.lossCredit ?? 0n, volumeFee: (input * 50n) / 10_000n, coinsOut: out });
        } else {
          const r = await client.readContract({
            address: addr.quoter,
            abi: winCutQuoterAbi,
            functionName: "quoteSell",
            args: [address ?? addr.hook, coin.poolKey, sellDirection(coin.poolKey), input],
          });
          if (!cancelled)
            setQuote({ grossOut: r[0], fee: r[1], netOut: r[2], lossCredit: r[3], volumeFee: r[4] });
        }
        if (!cancelled) setError(undefined);
      } catch (e) {
        if (!cancelled) { setQuote(null); setError(reason(e)); }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    };
    const t = setTimeout(run, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [client, coin, side, amountQuote, sellCoins, address, acct.data?.lossCredit]);

  const profit = quote && side === "sell" && position.data
    ? quote.grossOut - proportionalBasis(position.data, sellCoins)
    : undefined;

  async function submit() {
    if (!wallet || !client || !coin || !address) return;
    setStatus("pending"); setError(undefined); setHash(undefined);

    try {
      const isBuy = side === "buy";
      const amountIn = isBuy ? amountQuote : sellCoins;
      // minOut comes from netOut. Deriving it from the gross quote would make
      // every profitable sell revert on the router's slippage check.
      const minOut = isBuy ? 0n : applySlippage(quote?.netOut ?? 0n, SLIPPAGE_BPS);

      if (!isBuy) {
        const allowance = await client.readContract({
          address: coin.address, abi: erc20Abi, functionName: "allowance",
          args: [address, addr.permit2],
        });
        if (allowance < amountIn) {
          const h = await wallet.writeContract({
            address: coin.address, abi: erc20Abi, functionName: "approve",
            args: [addr.permit2, 2n ** 256n - 1n],
          });
          await client.waitForTransactionReceipt({ hash: h });
        }
        const h2 = await wallet.writeContract({
          address: addr.permit2, abi: permit2Abi, functionName: "approve",
          args: [coin.address, addr.universalRouter, MAX_UINT160, Math.floor(Date.now() / 1000) + 86_400],
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
      setHash(txHash);

      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error("transaction reverted");

      setStatus("confirmed");
      setResult({
        side,
        pnl: profit,
        fee: quote?.fee,
        credit: quote?.lossCredit,
        received: isBuy ? quote?.coinsOut : quote?.netOut,
        hash: txHash,
      });
      setAmount("");
      position.refetch(); coinBal.refetch(); acct.refetch();
    } catch (e) {
      setStatus("failed");
      setError(reason(e));
    }
  }

  if (coinsQ.isLoading) return <Page><Loading label="Reading coins from chain" /></Page>;
  if (coinsQ.error) return <Page><ErrorBox title="Cannot reach the chain" detail={reason(coinsQ.error)} /></Page>;
  if (!coinsQ.data?.length)
    return (
      <Page>
        <Empty
          title="No coins yet"
          hint="Run ./scripts/dev.sh to deploy and seed real trades on an Arc fork."
        />
      </Page>
    );

  if (result)
    return (
      <Page>
        <Result {...result} onDone={() => { setResult(null); setStatus("idle"); }} />
      </Page>
    );

  const bal = coinBal.data ?? 0n;
  const canSubmit =
    isConnected && !!quote && status !== "pending" &&
    (side === "buy" ? amountQuote > 0n : sellCoins > 0n && sellCoins <= bal);

  return (
    <Page>
      {/* coin picker */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {coinsQ.data.map((c) => (
          <Chip key={c.address} active={c.address === coin?.address} onClick={() => { setSelected(c.address); setAmount(""); }}>
            {c.symbol}
          </Chip>
        ))}
      </div>

      {follow && (
        <div className="nb-sm bg-info px-3 py-2 text-white">
          <p className="font-display text-xs uppercase">Copying {handle(follow)}</p>
          <p className="font-mono text-[10px]">{short(follow)} earns only if you profit</p>
        </div>
      )}

      <Tabs
        options={[{ id: "buy" as Side, label: "Buy" }, { id: "sell" as Side, label: "Sell" }]}
        value={side}
        onChange={(v) => { setSide(v); setAmount(""); }}
      />

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
            className="money w-full border-0 bg-transparent text-3xl outline-none"
          />
          {side === "sell" && <span className="font-display text-2xl">%</span>}
        </div>

        <div className="mt-3 flex gap-2">
          {side === "buy"
            ? ["10", "50", "100"].map((v) => (
                <Chip key={v} onClick={() => setAmount(v)}>${v}</Chip>
              ))
            : ["25", "50", "100"].map((v) => (
                <Chip key={v} onClick={() => setAmount(v)}>{v}%</Chip>
              ))}
          {side === "sell" && <Chip onClick={() => setAmount("100")}>MAX</Chip>}
        </div>

        {side === "sell" && (
          <p className="mt-2 font-mono text-[11px] text-muted">
            holding {fmtCoins(bal)} {coin?.symbol} · selling {fmtCoins(sellCoins)}
          </p>
        )}
      </Card>

      {/* ---------------- FEE PREVIEW ---------------- */}
      {side === "sell" && quote && sellCoins > 0n && (
        <Card tone={quote.fee > 0n ? "brand" : "profit"} className="p-4">
          <p className="mb-2 font-display text-sm uppercase">
            {quote.fee > 0n ? "You profited" : "No profit, no fee"}
          </p>
          <Row label="Gross proceeds" value={usd(quote.grossOut)} />
          {profit !== undefined && (
            <Row
              label="Your profit"
              value={usd(profit, { sign: true })}
              tone={profit >= 0n ? "profit" : "loss"}
            />
          )}
          {quote.lossCredit > 0n && (
            <Row label="Loss credit applied" value={usd(quote.lossCredit)} tone="info" />
          )}
          <div className="my-2 border-t-3 border-ink" />
          <Row label="WinCut fee (10% of profit)" value={usd(quote.fee)} strong tone={quote.fee > 0n ? "ink" : "profit"} />
          <Row label="A 0.5%-of-volume app would charge" value={usd(quote.volumeFee)} tone="muted" />
          <div className="my-2 border-t-3 border-ink" />
          <Row label="You receive" value={usd(quote.netOut)} strong />
          <p className="mt-2 font-mono text-[10px] leading-snug text-ink/60">
            Fee read from the contract (hook.quoteFee). minOut is derived from this net figure,
            with {SLIPPAGE_BPS / 100}% slippage.
          </p>
        </Card>
      )}

      {side === "buy" && quote?.coinsOut !== undefined && amountQuote > 0n && (
        <Card className="p-4">
          <Row label="You receive" value={`${fmtCoins(quote.coinsOut)} ${coin?.symbol}`} strong />
          <Row label="WinCut fee on buys" value="$0.00" tone="profit" />
          <p className="mt-2 font-mono text-[10px] leading-snug text-muted">
            Buys are never charged. The fee only applies when you exit at a profit.
          </p>
        </Card>
      )}

      {quoting && <p className="font-mono text-[11px] text-muted">quoting…</p>}
      {error && <ErrorBox title="Quote or transaction failed" detail={error} />}
      <TxState status={status} hash={hash} explorer={deployed.explorer} />

      <Button
        onClick={submit}
        disabled={!canSubmit}
        tone={side === "buy" ? "brand" : "profit"}
        className="w-full py-4 text-lg"
      >
        {!isConnected
          ? "Connect wallet"
          : status === "pending"
            ? "Confirming…"
            : side === "buy"
              ? `Buy ${coin?.symbol ?? ""}`
              : `Sell ${coin?.symbol ?? ""}`}
      </Button>

      {acct.data && (
        <div className="flex flex-wrap gap-2">
          {acct.data.lossCredit > 0n && <Badge tone="info">loss credit {usd(acct.data.lossCredit)}</Badge>}
          {acct.data.claimable > 0n && <Badge tone="profit">claimable {usd(acct.data.claimable)}</Badge>}
          {referrer && <Badge>ref {short(referrer)}</Badge>}
        </div>
      )}
    </Page>
  );
}

function proportionalBasis(pos: { amount: bigint; cost: bigint }, selling: bigint): bigint {
  if (pos.amount === 0n || selling === 0n) return 0n;
  const attributed = selling > pos.amount ? pos.amount : selling;
  return (pos.cost * attributed) / pos.amount;
}

function reason(e: unknown): string {
  if (!e) return "unknown error";
  const m = e as { shortMessage?: string; details?: string; message?: string };
  return m.shortMessage ?? m.details ?? m.message ?? String(e);
}

export { explorerTx };
