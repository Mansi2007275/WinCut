"use client";

/**
 * Page frame.
 *
 * Two layouts, one component. Phones get a single column and a bottom tab bar;
 * from `lg` up the nav moves into the top bar and `Page` can go full width,
 * which is what the trade screen needs for a chart, a depth ladder and an
 * order panel side by side.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useWallet } from "@/lib/wallet";
import { useBlockHeight, useInternalBalance, useLossCredit } from "@/lib/queries";
import { shortAccount, usd } from "@/lib/format";
import { NETWORK, isDeployed } from "@/lib/near";
import { ConnectCta, NotDeployedBanner, WalletErrorBanner } from "./Gate";

/* -------------------------------------------------------------------- icons

   Inlined rather than pulled from an icon package: there are five of them,
   they share one stroke weight, and a dependency for that is not worth the
   bytes.                                                                    */

type IconProps = { className?: string };

const Compass = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9 4.9-2.1Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

const Candles = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <path d="M8 4v4m0 8v4M16 3v5m0 8v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <rect x="5.5" y="8" width="5" height="8" rx="1" stroke="currentColor" strokeWidth="1.6" />
    <rect x="13.5" y="8" width="5" height="8" rx="1" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

const Bars = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <path d="M6 14v5M12 9v10M18 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const Person = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M5 19.5c1.2-3.2 3.8-4.8 7-4.8s5.8 1.6 7 4.8"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

const tabs = [
  { href: "/", label: "Discover", Icon: Compass },
  { href: "/trade", label: "Trade", Icon: Candles },
  { href: "/board", label: "Traders", Icon: Bars },
  { href: "/me", label: "Me", Icon: Person },
] as const;

/** A trade page belongs to Trade and a trader page to Traders. */
function isActive(path: string, href: string) {
  if (href === "/") return path === "/";
  if (href === "/trade") return path.startsWith("/trade");
  if (href === "/board") return path === "/board" || path.startsWith("/trader");
  return path === href;
}

function Logo() {
  return (
    <Link href="/" className="flex min-w-0 items-center gap-2">
      {/* The mark: a candle wick cut short - what WinCut does to the fee. */}
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-accent"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
          <path d="M12 3v3.5m0 11V21" stroke="white" strokeWidth="2" strokeLinecap="round" />
          <rect x="8" y="6.5" width="8" height="11" rx="1.5" fill="white" />
          <path d="M5 12h14" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="text-[17px] leading-none font-semibold">WinCut</span>
    </Link>
  );
}

/**
 * The live block height.
 *
 * It is the cheapest possible proof that the screen is reading a real chain
 * right now: if the number stops moving, something is wrong, and the user can
 * see that for themselves.
 */
export function BlockBadge() {
  const { data, isError } = useBlockHeight();
  return (
    <span
      title={isError ? "cannot reach any NEAR RPC endpoint" : `NEAR ${NETWORK}`}
      className="hidden items-center gap-1.5 rounded-pill border border-border bg-surface px-2.5 py-1 sm:inline-flex"
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-pill ${
          isError ? "bg-loss" : "animate-pulse bg-profit"
        }`}
      />
      <span className="num text-[11px] text-secondary">
        {data ? `#${data.toLocaleString("en-US")}` : isError ? "no RPC" : "…"}
      </span>
    </span>
  );
}

function AccountButton() {
  const { accountId, signOut, walletName } = useWallet();
  const balance = useInternalBalance(accountId);

  if (!accountId) {
    return (
      <div className="w-[9.5rem] shrink-0">
        <ConnectCta label="Connect" compact />
      </div>
    );
  }
  return (
    <button
      onClick={() => void signOut()}
      title={`${accountId}${walletName ? ` via ${walletName}` : ""} — click to disconnect`}
      className="tap flex shrink-0 items-center gap-2 rounded-pill border border-border bg-surface px-3 py-1.5 transition-colors hover:bg-elevated"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-profit" />
      <span className="num max-w-[9rem] truncate text-xs font-medium">
        {shortAccount(accountId)}
      </span>
      {isDeployed && (
        <span className="num hidden text-xs text-secondary sm:inline">
          {balance.data === undefined ? "…" : usd(balance.data)}
        </span>
      )}
    </button>
  );
}

/** The user's banked loss credit, shown wherever they can see a fee. */
export function CreditBadge() {
  const { accountId } = useWallet();
  const credit = useLossCredit(accountId);
  if (!accountId || !credit.data || credit.data === 0n) return null;
  return (
    <Link
      href="/me"
      title="Banked losses. Spent before any profit fee, across every token, with no expiry."
      className="inline-flex items-center gap-1.5 rounded-pill border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent"
    >
      <span>credit</span>
      <span className="num">{usd(credit.data)}</span>
    </Link>
  );
}

export function TopBar() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-3">
        <Logo />

        <nav className="ml-4 hidden items-center gap-1 lg:flex">
          {tabs.map(({ href, label }) => {
            const active = isActive(path, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`rounded-btn px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  active ? "bg-elevated text-text" : "text-secondary hover:text-text"
                }`}
              >
                {label}
              </Link>
            );
          })}
          <Link
            href="/how-it-works"
            className="rounded-btn px-3 py-1.5 text-[13px] font-medium text-secondary transition-colors hover:text-text"
          >
            How it works
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <CreditBadge />
          <BlockBadge />
          <AccountButton />
        </div>
      </div>
    </header>
  );
}

export function BottomNav() {
  const path = usePathname();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-bg/95 backdrop-blur lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-md">
        {tabs.map(({ href, label, Icon }) => {
          const active = isActive(path, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`tap flex flex-1 flex-col items-center justify-center gap-1 py-2.5 transition-colors duration-150 ${
                active ? "text-text" : "text-secondary"
              }`}
            >
              <Icon className="h-[22px] w-[22px]" />
              <span className={`text-[11px] ${active ? "font-semibold" : "font-medium"}`}>
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * @param width `md` is the mobile-first reading column, `lg` for list screens,
 *   `full` for the trade terminal which wants the whole viewport.
 */
export function Page({
  children,
  width = "md",
  banners = true,
}: {
  children?: React.ReactNode;
  width?: "md" | "lg" | "full";
  banners?: boolean;
}) {
  const path = usePathname();
  const max = { md: "max-w-md", lg: "max-w-3xl", full: "max-w-[1600px]" }[width];
  return (
    <>
      <TopBar />
      <main
        key={path}
        className={`page-enter mx-auto flex ${max} flex-col gap-4 px-4 py-4`}
      >
        {banners && (
          <>
            <NotDeployedBanner />
            <WalletErrorBanner />
          </>
        )}
        {children}
      </main>
      <BottomNav />
      <Footer />
    </>
  );
}

function Footer() {
  return (
    <footer className="mx-auto max-w-[1600px] px-4 pb-8 text-center text-[11px] leading-relaxed text-secondary">
      <p>
        Swaps on{" "}
        <a
          href="https://nearblocks.io/address/v2.ref-finance.near"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-text"
        >
          Rhea Finance
        </a>{" "}
        · settled on NEAR {NETWORK} ·{" "}
        <Link href="/how-it-works" className="text-accent underline-offset-2 hover:underline">
          How the fee works
        </Link>
      </p>
      <p className="mt-0.5">
        Candles from GeckoTerminal. Prices, depth, balances and fees read straight off chain.
      </p>
    </footer>
  );
}
