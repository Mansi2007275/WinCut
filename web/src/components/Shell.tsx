"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useAccount, useBalance, useDisconnect } from "wagmi";
import { short, usd } from "@/lib/format";
import { deployed } from "@/lib/chain";
import { ConnectCta, NotDeployedBanner, WrongNetworkBanner } from "./NetworkGate";
import { Onboarding } from "./Onboarding";

/* -------------------------------------------------------------------- icons

   Inlined rather than pulled from an icon package: there are four of them,
   they all share one stroke weight, and a dependency for that is not worth
   the bytes on a mobile-first screen.                                       */

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

const Plus = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const Bars = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
    <path
      d="M6 14v5M12 9v10M18 5v14"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
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
  { href: "/launch", label: "Launch", Icon: Plus },
  { href: "/board", label: "Board", Icon: Bars },
  { href: "/me", label: "Me", Icon: Person },
] as const;

/// A coin page belongs to Discover and a trader page to Board, so the tab the
/// user arrived through stays lit while they are deeper in it.
function isActive(path: string, href: string) {
  if (href === "/") return path === "/" || path.startsWith("/coin");
  if (href === "/board") return path === "/board" || path.startsWith("/trader");
  return path === href;
}

export function BottomNav() {
  const path = usePathname();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-bg/95 backdrop-blur"
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

export function TopBar() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: bal } = useBalance({ address });

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-md items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-accent text-sm font-bold text-white">
            W
          </span>
          <span className="text-[17px] leading-none font-semibold">WinCut</span>
        </Link>

        {isConnected ? (
          <button
            onClick={() => disconnect()}
            title={`${address} — click to disconnect`}
            className="tap flex shrink-0 items-center gap-2 rounded-pill border border-border bg-surface px-3 py-1.5 transition-colors hover:bg-elevated"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-profit" />
            <span className="num text-xs font-medium">{short(address)}</span>
            <span className="num text-xs text-secondary">{usd(bal?.value)}</span>
          </button>
        ) : (
          <div className="w-[8.5rem] shrink-0">
            <ConnectCta label="Connect" compact />
          </div>
        )}
      </div>
    </header>
  );
}

/**
 * Page frame.
 *
 * The max-w-md column and 16px gutters keep the layout honest at 390px, which
 * is the width this is designed for. Every screen gets the deployment and
 * network banners, because every screen is useless without them resolved.
 */
export function Page({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  const path = usePathname();
  return (
    <>
      <Onboarding />
      <TopBar />
      <motion.main
        key={path}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        className={`mx-auto flex ${wide ? "max-w-lg" : "max-w-md"} flex-col gap-4 px-4 py-4`}
      >
        <NotDeployedBanner />
        <WrongNetworkBanner />
        {children}
      </motion.main>
      <BottomNav />
      <footer className="mx-auto max-w-md px-4 pb-6 text-center text-[11px] leading-relaxed text-secondary">
        <p>
          Built on Uniswap v4 · {deployed.chainName} ·{" "}
          <Link href="/how-it-works" className="text-accent underline-offset-2 hover:underline">
            How it works
          </Link>
        </p>
        <p className="mt-0.5">
          chain {deployed.chainId} ·{" "}
          <a
            href={deployed.explorer}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-text"
          >
            explorer
          </a>
        </p>
      </footer>
    </>
  );
}
