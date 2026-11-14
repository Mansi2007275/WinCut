"use client";

/**
 * How the fee works, for somebody who has two minutes and no reason to trust
 * us yet.
 *
 * The order is an argument rather than a tour. The rule first, then the rule
 * run on numbers the reader chooses, then the rule run across a sequence where
 * it actually costs something - because "no fee on losses" is easy to say and
 * only means anything once you have watched a fee appear.
 *
 * After that, the three things a sceptic asks: can you take my position, can
 * your bot drain me, and are you solvent. Each is answered with a live read
 * rather than a sentence, and the one unflattering answer on this page - the
 * agent's running loss - is printed next to the others.
 */

import Link from "next/link";
import { useMemo } from "react";

import { Page } from "@/components/Shell";
import {
  Calculator,
  Frame,
  Section,
  TradeRun,
} from "@/components/explain/parts";
import { AGENT_ACCOUNT_ID, decidedByLabel } from "@/lib/agent";
import { MIRROR_TOKEN_IDS } from "@/lib/bots";
import { ago, usdFromNumber } from "@/lib/format";
import { explorerAccount } from "@/lib/explorer";
import { CONTRACT_ID, NETWORK, REF_CONTRACT, USDC_ID, isDeployed } from "@/lib/near";
import {
  useAgentLog,
  useConfig,
  useContractUsdcHeld,
  useSolvency,
  useTokens,
} from "@/lib/queries";

export default function HowItWorks() {
  const config = useConfig();
  const agent = useAgentLog(true, 3);
  const solvency = useSolvency();
  const held = useContractUsdcHeld();
  const tokens = useTokens();

  const feePct = (config.data?.fee_bps_of_profit ?? 1000) / 100;
  const gap = useMemo(
    () =>
      held.data !== undefined && solvency.data !== undefined
        ? held.data - solvency.data
        : undefined,
    [held.data, solvency.data],
  );

  return (
    <Page width="lg" banners={false}>
      {/* 1 ------------------------------------------------------------ hero */}
      <header className="field-grid -mx-4 border-y border-border px-4 py-8 sm:py-10">
        <h1 className="text-[26px] leading-[1.12] font-semibold tracking-tight sm:text-[34px]">
          Every trading app gets paid when you lose.
          <br />
          <span className="text-profit">WinCut doesn&apos;t.</span>
        </h1>
        <p className="mono mt-3 max-w-xl text-[12px] leading-relaxed text-secondary">
          The platform, the trader you copied and your referrer are paid only out of your profit.
          A losing exit costs nothing and banks a credit against your next win.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href="/trade"
            className="tap rounded-btn bg-accent px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90"
          >
            Start trading
          </Link>
          <Link
            href="/dashboard"
            className="tap rounded-btn border border-border px-4 py-2 text-[13px] font-semibold hover:bg-elevated"
          >
            Watch the Cut Field
          </Link>
        </div>
      </header>

      {/* 2 ------------------------------------------------------ calculator */}
      <Section
        id="calculator"
        title="Run the rule yourself"
        lead={`Drag the exit. The fee is ${feePct}% of realised profit, after any banked credit is spent — and nothing at all on a loss.`}
      >
        <Calculator />
      </Section>

      {/* 3 ---------------------------------------------------------- a run */}
      <Section
        id="run"
        title="A run of trades"
        lead="One trade proves nothing. Here are four, with the credit carried between them, and a fee that appears exactly once."
      >
        <TradeRun />
      </Section>

      {/* 4 ------------------------------------------------- can't be gamed */}
      <Section
        id="trust"
        title="Why it can't be gamed"
        lead="Three questions a sceptic asks. Each is answered by something you can read, not something we say."
      >
        <div className="grid gap-3 lg:grid-cols-3">
          <Frame className="p-3">
            <h3 className="mono text-[11px] font-semibold">The contract holds the position</h3>
            <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">
              A buy spends an internal USDC balance and the tokens land in the contract&apos;s own
              account under a position record — amount, cost basis, copied trader, referrer. No
              method moves a token out. <span className="text-text">Only USDC withdraws</span>:
              both <code className="text-text">withdraw</code> and{" "}
              <code className="text-text">claim</code> touch the USDC ledger alone, so a position
              cannot be smuggled out to dodge settlement.
            </p>
            {isDeployed && (
              <a
                href={explorerAccount(CONTRACT_ID)}
                target="_blank"
                rel="noreferrer"
                className="mono mt-2 inline-block text-[10px] text-accent hover:underline"
              >
                {CONTRACT_ID} ↗
              </a>
            )}
          </Frame>

          <Frame className="p-3">
            <h3 className="mono text-[11px] font-semibold">The agent key can do two things</h3>
            <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">
              Not a promise about our code — a property of the access key, enforced by the NEAR
              runtime. Run it yourself:
            </p>
            <pre className="mono mt-2 overflow-x-auto rounded-btn border border-border bg-bg px-2 py-1.5 text-[9.5px] leading-relaxed text-secondary">
{`near account list-keys \\
  ${AGENT_ACCOUNT_ID ?? "agent.wincut-mansi.testnet"} \\
  network-config ${NETWORK} now`}
            </pre>
            <dl className="mono mt-2 space-y-0.5 text-[10px]">
              <Line k="permission" v="FunctionCall" />
              <Line k="receiver" v={CONTRACT_ID || "the WinCut contract"} />
              <Line k="methods" v="buy, sell" tone="profit" />
              <Line k="allowance" v="2 NEAR (gas only)" />
            </dl>
            <p className="mt-2 text-[10px] leading-relaxed text-secondary">
              No <code>withdraw</code>, no <code>claim</code>, no <code>ft_transfer</code>, and no
              attached deposit — a function-call key cannot attach NEAR at all.
            </p>
          </Frame>

          <Frame className="p-3">
            <h3 className="mono text-[11px] font-semibold">It holds what it owes</h3>
            <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">
              Two independent reads: the USDC token&apos;s own balance for the contract, against
              the contract&apos;s <code className="text-text">get_usdc_accounted</code>. The
              comparison is only worth anything because they come from different places.
            </p>
            <dl className="mono mt-2 space-y-0.5 text-[10px]">
              <Line k="holds" v={held.data === undefined ? "…" : usdFromNumber(held.data)} />
              <Line k="owes" v={solvency.data === undefined ? "…" : usdFromNumber(solvency.data)} />
              <Line
                k="surplus"
                v={gap === undefined ? "…" : usdFromNumber(gap)}
                tone={gap !== undefined && gap < 0 ? "loss" : "profit"}
              />
              <Line
                k="shortfall"
                v={config.data ? usdFromNumber(Number(config.data.shortfall_usdc) / 1e6) : "…"}
                tone={Number(config.data?.shortfall_usdc ?? 0) > 0 ? "loss" : "profit"}
              />
            </dl>
            <p className="mono mt-2 text-[10px] text-secondary">read live, this page load</p>
          </Frame>
        </div>
      </Section>

      {/* 5 -------------------------------------------------------- the agent */}
      <Section
        id="agent"
        title="The AI agent"
        lead="A separate process that reads the chain, decides, and signs with that restricted key. Its limits are in code, not in the prompt."
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <Frame className="p-3">
            <h3 className="mono text-[11px] font-semibold">Hard limits, applied after the model answers</h3>
            <dl className="mono mt-2 space-y-0.5 text-[10px]">
              <Line k="per trade" v="20% of balance" />
              <Line k="per trade, vs market" v="1.5% of pool depth" />
              <Line k="open positions" v="3" />
              <Line k="stop loss" v="-8%" tone="loss" />
              <Line k="take profit" v="+12%" tone="profit" />
              <Line k="trades per day" v="12" />
            </dl>
            <p className="mt-2 text-[10px] leading-relaxed text-secondary">
              An oversized buy is <span className="text-text">trimmed to the binding cap</span>,
              not refused, and the log names which cap bound it. With no API key — or when the
              model errors — a deterministic momentum rule decides instead, and every entry says
              which one answered.
            </p>
          </Frame>

          <Frame className="p-3">
            <div className="flex items-baseline justify-between">
              <h3 className="mono text-[11px] font-semibold">Its last three decisions</h3>
              {AGENT_ACCOUNT_ID && (
                <Link
                  href={`/trader/${AGENT_ACCOUNT_ID}`}
                  className="mono text-[10px] text-accent hover:underline"
                >
                  full log →
                </Link>
              )}
            </div>
            {!agent.data?.configured ? (
              <p className="mono mt-2 text-[10px] text-secondary">
                No agent is configured on this deployment.
              </p>
            ) : !agent.data.decisions.length ? (
              <p className="mono mt-2 text-[10px] text-secondary">
                {agent.data.detail ?? "The agent has not written a decision yet."}
              </p>
            ) : (
              <ol className="mt-2 space-y-2">
                {agent.data.decisions.slice(0, 3).map((d) => (
                  <li key={d.t} className="border-b border-border pb-2 last:border-0 last:pb-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="mono text-[10px] font-semibold"
                        style={{
                          color:
                            d.action === "BUY"
                              ? "var(--color-profit)"
                              : d.action === "SELL"
                                ? "var(--color-loss)"
                                : "var(--color-secondary)",
                        }}
                      >
                        {d.action}
                      </span>
                      {d.symbol && <span className="mono text-[10px]">{d.symbol}</span>}
                      <span className="mono ml-auto text-[9px] text-secondary">
                        {decidedByLabel(d.decidedBy)} · {ago(String(d.t * 1_000_000))}
                      </span>
                    </div>
                    <p className="mono mt-0.5 text-[10px] leading-relaxed text-secondary">
                      {d.reason}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <p className="mono mt-2 text-[10px] leading-relaxed text-secondary">
              Most passes are holds, and a hold is written down exactly like a trade. The agent is
              currently losing money; that is on the dashboard too.
            </p>
          </Frame>
        </div>
      </Section>

      {/* 6 ---------------------------------------------------- the comparison */}
      <Section
        id="compare"
        title="Binance and Bybit got halfway"
        lead="Both already pay lead traders only on profit. The exchange still charges you on every trade, win or lose. WinCut takes the rule all the way down the stack."
      >
        <Frame className="overflow-x-auto">
          <table className="w-full min-w-[32rem]">
            <thead>
              <tr className="mono border-b border-border text-[10px] text-secondary">
                <th className="px-3 py-2 text-left font-normal">on a trade that…</th>
                <th className="px-3 py-2 text-right font-normal">Binance / Bybit copy</th>
                <th className="px-3 py-2 text-right font-normal">WinCut</th>
              </tr>
            </thead>
            <tbody className="mono text-[11px]">
              <Compare what="loses money" them="trading fee, both sides" us="nothing — and a credit is banked" usTone="profit" />
              <Compare what="breaks even" them="trading fee, both sides" us="nothing" usTone="profit" />
              <Compare what="makes a profit" them={`trading fee + ~10% profit share`} us={`${feePct}% of profit, after credit`} usTone="fee" />
              <Compare what="is still open" them="funding / spread" us="nothing" usTone="profit" />
              <Compare what="pays the copied trader" them="profit share only" us="50% of the fee" />
              <Compare what="pays the referrer" them="volume rebate" us="20% of the fee" />
            </tbody>
          </table>
        </Frame>
        <p className="mono mt-2 text-[10px] leading-relaxed text-secondary">
          The honest trade-off: a user who only ever wins pays more here than a 0.1%-per-side
          venue. {feePct}% of a $500 profit is $50 against about $1 of trading fees. This is a
          better deal for people whose trades sometimes fail, which is people.
        </p>
      </Section>

      {/* 7 -------------------------------------------------------- disclosure */}
      <Section
        id="testnet"
        title={NETWORK === "mainnet" ? "Which markets these are" : "This testnet market is operated"}
        lead={
          NETWORK === "mainnet"
            ? "Every id and pool below was read from mainnet by RPC view call."
            : "Every number on this site is real on-chain data. Testnet has no liquid market, so WinCut runs one — and says so."
        }
      >
        <Frame className="p-3">
          {NETWORK !== "mainnet" && (
            <p className="text-[11px] leading-relaxed text-secondary">
              {MIRROR_TOKEN_IDS.length || 4} mirror tokens —{" "}
              <span className="text-text">
                {(tokens.data ?? []).map((t) => t.symbol).join(", ") || "MNEAR, MDRAGON, MSHITZU, MLONK"}
              </span>{" "}
              — are pegged to the <span className="text-text">live mainnet price</span> of NEAR,
              BLACKDRAGON, SHITZU and LONK. A market maker reads the real price every 60 seconds
              and swaps against the testnet pool to hold it within ±0.6%. Three strategy bots and
              the AI agent trade into those pools. Every trade is a real signed transaction
              through a real AMM, and every chart point came from a pool read this system
              performed. Mirror prices track mainnet;{" "}
              <span className="text-text">mirror liquidity does not</span> — these are 400–1,000
              tUSDC pools.
            </p>
          )}
          <dl className="mono mt-3 space-y-0.5 border-t border-border pt-3 text-[10px]">
            <Line k="network" v={`NEAR ${NETWORK}`} />
            <Line k="contract" v={CONTRACT_ID || "not deployed"} />
            <Line k="exchange" v={REF_CONTRACT} />
            <Line k="quote token" v={USDC_ID.length > 24 ? `${USDC_ID.slice(0, 12)}…` : USDC_ID} />
            <Line k="fee" v={`${feePct}% of profit · ${config.data?.trader_share_pct ?? 50}/${config.data?.referrer_share_pct ?? 20}/${config.data?.protocol_share_pct ?? 30}`} />
          </dl>
          <p className="mono mt-2 text-[10px] leading-relaxed text-secondary">
            Mainnet ids, pools and decimals are each verified by RPC view call in
            addresses.near.json, with the block they were read at. Switching over is one
            environment variable.
          </p>
        </Frame>
      </Section>

      {/* 8 ------------------------------------------------------------- faq */}
      <Section id="faq" title="Questions">
        <Frame>
          <Faq
            q="What stops me paying nothing forever?"
            a="Nothing, and that is the deal. If your trades keep losing you keep paying nothing — and you keep banking credit you can only spend by winning. WinCut earns when the credit runs out and you are ahead."
          />
          <Faq
            q="Does the credit expire?"
            a="No. It is global per account, not per token, has no expiry, and is spent before any fee on your next profitable exit."
          />
          <Faq
            q="What does copying actually do?"
            a="It credits the trader you named with 50% of any fee your profit generates. It does not place their trades for you — that would need standing permission over your balance, which this contract never asks for."
          />
          <Faq
            q="What do I pay besides the WinCut fee?"
            a="Rhea's pool fee on the swap, and NEAR gas. Both go to liquidity providers and to the network, not to us, and both are charged whichever way the trade goes."
          />
          <Faq
            q="Is this audited?"
            a="No. It is hackathon code with 60 contract tests and 89 more in the off-chain packages, running on testnet. Every limitation is written down in the repository README rather than left for you to find."
          />
        </Frame>
      </Section>

      <Frame className="field-grid p-5 text-center">
        <p className="text-[15px] font-semibold">Buying is free. Losing is free.</p>
        <p className="mono mt-1 text-[11px] text-secondary">
          You pay {feePct}% of a profit, once the losses it had to cover are paid back.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link
            href="/trade"
            className="tap rounded-btn bg-accent px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90"
          >
            Start trading
          </Link>
          <Link
            href="/dashboard"
            className="tap rounded-btn border border-border px-4 py-2 text-[13px] font-semibold hover:bg-elevated"
          >
            Watch the Cut Field
          </Link>
        </div>
      </Frame>
    </Page>
  );
}

/* ------------------------------------------------------------------- bits */

function Line({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: "profit" | "loss";
}) {
  const colour =
    tone === "profit" ? "var(--color-profit)" : tone === "loss" ? "var(--color-loss)" : undefined;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-secondary">{k}</dt>
      <dd className="truncate text-right font-semibold" style={{ color: colour }}>
        {v}
      </dd>
    </div>
  );
}

function Compare({
  what,
  them,
  us,
  usTone,
}: {
  what: string;
  them: string;
  us: string;
  usTone?: "profit" | "fee";
}) {
  const colour =
    usTone === "profit"
      ? "var(--color-profit)"
      : usTone === "fee"
        ? "var(--color-fee)"
        : undefined;
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2 text-secondary">{what}</td>
      <td className="px-3 py-2 text-right text-loss">{them}</td>
      <td className="px-3 py-2 text-right font-semibold" style={{ color: colour }}>
        {us}
      </td>
    </tr>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <details className="group border-b border-border last:border-0">
      <summary className="mono cursor-pointer list-none px-3 py-2.5 text-[11px] font-semibold marker:content-none">
        <span className="mr-2 text-secondary group-open:text-accent">+</span>
        {q}
      </summary>
      <p className="px-3 pb-3 pl-7 text-[11px] leading-relaxed text-secondary">{a}</p>
    </details>
  );
}
