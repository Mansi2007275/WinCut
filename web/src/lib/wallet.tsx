"use client";

/**
 * Wallet connection and signing.
 *
 * `createAccessKeyFor` asks the wallet for a function-call access key scoped to
 * the WinCut contract, so `buy` and `sell` are signed in the page without a
 * round trip to the wallet every time. `withdraw` and `claim` deliberately
 * fall outside that: they attach one yoctoNEAR, which a function-call key
 * cannot do, so moving money out of the contract always costs a real wallet
 * confirmation. That is the NEP-141 convention and it is the right trade here.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  internalActionToNaj,
  setupWalletSelector,
  type WalletSelector,
} from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import "@near-wallet-selector/modal-ui/styles.css";

import { CONTRACT_ID, NETWORK, isDeployed, rpcEndpoints } from "./near";

/** Methods the in-page function-call key is allowed to sign. */
const SESSION_METHODS = ["buy", "sell", "release_stale_lock"];

export type SignArgs = {
  /** Defaults to the WinCut contract. */
  contractId?: string;
  method: string;
  args: Record<string, unknown>;
  /** Tgas. */
  gas?: number;
  /** yoctoNEAR as a string. */
  deposit?: string;
};

export type WalletState = {
  ready: boolean;
  accountId: string | null;
  walletName: string | null;
  error: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** Signs one function call and resolves to its transaction hash. */
  sign: (args: SignArgs) => Promise<string>;
  /** Signs several calls in one transaction, in order. */
  signBatch: (receiverId: string, calls: SignArgs[]) => Promise<string>;
};

const WalletContext = createContext<WalletState | null>(null);

const TGAS = 1_000_000_000_000n;

/**
 * The wallet selector's own RPC, pinned rather than defaulted.
 *
 * `network: "testnet"` makes the selector use its built-in config, whose
 * nodeUrl is FastNEAR - the same free endpoint the bots and the agent are
 * already spending. `fallbackRpcUrls` below does not help with that: a
 * fallback is only consulted after the primary has failed, so every wallet
 * call still opens with a request to the endpoint most likely to refuse it,
 * and a 429 during a signing flow is a failed trade rather than a slow one.
 *
 * Naming the whole network object puts the browser's first choice on the same
 * endpoint the rest of the app reads from, with the selector's defaults kept
 * as the fallbacks.
 */
const SELECTOR_NETWORK =
  NETWORK === "mainnet"
    ? {
        networkId: "mainnet",
        nodeUrl: rpcEndpoints[0]!,
        helperUrl: "https://helper.mainnet.near.org",
        explorerUrl: "https://nearblocks.io",
        indexerUrl: "https://api.kitwallet.app",
      }
    : {
        networkId: "testnet",
        nodeUrl: rpcEndpoints[0]!,
        helperUrl: "https://helper.testnet.near.org",
        explorerUrl: "https://testnet.nearblocks.io",
        indexerUrl: "https://testnet-api.kitwallet.app",
      };

export function WalletProvider({ children }: { children: ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const modalRef = useRef<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let subscription: { unsubscribe: () => void } | null = null;

    (async () => {
      try {
        const instance = await setupWalletSelector({
          network: SELECTOR_NETWORK,
          modules: [setupHotWallet(), setupMeteorWallet(), setupMyNearWallet()],
          fallbackRpcUrls: rpcEndpoints,
          ...(isDeployed
            ? { createAccessKeyFor: { contractId: CONTRACT_ID, methodNames: SESSION_METHODS } }
            : {}),
        });
        if (cancelled) return;

        modalRef.current = setupModal(instance, {
          contractId: CONTRACT_ID,
          methodNames: SESSION_METHODS,
          theme: "dark",
          description: "Connect to trade on WinCut. You only pay a fee when you profit.",
        });

        subscription = instance.store.observable.subscribe((state) => {
          const account = state.accounts.find((a) => a.active) ?? state.accounts[0];
          setAccountId(account?.accountId ?? null);
          const active = state.modules.find((m) => m.id === state.selectedWalletId);
          setWalletName(active?.metadata.name ?? null);
        });

        setSelector(instance);
        setReady(true);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, []);

  const signIn = useCallback(() => {
    if (!modalRef.current) {
      setError("the wallet selector has not finished loading");
      return;
    }
    modalRef.current.show();
  }, []);

  const signOut = useCallback(async () => {
    if (!selector) return;
    try {
      const wallet = await selector.wallet();
      await wallet.signOut();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selector]);

  const signBatch = useCallback(
    async (receiverId: string, calls: SignArgs[]): Promise<string> => {
      if (!selector) throw new Error("no wallet connected yet");
      const wallet = await selector.wallet();
      const outcome = await wallet.signAndSendTransaction({
        receiverId,
        // Wallet selector v10 takes near-js actions. `internalActionToNaj`
        // converts the readable shape, so the gas and deposit stay plain
        // strings here rather than becoming borsh-encoded by hand.
        actions: calls.map((c) =>
          internalActionToNaj({
            type: "FunctionCall",
            params: {
              methodName: c.method,
              args: c.args,
              gas: (BigInt(c.gas ?? 60) * TGAS).toString(),
              deposit: c.deposit ?? "0",
            },
          }),
        ),
      });
      return outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? "";
    },
    [selector],
  );

  const sign = useCallback(
    (args: SignArgs) => signBatch(args.contractId ?? CONTRACT_ID, [args]),
    [signBatch],
  );

  const value = useMemo<WalletState>(
    () => ({ ready, accountId, walletName, error, signIn, signOut, sign, signBatch }),
    [ready, accountId, walletName, error, signIn, signOut, sign, signBatch],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
