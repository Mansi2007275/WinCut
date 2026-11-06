"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useAccount, useBalance, usePublicClient, useWalletClient } from "wagmi";
import { Page } from "@/components/Shell";
import {
  AddressLink,
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  ErrorBox,
  Row,
  SectionHeading,
  StatTile,
  TxLink,
} from "@/components/ui";
import { ConnectCta, FaucetLink } from "@/components/NetworkGate";
import { useToast } from "@/components/Toast";
import { reason } from "@/components/TradePanel";
import { addr, isDeployed, QUOTE } from "@/lib/chain";
import { winCutLauncherAbi } from "@/config/abis";
import { readLaunch, type LaunchOutcome } from "@/lib/receipt";
import { useCoins } from "@/lib/data";
import { coins as fmtCoins, parseUsd, short, usd } from "@/lib/format";

/// Total supply minted and seeded into the pool. Fixed rather than asked for:
/// supply is the one number that changes nothing about the economics here (all
/// of it goes into the pool and the LP is locked), and asking for it invites a
/// typo that makes the price look absurd.
const SUPPLY = 1_000_000_000n * 10n ** 18n;

export default function LaunchPage() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();
  const { data: bal } = useBalance({ address });
  const toast = useToast();
  const coins = useCoins();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [liquidity, setLiquidity] = useState("2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<{ outcome: LaunchOutcome; hash: `0x${string}` } | null>(null);

  const initialQuote = parseUsd(liquidity);
  const cleanSymbol = symbol
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
  const enough = (bal?.value ?? 0n) > initialQuote;

  /**
   * Requirements as a checklist rather than a list of errors.
   *
   * Phrased as errors, an untouched form reads as broken: it opens with two
   * red complaints about fields nobody has typed in yet. A checklist says the
   * same thing as progress.
   */
  const checks = [
    { ok: name.trim().length >= 2, label: "Name, at least 2 characters" },
    { ok: cleanSymbol.length >= 2, label: "Ticker, at least 2 characters" },
    { ok: initialQuote > 0n, label: "Starting liquidity above $0" },
    { ok: !isConnected || enough, label: "Enough test USDC for the liquidity plus gas" },
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
      // metadataURI is left empty. It used to carry an emoji, but avatars are
      // now derived from the coin's own address, so nothing reads it -- and
      // writing a decorative character to chain storage that no screen shows
      // is just a cost with no reader.
      const hash = await wallet.writeContract({
        address: addr.launcher,
        abi: winCutLauncherAbi,
        functionName: "launchCoin",
        args: [name.trim(), cleanSymbol, "", initialQuote, SUPPLY],
        value: QUOTE.isNative ? initialQuote : 0n,
        chain: wallet.chain,
        account: wallet.account,
      });
      toast.update(id, { detail: "Waiting for the block", hash });

      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("transaction reverted");

      const outcome = readLaunch(receipt);
      if (!outcome) throw new Error("launched, but no CoinLaunched event was found");

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

  /* ------------------------------------------------------------ success */

  if (done) {
    return (
      <Page>
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 320, damping: 24 }}
        >
          <Card tone="profit" className="p-6 text-center">
            <div className="flex justify-center">
              <Avatar address={done.outcome.coin} size={48} />
            </div>
            <p className="mt-3 text-xl leading-none font-semibold text-profit">
              {done.outcome.symbol} is live
            </p>
            <p className="mt-1.5 text-sm text-secondary">{done.outcome.name}</p>
          </Card>
        </motion.div>

        <Card className="p-4">
          <Row label="Coin" value={<AddressLink address={done.outcome.coin} />} />
          <Row label="Liquidity seeded" value={usd(done.outcome.seededQuote)} />
          <Row label="Supply in pool" value={fmtCoins(done.outcome.seededCoin)} />
          <div className="my-2 border-t border-border" />
          <p className="text-[11px] leading-snug text-secondary">
            The seed LP is locked in the launcher forever — there is no function that can remove
            it. Leftover coins stay locked too, so you cannot walk away with free supply. Any
            rounding dust in {QUOTE.symbol} was refunded to you in the same transaction.
          </p>
          <div className="mt-3">
            <TxLink hash={done.hash}>View the launch on the explorer ↗</TxLink>
          </div>
        </Card>

        <Link href={`/coin/${done.outcome.coin}`}>
          <Button className="w-full py-3.5 text-base">Trade it</Button>
        </Link>
        <Button tone="elevated" className="w-full" onClick={() => setDone(null)}>
          Launch another
        </Button>
      </Page>
    );
  }

  /* --------------------------------------------------------------- form */

  return (
    <Page>
      <header>
        <h1 className="text-2xl font-semibold">Launch a coin</h1>
        <p className="mt-1.5 text-sm leading-snug text-secondary">
          One transaction: it deploys the token, opens a Uniswap v4 pool on the WinCut hook, and
          locks your liquidity in permanently.
        </p>
      </header>

      {!isDeployed ? null : (
        <>
          <Card className="p-4">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 32))}
                // Prefixed with "e.g." on purpose. A bare example here reads
                // as a filled-in field, so the form looks complete while the
                // state is still empty and the button stays disabled.
                placeholder="e.g. Mumbai Monsoon"
                aria-label="Coin name"
                className="tap w-full rounded-btn border border-border bg-elevated px-3 text-base outline-none focus:border-accent/60"
              />
            </Field>

            <Field label="Ticker">
              <div className="flex items-center gap-2">
                <span className="text-lg text-secondary">$</span>
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.slice(0, 10))}
                  placeholder="e.g. MNSN"
                  aria-label="Ticker"
                  // `uppercase` applies to the placeholder too, so the hint
                  // rendered as "E.G. MNSN". Only the typed value should shout.
                  className="tap num w-full rounded-btn border border-border bg-elevated px-3 text-base uppercase outline-none placeholder:normal-case focus:border-accent/60"
                />
              </div>
              {symbol && cleanSymbol !== symbol.toUpperCase() && (
                <p className="mt-1 text-[11px] text-secondary">
                  will be stored as ${cleanSymbol} — letters and digits only
                </p>
              )}
            </Field>

            <Field label={`Starting liquidity (${QUOTE.symbol})`}>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold">$</span>
                <input
                  inputMode="decimal"
                  value={liquidity}
                  onChange={(e) => setLiquidity(e.target.value)}
                  aria-label={`Starting liquidity in ${QUOTE.symbol}`}
                  className="num w-full min-w-0 border-0 bg-transparent text-[28px] font-semibold outline-none"
                />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {["1", "2", "5"].map((v) => (
                  <Chip key={v} onClick={() => setLiquidity(v)} active={liquidity === v}>
                    ${v}
                  </Chip>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-secondary">
                This is real test {QUOTE.symbol} from your wallet and it is locked in the pool for
                good.
                {bal && ` You hold ${usd(bal.value)}.`}
              </p>
            </Field>
          </Card>

          {/* The row the coin will appear as, built from the same pieces the
              Discover list uses, so there is no surprise after the tx. */}
          <section className="flex flex-col gap-2">
            <SectionHeading>How it will look</SectionHeading>
            <Card className="p-3">
              <div className="flex items-center gap-3">
                <Avatar address={address ?? "0x0000000000000000000000000000000000000000"} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-tight font-semibold">
                    {cleanSymbol || "TICKER"}
                  </p>
                  <p className="num mt-0.5 truncate text-[11px] text-secondary">
                    Vol $0.00 · 0 holders
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="num text-sm leading-tight font-semibold">
                    {initialQuote > 0n ? "at launch price" : "—"}
                  </p>
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Badge tone="profit">Fee only on profit</Badge>
                <span className="text-[11px] text-secondary">Uniswap v4 pool · WinCut hook</span>
              </div>
              <p className="num mt-1.5 text-[11px] text-secondary">
                {name.trim() || "Your coin"} · launched by {short(address) || "you"}
              </p>
              <p className="mt-2 text-[11px] leading-snug text-secondary">
                The avatar is generated from the coin&apos;s address, so it only exists once the
                launch confirms.
              </p>
            </Card>
          </section>

          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Supply" value="1B" sub="all seeded" />
            <StatTile label="Pool fee" value="0.30%" sub="to LPs" />
            <StatTile label="Your LP" value="Locked" sub="forever" />
          </div>

          {problems.length > 0 && (
            <Card className="p-3">
              <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-secondary uppercase">
                Before you can launch
              </p>
              {checks.map((c) => (
                <p
                  key={c.label}
                  className={`flex items-center gap-2 text-[12px] leading-relaxed ${
                    c.ok ? "text-secondary" : "text-text"
                  }`}
                >
                  <span className={c.ok ? "text-profit" : "text-secondary"}>
                    {c.ok ? "✓" : "○"}
                  </span>
                  <span className={c.ok ? "line-through" : ""}>{c.label}</span>
                </p>
              ))}
            </Card>
          )}

          {error && <ErrorBox title="Launch failed" detail={error} />}

          {isConnected ? (
            <Button
              className="w-full py-3.5 text-base"
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <label className="mb-1.5 block text-[11px] font-medium tracking-wide text-secondary uppercase">
        {label}
      </label>
      {children}
    </div>
  );
}
