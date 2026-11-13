/**
 * The five things a user can sign, with the gas and deposit each one needs.
 *
 * Gas is not guesswork: `buy` and `sell` each fan out into a Rhea swap, a
 * balance read and a settlement callback, and the contract itself refuses
 * anything under 170 Tgas. 200 leaves headroom for a two-hop route without
 * pushing against the 300 Tgas ceiling.
 */

import { CONTRACT_ID, USDC_ID } from "./near";
import type { SignArgs } from "./wallet";

/** Enough for the swap, the balance read and the settlement, with headroom. */
export const TRADE_GAS = 200;
const ONE_YOCTO = "1";

/** NEP-145 storage on a token, in yoctoNEAR: 0.00125 NEAR. */
export const STORAGE_DEPOSIT_YOCTO = "1250000000000000000000";

/**
 * Moves USDC from the wallet into the WinCut balance.
 *
 * This is a transfer on the USDC contract, not on WinCut, so it carries the
 * one yoctoNEAR every NEP-141 transfer needs and is signed by the wallet.
 */
export function depositUsdc(amountRaw: bigint): SignArgs {
  return {
    contractId: USDC_ID,
    method: "ft_transfer_call",
    args: {
      receiver_id: CONTRACT_ID,
      amount: amountRaw.toString(),
      msg: "deposit",
    },
    gas: 100,
    deposit: ONE_YOCTO,
  };
}

export function withdrawUsdc(amountRaw: bigint): SignArgs {
  return {
    method: "withdraw",
    args: { amount: amountRaw.toString() },
    gas: 60,
    deposit: ONE_YOCTO,
  };
}

export function claimEarnings(): SignArgs {
  return { method: "claim", args: {}, gas: 60, deposit: ONE_YOCTO };
}

export function buy(params: {
  tokenId: string;
  usdcIn: bigint;
  minOut: bigint;
  followed?: string | null;
  referrer?: string | null;
}): SignArgs {
  return {
    method: "buy",
    args: {
      token_id: params.tokenId,
      usdc_in: params.usdcIn.toString(),
      min_out: params.minOut.toString(),
      followed: params.followed ?? null,
      referrer: params.referrer ?? null,
    },
    gas: TRADE_GAS,
    deposit: "0",
  };
}

export function sell(params: {
  tokenId: string;
  amount: bigint;
  minOutUsdc: bigint;
}): SignArgs {
  return {
    method: "sell",
    args: {
      token_id: params.tokenId,
      amount: params.amount.toString(),
      min_out_usdc: params.minOutUsdc.toString(),
    },
    gas: TRADE_GAS,
    deposit: "0",
  };
}

/**
 * Pays the caller's own NEP-145 storage on USDC.
 *
 * Needed before a withdrawal or a claim can land: an unregistered account
 * cannot receive USDC, and the transfer would bounce. WinCut puts the money
 * back when that happens, but it is better to offer this first.
 */
export function registerSelfOnUsdc(accountId: string): SignArgs {
  return {
    contractId: USDC_ID,
    method: "storage_deposit",
    args: { account_id: accountId, registration_only: true },
    gas: 30,
    deposit: STORAGE_DEPOSIT_YOCTO,
  };
}
