"use client";

import { useEffect, useState } from "react";
import { useAccount, useChainId, useConnect, useSwitchChain } from "wagmi";
import { arc, deployed, FAUCET_URL, isDeployed } from "@/lib/chain";
import { Button, Card } from "./ui";

/**
 * Everything that can stand between a visitor and their first trade, stated
 * plainly instead of failing silently.
 *
 * Four separate problems get four separate messages, because "connect wallet"
 * is useless advice when the real issue is that MetaMask is not installed, the
 * wallet is on the wrong chain, or the account has no gas.
 */
export function NetworkGate() {
  return (
    <div className="flex flex-col gap-3">
      <NotDeployedBanner />
      <NoWalletBanner />
      <WrongNetworkBanner />
    </div>
  );
}

/// The repo ships with zero addresses. Saying so beats rendering an empty app.
export function NotDeployedBanner() {
  if (isDeployed) return null;
  return (
    <Card tone="loss" className="p-4">
      <p className="text-sm font-semibold text-loss">Not deployed yet</p>
      <p className="mt-1.5 text-xs leading-snug text-text/80">
        WinCut has no contracts on {deployed.chainName} in this build. Run{" "}
        <code className="rounded bg-elevated px-1 py-0.5 text-[11px]">
          ./scripts/deploy-testnet.sh
        </code>{" "}
        to deploy, and the app will pick up the addresses automatically.
      </p>
    </Card>
  );
}

function useHasInjected() {
  // Checked after mount: `window.ethereum` does not exist during SSR, and
  // guessing wrong would render the install prompt to everyone for a frame.
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    setHas(typeof window !== "undefined" && !!(window as { ethereum?: unknown }).ethereum);
  }, []);
  return has;
}

export function NoWalletBanner() {
  const has = useHasInjected();
  const { isConnected } = useAccount();
  if (has !== false || isConnected) return null;
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold">No wallet found</p>
      <p className="mt-1.5 text-xs leading-snug text-secondary">
        WinCut needs a browser wallet to sign trades on Arc. MetaMask works; so does any injected
        EIP-1193 wallet.
      </p>
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer"
        className="tap mt-3 inline-flex items-center rounded-btn bg-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
      >
        Install MetaMask ↗
      </a>
    </Card>
  );
}

/**
 * Asks the wallet to switch to Arc, and adds the chain when it has never heard
 * of it.
 *
 * wagmi's switchChain rejects with 4902 for an unknown chain, so without the
 * wallet_addEthereumChain fallback a first-time visitor is stuck being told to
 * switch to a network they cannot select.
 */
export function SwitchNetworkButton() {
  const { switchChain, isPending } = useSwitchChain();
  const [error, setError] = useState<string | undefined>();

  async function addThenSwitch() {
    setError(undefined);
    const eth = (window as { ethereum?: { request: (a: unknown) => Promise<unknown> } }).ethereum;
    if (!eth) return setError("No injected wallet to switch.");
    try {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: `0x${arc.id.toString(16)}`,
            chainName: arc.name,
            nativeCurrency: arc.nativeCurrency,
            rpcUrls: [deployed.rpcUrl],
            blockExplorerUrls: [deployed.explorer],
          },
        ],
      });
    } catch (e) {
      setError((e as { message?: string }).message ?? "Could not add Arc.");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button
          className="flex-1"
          onClick={() => switchChain({ chainId: arc.id }, { onError: () => void addThenSwitch() })}
          disabled={isPending}
        >
          {isPending ? "Switching…" : `Switch to ${deployed.chainName}`}
        </Button>
        <Button tone="elevated" onClick={() => void addThenSwitch()}>
          Add network
        </Button>
      </div>
      {error && <p className="text-[11px] leading-snug text-loss">{error}</p>}
    </div>
  );
}

export function WrongNetworkBanner() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  if (!isConnected || chainId === arc.id) return null;

  return (
    <Card tone="accent" className="p-4">
      <p className="text-sm font-semibold text-accent">Wrong network</p>
      <p className="mt-1.5 mb-3 text-xs leading-snug text-text/80">
        Your wallet is on chain {chainId}. WinCut lives on {deployed.chainName} (chain {arc.id}).
      </p>
      <SwitchNetworkButton />
    </Card>
  );
}

/// Shown where it is useful (Launch, Trade) rather than globally: a visitor
/// with funds does not need to be told about a faucet.
export function FaucetLink({ className = "" }: { className?: string }) {
  return (
    <a
      href={FAUCET_URL}
      target="_blank"
      rel="noreferrer"
      className={`text-sm font-medium text-accent underline-offset-2 hover:underline ${className}`}
    >
      Get test USDC ↗
    </a>
  );
}

export const WALLET_PENDING_MESSAGE = "Open MetaMask to approve the connection";

/**
 * True when the wallet is telling us a request is already open (EIP-1193
 * -32002), rather than that something went wrong.
 *
 * The code can sit on the error itself or on any link of its `cause` chain,
 * depending on whether wagmi, viem or the provider wrapped it, so the chain is
 * walked. The message check is the backstop for providers that only set text.
 */
export function isAlreadyPendingError(error: unknown): boolean {
  let node: unknown = error;
  for (let depth = 0; depth < 6 && node; depth++) {
    const e = node as { code?: unknown; cause?: unknown };
    if (e.code === -32002) return true;
    node = e.cause;
  }
  const message = (error as { message?: string } | null)?.message ?? "";
  return /already pending|already processing/i.test(message);
}

/**
 * Connect button that actually shows why it failed.
 *
 * `compact` is for the top bar, which is a narrow slot. Rendering the full
 * NoWalletBanner card in there wrapped every line to a single word at 390px
 * and repeated a card the page body was already showing. The bar gets a link;
 * the page keeps the card.
 */
export function ConnectCta({
  label = "Connect wallet",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  const { connect, connectors, isPending, error, reset } = useConnect();
  const { status } = useAccount();
  const has = useHasInjected();

  if (has === false) {
    if (compact) {
      return (
        <a
          href="https://metamask.io/download/"
          target="_blank"
          rel="noreferrer"
          className="tap flex items-center justify-center rounded-btn border border-border bg-surface px-3 text-xs font-semibold whitespace-nowrap transition-colors hover:bg-elevated"
        >
          Get wallet ↗
        </a>
      );
    }
    return <NoWalletBanner />;
  }

  // -32002 means MetaMask already has an unanswered connect prompt open,
  // usually behind the browser window. It is not a failure and the raw text
  // ("Request of type 'wallet_requestPermissions' already pending for origin
  // ...") reads like one, so it gets the same wording as a normal wait.
  const alreadyPending = isAlreadyPendingError(error);
  // useConnect's isPending is per hook instance, so the copy in the top bar
  // stayed live while the one in the page body was mid-request -- two Connect
  // buttons, one of them clickable, both driving the same wallet. The account
  // status is config-wide, so both instances see the request.
  const waiting = isPending || status === "connecting" || alreadyPending;

  function retry() {
    // The old error has to be cleared first, or wagmi keeps reporting the
    // stale -32002 and the button never comes back.
    reset();
    connect({ connector: connectors[0] });
  }

  if (compact) {
    return (
      <div className="flex flex-col gap-1">
        <Button
          className="w-full px-3 text-xs"
          disabled={waiting || connectors.length === 0}
          onClick={() => connect({ connector: connectors[0] })}
        >
          {waiting ? "Waiting…" : label}
        </Button>
        {waiting && (
          <p className="text-[10px] leading-tight text-secondary">{WALLET_PENDING_MESSAGE}</p>
        )}
        {alreadyPending && (
          <button
            onClick={retry}
            className="rounded-btn border border-border bg-elevated px-2 py-1 text-[10px] font-semibold"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        className="w-full py-3.5 text-base"
        disabled={waiting || connectors.length === 0}
        onClick={() => connect({ connector: connectors[0] })}
      >
        {waiting ? "Waiting for MetaMask…" : label}
      </Button>

      {waiting && (
        <Card tone="accent" className="px-3 py-2">
          <p className="text-xs leading-snug text-accent">{WALLET_PENDING_MESSAGE}</p>
        </Card>
      )}

      {alreadyPending && (
        <Button tone="elevated" className="w-full" onClick={retry}>
          Retry
        </Button>
      )}

      {error && !alreadyPending && (
        <Card tone="loss" className="px-3 py-2">
          <p className="text-[11px] leading-snug break-words text-loss">{error.message}</p>
        </Card>
      )}
    </div>
  );
}
