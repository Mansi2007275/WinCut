"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useAccount, useChainId } from "wagmi";
import { arc, FAUCET_URL } from "@/lib/chain";
import { Button } from "./ui";
import { ConnectCta, SwitchNetworkButton } from "./NetworkGate";

const SEEN_KEY = "wincut.onboarded";

/**
 * Three rules and the three things that can block a first trade.
 *
 * Shown once. The whole point of WinCut is a fee rule that is the opposite of
 * what people expect, so saying it before the first trade is not marketing, it
 * is the thing they need to know to read the sell screen. After that it is
 * noise, so a localStorage flag retires it.
 */
export function Onboarding() {
  const [open, setOpen] = useState(false);
  const { isConnected } = useAccount();
  const chainId = useChainId();

  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) setOpen(true);
    } catch {
      // Private browsing blocks storage. Showing nothing beats showing this
      // on every single navigation.
    }
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Nothing to persist to; the dialog still closes for this session.
    }
    setOpen(false);
  }

  const rules = [
    {
      head: "You only pay when you win",
      body: "A profitable exit pays 10% of the profit. Nothing else in the app charges you.",
    },
    {
      head: "A loss costs you nothing",
      body: "Exiting at a loss pays $0 and banks a loss credit that cancels your next profit.",
    },
    {
      head: "Everyone is paid the same way",
      body: "The trader you copied and whoever invited you also earn only out of your profit.",
    },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          role="dialog"
          aria-modal="true"
          aria-label="Welcome to WinCut"
        >
          <motion.div
            className="w-full max-w-md rounded-t-card border border-border bg-surface p-5 sm:rounded-card"
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
          >
            <div className="mb-4 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent text-sm font-bold text-white">
                W
              </span>
              <div>
                <h2 className="text-lg leading-none font-semibold">WinCut</h2>
                <p className="mt-1 text-xs text-secondary">Paid only when you win</p>
              </div>
            </div>

            <ol className="mb-5 flex flex-col gap-3">
              {rules.map((r, i) => (
                <li key={r.head} className="flex gap-3">
                  <span className="num mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-elevated text-[11px] font-semibold text-secondary">
                    {i + 1}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{r.head}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-secondary">
                      {r.body}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            <div className="flex flex-col gap-2">
              {!isConnected && <ConnectCta label="Connect wallet" />}
              {isConnected && chainId !== arc.id && <SwitchNetworkButton />}
              <a
                href={FAUCET_URL}
                target="_blank"
                rel="noreferrer"
                className="tap flex items-center justify-center rounded-btn border border-border bg-elevated text-sm font-semibold transition-colors hover:bg-elevated/70"
              >
                Get test USDC ↗
              </a>
              <Button tone="ghost" onClick={dismiss} className="w-full">
                {isConnected ? "Start trading" : "Look around first"}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
