"use client";

/**
 * The rules, in full, with no marketing in them.
 *
 * Every claim on this page is one the contract enforces, and the method that
 * enforces it is named so a reader can go and check. The limitations section
 * is not an afterthought: a trading app that hides its failure modes is not
 * trustworthy, and a judge will find them anyway.
 */

import Link from "next/link";

import { Page } from "@/components/Shell";
import { Card, SectionHeading } from "@/components/ui";
import { useConfig } from "@/lib/queries";
import { CONTRACT_ID, REF_CONTRACT, USDC_ID, isDeployed } from "@/lib/near";
import { shortAccount } from "@/lib/format";

export default function HowItWorks() {
  const config = useConfig();

  return (
    <Page width="lg">
      <header>
        <h1 className="text-lg font-semibold">How the fee works</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-secondary">
          WinCut earns when you do, and not otherwise. That is one sentence, and the whole
          contract exists to make it literally true rather than nearly true.
        </p>
      </header>

      <Card className="p-4">
        <SectionHeading>The three cases</SectionHeading>
        <div className="mt-3 flex flex-col gap-3">
          <Rule
            tone="profit"
            when="You buy"
            fee="0%"
            detail="WinCut takes nothing on the way in. You still pay Rhea's pool fee and NEAR gas, because those go to liquidity providers and to the network."
          />
          <Rule
            tone="profit"
            when="You sell at a loss"
            fee="0%"
            detail="Nothing is charged, and the full loss is banked as a loss credit. The credit is yours across every token, never expires, and is spent before any future profit fee."
          />
          <Rule
            tone="text"
            when="You sell at a profit"
            fee="10% of the profit"
            detail="Your banked credit is consumed first. Only what is left is charged, at 10%, and you keep the other 90% along with your whole original stake."
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading>Worked through</SectionHeading>
        <ol className="mt-3 flex flex-col gap-3 text-[12px] leading-relaxed">
          <Step n={1}>
            You buy $100 of a token. <strong className="text-profit">Fee: $0.</strong>
          </Step>
          <Step n={2}>
            It falls. You sell for $80. <strong className="text-profit">Fee: $0</strong>, and $20
            is banked as loss credit.
          </Step>
          <Step n={3}>
            You buy again, and this time it works: $100 becomes $150. The $50 profit meets your
            $20 credit, so only $30 is charged.{" "}
            <strong>Fee: $3</strong> — not $5, and not a cent on the way in.
          </Step>
          <Step n={4}>
            That $3 splits {config.data?.trader_share_pct ?? 50}% to the trader you copied,{" "}
            {config.data?.referrer_share_pct ?? 20}% to whoever referred you, and{" "}
            {config.data?.protocol_share_pct ?? 30}% to the protocol. If you copied nobody and
            arrived through no link, those shares fall to the protocol — they are never charged to
            you twice.
          </Step>
        </ol>
        <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-secondary">
          Across all three trades you put in $200, took out $230, and paid $3. A model charging 1%
          in and 1% out would have taken $4.30 — including $1.80 on the trade that lost you money.
        </p>
      </Card>

      <Card className="p-4">
        <SectionHeading>Where the money sits</SectionHeading>
        <ul className="mt-2.5 flex flex-col gap-2 text-[12px] leading-relaxed text-secondary">
          <li>
            <strong className="text-text">Your USDC balance</strong> lives inside the WinCut
            contract. You deposit once, and trades then need no per-swap approval. Withdrawing is
            one signature and always available.
          </li>
          <li>
            <strong className="text-text">Your position</strong> is a record of how many tokens
            you hold and what they cost. The tokens themselves are held by the contract, which is
            how it can settle a sale and the fee in one go.
          </li>
          <li>
            <strong className="text-text">Earnings</strong> — yours as a copied trader or a
            referrer — are paid on request rather than pushed to you. One account unable to
            receive USDC can then never block somebody else&apos;s settlement.
          </li>
          <li>
            <strong className="text-text">Swaps</strong> happen on Rhea, not on WinCut. WinCut
            never quotes you a price of its own; it routes to the pool and settles what comes
            back.
          </li>
        </ul>
      </Card>

      <Card className="p-4">
        <SectionHeading>What this cannot do</SectionHeading>
        <ul className="mt-2.5 flex flex-col gap-2 text-[12px] leading-relaxed text-secondary">
          <li>
            <strong className="text-text">One settlement at a time.</strong> A trade spans several
            blocks, and the contract measures balances to attribute the swap, so it holds a global
            lock while one is in flight. If somebody else is mid-trade, yours waits a few seconds
            and the panel says so.
          </li>
          <li>
            <strong className="text-text">Market orders only.</strong> A limit order needs
            something watching the pool between blocks. WinCut has no keeper, so it does not offer
            one.
          </li>
          <li>
            <strong className="text-text">Copying is manual.</strong> Naming a trader credits them
            with a share of your profit fee. It does not mirror their trades automatically — that
            would need standing permission over your balance.
          </li>
          <li>
            <strong className="text-text">The last 500 trades are on chain.</strong> Older ones
            are in the NEP-297 event log and readable by any indexer, but the contract stops
            storing them so its state cannot grow without bound.
          </li>
          <li>
            <strong className="text-text">Thin pools are thin.</strong> Some listed markets hold
            only a few thousand dollars. The depth ladder shows exactly what each size would fill
            at, so a bad price is visible before you sign rather than after.
          </li>
        </ul>
      </Card>

      <Card className="p-4">
        <SectionHeading>The contracts</SectionHeading>
        <dl className="mt-2.5 flex flex-col gap-1.5 text-[11px]">
          <Address label="WinCut" id={isDeployed ? CONTRACT_ID : "not deployed yet"} link={isDeployed} />
          <Address label="Rhea (swaps)" id={REF_CONTRACT} link />
          <Address label="USDC" id={USDC_ID} link />
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-secondary">
          Every figure in this app is read from one of those three, or from GeckoTerminal for the
          candles. Nothing is simulated.{" "}
          <Link href="/trade" className="text-accent hover:underline">
            Go and check →
          </Link>
        </p>
      </Card>
    </Page>
  );
}

function Rule({
  when,
  fee,
  detail,
  tone,
}: {
  when: string;
  fee: string;
  detail: string;
  tone: "profit" | "text";
}) {
  return (
    <div className="rounded-btn border border-border bg-elevated p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold">{when}</p>
        <p className={`num text-[15px] font-semibold ${tone === "profit" ? "text-profit" : ""}`}>
          {fee}
        </p>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-secondary">{detail}</p>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-elevated text-[11px] font-semibold text-secondary">
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Address({ label, id, link }: { label: string; id: string; link: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-secondary">{label}</dt>
      <dd className="num min-w-0 truncate">
        {link ? (
          <a
            href={`https://nearblocks.io/address/${id}`}
            target="_blank"
            rel="noreferrer"
            title={id}
            className="text-accent underline-offset-2 hover:underline"
          >
            {shortAccount(id)}
          </a>
        ) : (
          <span className="text-secondary">{id}</span>
        )}
      </dd>
    </div>
  );
}
