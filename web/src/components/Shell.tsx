"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useAccount, useBalance, useDisconnect } from "wagmi";
import { short, usd } from "@/lib/format";
import { QUOTE, deployed } from "@/lib/chain";
import { ConnectCta, NotDeployedBanner, WrongNetworkBanner } from "./NetworkGate";

const tabs = [
  { href: "/", label: "Discover" },
  { href: "/launch", label: "Launch" },
  { href: "/board", label: "Board" },
  { href: "/me", label: "Me" },
] as const;

function isActive(path: string, href: string) {
  if (href === "/") return path === "/" || path.startsWith("/coin");
  if (href === "/board") return path === "/board" || path.startsWith("/trader");
  return path === href;
}

export function BottomNav() {
  const path = usePathname();
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t-3 border-ink bg-cream"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-md">
        {tabs.map((t, i) => {
          const active = isActive(path, t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex-1 py-4 text-center font-display text-[11px] uppercase tracking-tight ${
                active ? "text-brand" : "text-ink"
              } ${i > 0 ? "border-l-3 border-ink" : ""}`}
            >
              {/* The sliding highlight is a layout animation on a shared id, so
                  the black block travels between tabs instead of blinking. */}
              {active && (
                <motion.span
                  layoutId="tab-highlight"
                  className="absolute inset-0 bg-ink"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <span className="relative">{t.label}</span>
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
    <header className="sticky top-0 z-40 border-b-3 border-ink bg-brand">
      <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 py-3">
        <Link href="/" className="min-w-0">
          <p className="font-display text-xl uppercase leading-none">WinCut</p>
          <p className="text-[10px] font-bold leading-tight text-ink/70">Paid only when you win</p>
        </Link>

        {isConnected ? (
          <button
            onClick={() => disconnect()}
            title="Disconnect"
            className="nb-sm nb-press shrink-0 bg-white px-2 py-1 text-left"
          >
            <span className="block font-mono text-[10px] leading-tight">{short(address)}</span>
            <span className="money block text-xs leading-tight">
              {usd(bal?.value)} {QUOTE.symbol}
            </span>
          </button>
        ) : (
          <div className="shrink-0">
            <CompactConnect />
          </div>
        )}
      </div>
    </header>
  );
}

/// The top bar needs a small connect button, not the full card with errors.
function CompactConnect() {
  return (
    <div className="w-[7.5rem]">
      <ConnectCta label="Connect" />
    </div>
  );
}

/**
 * Page frame.
 *
 * The max-w-md column and 16px gutters keep the layout honest at 390px, which
 * is the width this is designed for. Every screen gets the deployment and
 * network banners, because every screen is useless without them resolved.
 */
export function Page({
  children,
  wide,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  const path = usePathname();
  return (
    <>
      <TopBar />
      <motion.main
        key={path}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className={`mx-auto flex ${wide ? "max-w-lg" : "max-w-md"} flex-col gap-4 px-4 py-4`}
      >
        <NotDeployedBanner />
        <WrongNetworkBanner />
        {children}
      </motion.main>
      <BottomNav />
      <p className="mx-auto max-w-md px-4 pb-4 text-center font-mono text-[10px] leading-snug text-muted">
        {deployed.chainName} · chain {deployed.chainId} ·{" "}
        <a href={deployed.explorer} target="_blank" rel="noreferrer" className="underline">
          arcscan
        </a>
      </p>
    </>
  );
}
