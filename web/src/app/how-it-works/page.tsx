"use client";

import { Page } from "@/components/Shell";
import { Card, SectionHeading } from "@/components/ui";
import { addr, deployed, explorerAddr } from "@/lib/chain";

const REPO = "https://github.com/Mansi2007275/WinCut/blob/main/contracts/src";

/// Every step is a real contract on Arc, so each one links to the address on
/// the explorer and to the exact source file. Nothing here is illustrative.
const steps = [
  {
    title: "You",
    body: "Sign one swap. You never approve WinCut to move your money — the fee is taken inside the swap itself.",
  },
  {
    title: "Universal Router",
    body: "Arc's deployed router. It exposes msgSender(), which is how the hook knows the trade is yours and not the router's.",
    address: addr.universalRouter,
  },
  {
    title: "Uniswap v4 PoolManager",
    body: "Runs the swap and settles every balance. WinCut never holds your coins.",
    address: addr.poolManager,
  },
  {
    title: "WinCutHook.afterSwap",
    body: "Compares the proceeds against your recorded cost basis. A loss banks a credit and charges nothing. A profit is charged 10%, after any banked losses are spent.",
    address: addr.hook,
    source: `${REPO}/WinCutHook.sol`,
  },
  {
    title: "The split",
    body: "50% to the trader you copied, 20% to whoever referred you, 30% to WinCut. Credited to a ledger, never pushed to anyone.",
    source: `${REPO}/WinCutHook.sol`,
  },
  {
    title: "Claim",
    body: "Recipients pull their own balance with claim(). A failing recipient cannot block anyone else's money.",
    source: `${REPO}/WinCutHook.sol`,
  },
];

const permissions = [
  { flag: "beforeInitialize", why: "Only the launcher can open a pool on this hook, and only against the quote currency." },
  { flag: "afterSwap", why: "Where the cost basis, the loss credits and the fee are computed." },
  { flag: "afterSwapReturnDelta", why: "Lets the hook take its fee out of the swap's own output." },
];

export default function HowItWorksPage() {
  return (
    <Page>
      <header>
        <h1 className="text-2xl font-semibold">How it works</h1>
        <p className="mt-1.5 text-sm leading-snug text-secondary">
          WinCut is a Uniswap v4 hook. The fee rule is enforced by the contract inside your swap,
          not by this app — which is why the numbers here can be checked on {deployed.chainName}.
        </p>
      </header>

      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={s.title}>
            <Card className="p-4">
              <div className="flex items-start gap-3">
                <span className="num mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-elevated text-[11px] font-semibold text-secondary">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{s.title}</p>
                  <p className="mt-1 text-xs leading-snug text-secondary">{s.body}</p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    {s.address && (
                      <a
                        href={explorerAddr(s.address)}
                        target="_blank"
                        rel="noreferrer"
                        className="num text-[11px] text-accent underline-offset-2 hover:underline"
                      >
                        {s.address.slice(0, 6)}…{s.address.slice(-4)} ↗
                      </a>
                    )}
                    {s.source && (
                      <a
                        href={s.source}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-accent underline-offset-2 hover:underline"
                      >
                        source ↗
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ol>

      <section className="flex flex-col gap-2">
        <SectionHeading>Hook permissions</SectionHeading>
        <p className="text-xs leading-snug text-secondary">
          A v4 hook&apos;s powers are encoded in the low bits of its own address, so they are fixed
          at deployment and cannot be widened later. WinCut&apos;s end in{" "}
          <span className="num text-text">0x2044</span> — these three and nothing else. It cannot
          block a swap it dislikes, move your tokens, or touch anyone&apos;s liquidity.
        </p>
        <Card className="divide-y divide-border">
          {permissions.map((p) => (
            <div key={p.flag} className="p-3">
              <p className="num text-xs font-semibold text-accent">{p.flag}</p>
              <p className="mt-1 text-xs leading-snug text-secondary">{p.why}</p>
            </div>
          ))}
        </Card>
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeading>Read the contracts</SectionHeading>
        <Card className="divide-y divide-border">
          {[
            ["WinCutHook.sol", "Cost basis, loss credits, the fee and the split"],
            ["WinCutLauncher.sol", "One-transaction launch with permanently locked liquidity"],
            ["WinCutCoin.sol", "Fixed supply, no mint, no owner, no transfer tax"],
            ["periphery/WinCutQuoter.sol", "The quote this app shows before you sell"],
          ].map(([file, what]) => (
            <a
              key={file}
              href={`${REPO}/${file}`}
              target="_blank"
              rel="noreferrer"
              className="tap flex items-center justify-between gap-3 p-3 transition-colors hover:bg-elevated"
            >
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-accent">{file}</span>
                <span className="mt-0.5 block text-[11px] text-secondary">{what}</span>
              </span>
              <span className="shrink-0 text-secondary">↗</span>
            </a>
          ))}
        </Card>
      </section>
    </Page>
  );
}
