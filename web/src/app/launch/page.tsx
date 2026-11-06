"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useAccount, useBalance, usePublicClient, useWalletClient } from "wagmi";
import { Page } from "@/components/Shell";
import { AddressLink, Button, Card, Chip, ErrorBox, Row, StatTile, TxLink } from "@/components/ui";
import { ConnectCta, FaucetLink } from "@/components/NetworkGate";
import { useToast } from "@/components/Toast";
import { reason } from "@/components/TradePanel";
import { addr, isDeployed, QUOTE } from "@/lib/chain";
import { winCutLauncherAbi } from "@/config/abis";
import { readLaunch, type LaunchOutcome } from "@/lib/receipt";
import { useCoins } from "@/lib/data";
import { coins as fmtCoins, parseUsd, usd } from "@/lib/format";

/// Total supply minted and seeded into the pool. Fixed rather than asked for:
/// supply is the one number that changes nothing about the economics here (all
/// of it goes into the pool and the LP is locked), and asking for it invites a
/// typo that makes the price look absurd.
const SUPPLY = 1_000_000_000n * 10n ** 18n;

const EMOJI = ["🚀", "🐸", "🐕", "🌙", "🔥", "💎", "🦍", "🧃", "⚡", "🪩", "🧿", "🥐"];

export default function LaunchPage() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();
  const { data: bal } = useBalance({ address });
  const toast = useToast();
  const coins = useCoins();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [emoji, setEmoji] = useState(EMOJI[0]);
  const [liquidity, setLiquidity] = useState("2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<{ outcome: LaunchOutcome; hash: `0x${string}` } | null>(null);

  const initialQuote = parseUsd(liquidity);
  const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const enough = (bal?.value ?? 0n) > initialQuote;

  /**
   * Requirements as a checklist rather than a list of errors.
   *
   * Phrased as errors, an untouched form reads as broken: it opens with two red
   * complaints about fields nobody has typed in yet. A checklist says the same
   * thing as progress.
   */
  const checks = [
    { ok: name.trim().length >= 2, label: "Name, at least 2 characters" },
    { ok: cleanSymbol.length >= 2, label: "Ticker, at least 2 characters" },
    { ok: initialQuote > 0n, label: "Starting liquidity above $0" },
    {
      ok: !isConnected || enough,
      label: "Enough test USDC for the liquidity plus gas",
    },
  ];
  const problems = checks.filter((c) => !c.ok);

  async function launch() {
    if (!wallet || !client || !address) return;
    setBusy(true);
    setError(undefined);
    const id = toast.push({
      kind: "pending",
      title: `Launching ${cleanSymbol}`,
      detail: "Approve in your wallet",
    });

    try {
      // metadataURI carries the emoji. The launcher stores it on the coin, so
      // the choice survives without any off-chain database.
      const hash = await wallet.writeContract({
        address: addr.launcher,
        abi: winCutLauncherAbi,
        functionName: "launchCoin",
        args: [name.trim(), cleanSymbol, emoji, initialQuote, SUPPLY],
        value: QUOTE.isNative ? initialQuote : 0n,
        chain: wallet.chain,
        account: wallet.account,
      });
      toast.update(id, { detail: "Waiting for the block", hash });

      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("transaction reverted");

      const outcome = readLaunch(receipt);
      if (!outcome) throw new Error("launched, but no CoinLaunched event was found in the receipt");

      toast.update(id, {
        kind: "confirmed",
        title: `${outcome.symbol} is live`,
        detail: undefined,
        hash,
      });
      setDone({ outcome, hash });
      coins.refetch();
    } catch (e) {
      const msg = reason(e);
      setError(msg);
      toast.update(id, { kind: "failed", title: "Launch failed", detail: msg });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Page>
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 22 }}
        >
          <Card tone="profit" className="p-6 text-center">
            <p className="text-5xl leading-none">{emoji}</p>
            <p className="mt-2 font-display text-2xl uppercase leading-none">
              {done.outcome.symbol} is live
            </p>
            <p className="mt-1 text-sm">{done.outcome.name}</p>
          </Card>
        </motion.div>

        <Card className="p-4">
          <Row label="Coin" value={<AddressLink address={done.outcome.coin} />} />
          <Row label="Liquidity seeded" value={usd(done.outcome.seededQuote)} />
          <Row label="Supply in pool" value={fmtCoins(done.outcome.seededCoin)} />
          <div className="my-2 border-t-3 border-ink" />
          <p className="font-mono text-[10px] leading-snug text-muted">
            The seed LP is locked in the launcher forever — there is no function that can remove
            it. Leftover coins stay locked too, so you cannot walk away with free supply. Any
            rounding dust in USDC was refunded to you in the same transaction.
          </p>
          <div className="mt-3">
            <TxLink hash={done.hash}>{done.hash}</TxLink>
          </div>
        </Card>

        <Link href={`/coin/${done.outcome.coin}`}>
          <Button tone="accent" className="w-full py-4 text-lg">
            Trade it
          </Button>
        </Link>
        <Button tone="elevated" className="w-full" onClick={() => setDone(null)}>
          Launch another
        </Button>
      </Page>
    );
  }

  return (
    <Page>
      <div>
        <h1 className="text-2xl uppercase">Launch a coin</h1>
        <p className="mt-1 text-xs leading-snug text-muted">
          One transaction: it deploys the token, opens a Uniswap v4 pool on the WinCut hook, and
          locks your liquidity in permanently.
        </p>
      </div>

      {!isDeployed ? null : (
        <>
          <Card className="p-4">
            <label className="mb-1 block font-display text-xs uppercase text-muted">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 32))}
              // Prefixed with "e.g." on purpose. A bare example here reads as a
              // filled-in field, so the form looks complete while the state is
              // still empty and the button stays disabled.
              placeholder="e.g. Mumbai Monsoon"
              aria-label="Coin name"
              className="nb-sm w-full bg-white px-3 py-2 text-base outline-none"
            />

            <label className="mb-1 mt-4 block font-display text-xs uppercase text-muted">
              Ticker
            </label>
            <div className="flex items-center gap-2">
              <span className="font-display text-xl">$</span>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.slice(0, 10))}
                placeholder="e.g. MNSN"
                aria-label="Ticker"
                className="nb-sm money w-full bg-white px-3 py-2 text-base uppercase outline-none"
              />
            </div>
            {symbol && cleanSymbol !== symbol.toUpperCase() && (
              <p className="mt-1 font-mono text-[10px] text-muted">
                will be stored as ${cleanSymbol} — letters and digits only
              </p>
            )}

            <label className="mb-1 mt-4 block font-display text-xs uppercase text-muted">
              Emoji
            </label>
            <div className="flex flex-wrap gap-2">
              {EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  aria-label={`Pick ${e}`}
                  aria-pressed={emoji === e}
                  className={`nb-sm nb-press h-10 w-10 text-xl leading-none ${
                    emoji === e ? "bg-brand" : "bg-white"
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>

            <label className="mb-1 mt-4 block font-display text-xs uppercase text-muted">
              Starting liquidity ({QUOTE.symbol})
            </label>
            <div className="flex items-center gap-2">
              <span className="font-display text-2xl">$</span>
              <input
                inputMode="decimal"
                value={liquidity}
                onChange={(e) => setLiquidity(e.target.value)}
                aria-label="Starting liquidity in USDC"
                className="money w-full min-w-0 border-0 bg-transparent text-3xl outline-none"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {["1", "2", "5"].map((v) => (
                <Chip key={v} onClick={() => setLiquidity(v)} active={liquidity === v}>
                  ${v}
                </Chip>
              ))}
            </div>
            <p className="mt-2 font-mono text-[10px] leading-snug text-muted">
              This is real test USDC from your wallet and it is locked in the pool for good.
              {bal && ` You hold ${usd(bal.value)}.`}
            </p>
          </Card>

          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Supply" value="1B" sub="all seeded" />
            <StatTile label="Pool fee" value="0.30%" sub="to LPs" />
            <StatTile label="Your LP" value="Locked" sub="forever" />
          </div>

          {problems.length > 0 && (
            <Card className="p-3">
              <p className="mb-1 font-display text-[10px] uppercase text-muted">
                Before you can launch
              </p>
              {checks.map((c) => (
                <p
                  key={c.label}
                  className={`text-[11px] leading-relaxed ${c.ok ? "text-muted line-through" : ""}`}
                >
                  <span className="money mr-1">{c.ok ? "✓" : "○"}</span>
                  {c.label}
                </p>
              ))}
            </Card>
          )}

          {error && <ErrorBox title="Launch failed" detail={error} />}

          {isConnected ? (
            <Button
              tone="accent"
              className="w-full py-4 text-lg"
              disabled={busy || problems.length > 0}
              onClick={launch}
            >
              {busy ? "Launching…" : `Launch $${cleanSymbol || "COIN"}`}
            </Button>
          ) : (
            <ConnectCta label="Connect to launch" />
          )}

          <div className="flex justify-center">
            <FaucetLink />
          </div>
        </>
      )}
    </Page>
  );
}
