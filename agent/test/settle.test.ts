/**
 * What the agent decides a trade did.
 *
 * The case these exist for: the chain executes a buy, and the RPC that was
 * asked to broadcast it answers `Internal server error` anyway. The agent used
 * to read that reply as the verdict and write "the transaction failed" onto a
 * public page, beside a trade that had settled. The position was open, the
 * balance had moved, the trade was in the contract's ring, and the log said it
 * had failed.
 *
 * So each case below states what the broadcast said, what the chain says, and
 * which of the two the agent is supposed to believe.
 */

import { settleTrade } from "../src/settle.js";
import type { SendResult, TxVerdict } from "../src/chain.js";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

const run = async (label: string, body: () => Promise<boolean>) => {
  try {
    check(label, await body());
  } catch (e) {
    check(label, false, (e as Error).message);
  }
};

const HASH = "4Qy1LqGx8s7m3pVnB2cWd5fHjK9tRzA6eYu1oPiNsXvM";

const sends = (r: SendResult) => async (): Promise<SendResult> => r;
const says = (v: TxVerdict) => async (): Promise<TxVerdict> => v;

console.log("an RPC error after the chain has already succeeded");

await run("a broadcast error plus a chain success records the trade", async () => {
  const s = await settleTrade(
    sends({ hash: HASH, error: "transaction failed: Internal server error" }),
    says({ status: "success" }),
  );
  return s.txHash === HASH && s.error === undefined;
});

await run("the RPC trouble is kept as a note rather than hidden", async () => {
  const s = await settleTrade(
    sends({ hash: HASH, error: "Internal server error" }),
    says({ status: "success" }),
  );
  // Not called a failure, but not swept away either: the entry says the
  // broadcast misbehaved and that the chain contradicted it.
  return (
    s.note !== undefined &&
    /Internal server error/.test(s.note) &&
    /chain confirms/i.test(s.note)
  );
});

await run("the hash is looked up even when the broadcast reported no trouble", async () => {
  let asked = "";
  const s = await settleTrade(sends({ hash: HASH }), async (h) => {
    asked = h;
    return { status: "success" };
  });
  return asked === HASH && s.txHash === HASH && s.error === undefined && s.note === undefined;
});

console.log("when the chain does say it failed");

await run("a chain failure is recorded as a failure, with what the chain said", async () => {
  const s = await settleTrade(
    sends({ hash: HASH }),
    says({ status: "failure", detail: "Smart contract panicked: slippage" }),
  );
  return s.txHash === HASH && s.error === "Smart contract panicked: slippage";
});

await run("a chain failure outranks a broadcast that looked fine", async () => {
  const s = await settleTrade(sends({ hash: HASH }), says({ status: "failure" }));
  return s.error !== undefined && s.txHash === HASH;
});

console.log("when the transaction never appears");

await run("a transaction the chain never heard of is a failure", async () => {
  const s = await settleTrade(
    sends({ hash: HASH, error: "socket hang up" }),
    says({ status: "unknown" }),
  );
  return s.txHash === undefined && /socket hang up/.test(s.error ?? "") && /never landed/.test(s.error ?? "");
});

await run("an unknown with a clean broadcast is still not called a success", async () => {
  const s = await settleTrade(sends({ hash: HASH }), says({ status: "unknown" }));
  return s.txHash === undefined && /never landed/.test(s.error ?? "");
});

await run("a trade that was never signed is not looked up at all", async () => {
  let asked = false;
  const s = await settleTrade(
    sends({ error: "AGENT_PRIVATE_KEY is not set" }),
    async () => {
      asked = true;
      return { status: "success" };
    },
  );
  return !asked && s.txHash === undefined && s.error === "AGENT_PRIVATE_KEY is not set";
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
