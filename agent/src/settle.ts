/**
 * What actually happened to a trade the agent sent.
 *
 * Sending a transaction and knowing its fate are two different questions, and
 * the agent used to conflate them. `signAndSendTransaction` throwing was taken
 * as "the trade failed", so a provider that executed the transaction and then
 * answered the follow-up with `Internal server error` produced a decision log
 * entry reading "the transaction failed: Internal server error" next to a buy
 * that had settled, moved the balance, and opened a position. The page said
 * the agent was broken while the chain said it had traded. Of the two, the
 * chain is the one that can be checked.
 *
 * So: the broadcast's own result is a hint, and the chain is the verdict.
 *
 *   success  - the chain executed it. Recorded as done, whatever the broadcast
 *              said, with the error kept as a note so the RPC trouble is not
 *              hidden either.
 *   failure  - the chain executed it and it reverted. Recorded as failed, with
 *              what the chain said.
 *   unknown  - the chain has never heard of it after several tries. It never
 *              landed, so it is recorded as failed, and the broadcast's own
 *              error is the best description of why.
 *
 * This file takes its two collaborators as arguments, which is what makes the
 * interesting case testable: an RPC that errors after the chain has already
 * succeeded is a two-line fake here and an unreproducible flake in real life.
 */

import type { SendResult, TxVerdict } from "./chain.js";

export type Settlement = {
  txHash?: string;
  /** Set only when the chain confirms a failure, or the transaction never appeared. */
  error?: string;
  /** Set when the broadcast reported an error that the chain then contradicted. */
  note?: string;
};

export async function settleTrade(
  send: () => Promise<SendResult>,
  confirm: (hash: string) => Promise<TxVerdict>,
): Promise<Settlement> {
  const sent = await send();

  if (!sent.hash) {
    return { error: sent.error ?? "the transaction was never signed, so there is nothing to check" };
  }

  const verdict = await confirm(sent.hash);

  if (verdict.status === "success") {
    return {
      txHash: sent.hash,
      note: sent.error
        ? `the broadcast reported "${sent.error}", but the chain confirms this transaction succeeded`
        : undefined,
    };
  }

  if (verdict.status === "failure") {
    return { txHash: sent.hash, error: verdict.detail ?? "the chain reports this transaction failed" };
  }

  return {
    error: sent.error
      ? `${sent.error} - and the chain has no record of ${sent.hash}, so it never landed`
      : `the chain has no record of ${sent.hash}, so it never landed`,
  };
}
