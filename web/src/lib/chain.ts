import { defineChain, type Address } from "viem";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import deployed from "@/config/deployed.json";

/// Arc: Circle's L1 where USDC is the NATIVE gas token at 18 decimals.
/// The ERC-20 interface at 0x3600...0000 is the same money at 6 decimals;
/// we never touch it, because mixing the two is a 1e12 error.
export const arc = defineChain({
  id: deployed.chainId,
  name: deployed.chainName,
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [deployed.rpcUrl] } },
  blockExplorers: { default: { name: "Arc Explorer", url: deployed.explorer } },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [arc],
  connectors: [injected()],
  transports: { [arc.id]: http(deployed.rpcUrl) },
  ssr: true,
});

export const addr = {
  hook: deployed.contracts.winCutHook as Address,
  launcher: deployed.contracts.winCutLauncher as Address,
  quoter: deployed.contracts.winCutQuoter as Address,
  poolManager: deployed.contracts.poolManager as Address,
  universalRouter: deployed.contracts.universalRouter as Address,
  permit2: deployed.contracts.permit2 as Address,
} as const;

export const QUOTE = {
  address: deployed.quote.address as Address,
  symbol: deployed.quote.symbol,
  decimals: deployed.quote.decimals,
  isNative: deployed.quote.isNative,
} as const;

export const explorerTx = (hash: string) => `${deployed.explorer}/tx/${hash}`;
export const explorerAddr = (a: string) => `${deployed.explorer}/address/${a}`;
export const explorerBlock = (n: bigint | number) => `${deployed.explorer}/block/${n}`;

export const FAUCET_URL = deployed.faucet;

/**
 * Whether WinCut itself exists on the configured chain.
 *
 * deployed.json ships with zero contract addresses, because the repo should not
 * claim a deployment it does not have. Every screen checks this and says so,
 * rather than firing reads at address(0) and rendering a confusing error.
 */
export const isDeployed =
  addr.hook !== "0x0000000000000000000000000000000000000000" &&
  addr.launcher !== "0x0000000000000000000000000000000000000000";

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/// Native USDC is address(0), which always sorts to currency0.
export const quoteIsCurrency0 = (key: PoolKey) =>
  key.currency0.toLowerCase() === QUOTE.address.toLowerCase();

/// Buying = paying the quote currency in. Selling = paying coins in.
export const buyDirection = (key: PoolKey) => quoteIsCurrency0(key);
export const sellDirection = (key: PoolKey) => !quoteIsCurrency0(key);

export const coinOf = (key: PoolKey): Address =>
  quoteIsCurrency0(key) ? key.currency1 : key.currency0;

export { deployed };
