import { NETWORK } from "./near";

const BASE = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

export const explorerTx = (hash: string) => `${BASE}/txns/${hash}`;
export const explorerAccount = (id: string) => `${BASE}/address/${id}`;
export const explorerBlock = (height: number | string) => `${BASE}/blocks/${height}`;
export const explorerToken = (id: string) => `${BASE}/token/${id}`;
export const EXPLORER_NAME = "NearBlocks";
