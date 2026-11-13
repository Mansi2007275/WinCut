"use client";

/**
 * The things that have to be true before a screen means anything: a contract
 * to read, a wallet to sign with, and USDC inside WinCut to trade.
 *
 * Each one says plainly what is missing and what to do about it. None of them
 * renders a number it does not have.
 */

import { Card } from "./ui";
import { useWallet } from "@/lib/wallet";
import { isDeployed, CONTRACT_ID, NETWORK } from "@/lib/near";
import { shortAccount } from "@/lib/format";

export function ConnectCta({ label = "Connect wallet", compact }: { label?: string; compact?: boolean }) {
  const { signIn, ready } = useWallet();
  return (
    <button
      onClick={signIn}
      disabled={!ready}
      className={`tap w-full rounded-btn bg-accent font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50 ${
        compact ? "px-3 py-1.5 text-xs" : "px-4 py-3 text-sm"
      }`}
    >
      {ready ? label : "Loading wallets…"}
    </button>
  );
}

/**
 * Shown when NEXT_PUBLIC_CONTRACT_ID is empty.
 *
 * The repo ships without a contract id on purpose: it should not claim a
 * deployment it does not have. Every screen checks this rather than firing
 * reads at an empty account and rendering a confusing failure.
 */
export function NotDeployedBanner() {
  if (isDeployed) return null;
  return (
    <Card tone="loss" className="p-3">
      <p className="text-xs font-semibold text-loss">WinCut is not deployed yet</p>
      <p className="mt-1 text-[11px] leading-relaxed text-secondary">
        Set <code className="text-text">NEXT_PUBLIC_CONTRACT_ID</code> in{" "}
        <code className="text-text">web/.env.local</code> to the account you deployed the contract
        to. Run{" "}
        <code className="text-text">node scripts/print-deploy-commands.mjs wincut.you.near</code>{" "}
        from the repo root for every command.
      </p>
      <p className="mt-1.5 text-[11px] text-secondary">
        Prices and pool depth below still come from Rhea on {NETWORK}, because those do not need
        WinCut. Balances, positions and fees do.
      </p>
    </Card>
  );
}

/** Surfaces a wallet-selector failure instead of leaving a dead button. */
export function WalletErrorBanner() {
  const { error } = useWallet();
  if (!error) return null;
  return (
    <Card tone="loss" className="p-3">
      <p className="text-xs font-semibold text-loss">Wallet could not start</p>
      <p className="mt-1 text-[11px] break-words text-secondary">{error}</p>
    </Card>
  );
}

/**
 * Stands in for a contract read that cannot happen yet.
 *
 * A react-query hook gated on `enabled: isDeployed` never leaves the pending
 * state, so without this the screen shows skeletons that load for ever. An
 * explanation is better than a spinner that is lying.
 */
export function NeedsContract({ what }: { what: string }) {
  return (
    <div className="rounded-btn border border-border bg-elevated p-3">
      <p className="text-xs font-semibold">No contract to read {what} from</p>
      <p className="mt-1 text-[11px] leading-relaxed text-secondary">
        Deploy WinCut and set <code className="text-text">NEXT_PUBLIC_CONTRACT_ID</code>. Prices,
        depth and charts work without it, because those come from Rhea and GeckoTerminal.
      </p>
    </div>
  );
}

/** Where the money is, said once, with the contract it is held by. */
export function ContractNote() {
  if (!isDeployed) return null;
  return (
    <p className="text-[10px] leading-relaxed text-secondary">
      Settled by{" "}
      <a
        href={`https://nearblocks.io/address/${CONTRACT_ID}`}
        target="_blank"
        rel="noreferrer"
        className="text-accent underline-offset-2 hover:underline"
      >
        {shortAccount(CONTRACT_ID)}
      </a>{" "}
      on NEAR {NETWORK}.
    </p>
  );
}
