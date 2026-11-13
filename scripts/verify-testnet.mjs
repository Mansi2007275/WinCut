#!/usr/bin/env node
/**
 * Re-checks every testnet fact in near-contract/addresses.testnet.json against
 * the chain, and exits non-zero on any drift.
 *
 * The testnet counterpart of verify-mainnet.mjs. It is stricter in one way:
 * reserves alone do not prove a pool is usable on testnet, because the chain
 * carries abandoned DEGEN_SWAP pools that hold liquidity and still panic on
 * every quote. So each route is also proven with a live get_return.
 *
 *   node scripts/verify-testnet.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "near-contract", "addresses.testnet.json");
const A = JSON.parse(readFileSync(file, "utf8"));

const RPC = process.env.NEAR_TESTNET_RPC ?? A.rpc_used ?? "https://test.rpc.fastnear.com";

let failures = 0;
const ok = (m, extra = "") => console.log(`  ok   ${m}${extra ? "  " + extra : ""}`);
const bad = (m, extra = "") => {
  failures++;
  console.log(`  FAIL ${m}${extra ? "  " + extra : ""}`);
};

async function view(accountId, methodName, args = {}) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error("rpc: " + JSON.stringify(json.error).slice(0, 160));
  if (json.result?.error) throw new Error("contract: " + String(json.result.error).slice(0, 180));
  if (!json.result?.result) throw new Error("empty result");
  return JSON.parse(Buffer.from(json.result.result).toString());
}

const shorten = (id) => (id.length > 24 ? id.slice(0, 12) + ".." + id.slice(-10) : id);

console.log(`WinCut testnet verification - ${A.verified_at} (block ${A.verified_at_block})`);
console.log(`rpc ${RPC}\n`);

// ---------------------------------------------------------------- exchange
console.log("exchange");
try {
  const n = await view(A.dex.contract_id, "get_number_of_pools");
  ok(`dex ${A.dex.contract_id} reachable`, `pools=${n}`);
  if (typeof n !== "number" || n < 1) bad("dex reports no pools", String(n));
} catch (e) {
  bad(`dex ${A.dex.contract_id} unreachable`, e.message);
}

// ------------------------------------------------------------------ quote ccy
console.log("\nquote currency");
try {
  const m = await view(A.usdc.token_id, "ft_metadata");
  m.symbol === A.usdc.symbol
    ? ok(`usdc id ${A.usdc.token_id}`, `symbol=${m.symbol}`)
    : bad(`usdc symbol`, `claimed ${A.usdc.symbol}, on-chain ${m.symbol}`);
  m.decimals === A.usdc.decimals
    ? ok(`usdc decimals = ${A.usdc.decimals}`, `on-chain=${m.decimals}`)
    : bad(`usdc decimals`, `claimed ${A.usdc.decimals}, on-chain ${m.decimals}`);
  if (m.decimals !== 6)
    bad("usdc must be 6 decimals", "the contract pins USDC_DECIMALS = 6");
} catch (e) {
  bad(`usdc ${A.usdc.token_id} unreadable`, e.message);
}

try {
  const m = await view(A.wnear.token_id, "ft_metadata");
  m.decimals === A.wnear.decimals
    ? ok(`wnear id ${A.wnear.token_id}`, `symbol=${m.symbol} decimals=${m.decimals}`)
    : bad(`wnear decimals`, `claimed ${A.wnear.decimals}, on-chain ${m.decimals}`);
} catch (e) {
  bad(`wnear ${A.wnear.token_id} unreadable`, e.message);
}

// ----------------------------------------------------------------- routes
console.log("\nroutes");
const poolCache = new Map();
async function pool(id) {
  if (!poolCache.has(id)) poolCache.set(id, await view(A.dex.contract_id, "get_pool", { pool_id: id }));
  return poolCache.get(id);
}

for (const t of A.tokens) {
  console.log(`  token ${t.symbol} (${t.token_id})`);

  try {
    const m = await view(t.token_id, "ft_metadata");
    m.decimals === t.decimals
      ? ok(`  decimals = ${t.decimals}`, `on-chain=${m.decimals}`)
      : bad(`  decimals`, `claimed ${t.decimals}, on-chain ${m.decimals}`);
  } catch (e) {
    bad(`  metadata unreadable`, e.message);
  }

  for (const hop of t.route_from_usdc) {
    try {
      const p = await pool(hop.pool_id);
      p.pool_kind === "SIMPLE_POOL"
        ? ok(`  pool #${hop.pool_id} is SIMPLE_POOL`)
        : bad(`  pool #${hop.pool_id} kind`, `${p.pool_kind}, the router needs SIMPLE_POOL`);

      const holds =
        p.token_account_ids.includes(hop.token_in) && p.token_account_ids.includes(hop.token_out);
      holds
        ? ok(`  pool #${hop.pool_id} holds ${shorten(hop.token_in)}/${shorten(hop.token_out)}`)
        : bad(`  pool #${hop.pool_id} pair`, p.token_account_ids.join(","));

      p.amounts.every((a) => BigInt(a) > 0n)
        ? ok(`  pool #${hop.pool_id} has liquidity`, p.amounts.join(","))
        : bad(`  pool #${hop.pool_id} has an empty side`, p.amounts.join(","));

      if (typeof t.pool_fee_bps === "number" && hop === t.route_from_usdc[t.route_from_usdc.length - 1]) {
        p.total_fee === t.pool_fee_bps
          ? ok(`  pool #${hop.pool_id} fee = ${t.pool_fee_bps} bps`)
          : bad(`  pool #${hop.pool_id} fee`, `claimed ${t.pool_fee_bps}, on-chain ${p.total_fee}`);
      }
    } catch (e) {
      bad(`  pool #${hop.pool_id} unreadable`, e.message);
    }
  }

  // the decisive check: does $100 actually quote all the way through?
  try {
    let amount = (100n * 10n ** BigInt(A.usdc.decimals)).toString();
    for (const hop of t.route_from_usdc) {
      amount = await view(A.dex.contract_id, "get_return", {
        pool_id: hop.pool_id,
        token_in: hop.token_in,
        amount_in: amount,
        token_out: hop.token_out,
      });
    }
    const out = Number(amount) / 10 ** t.decimals;
    out > 0
      ? ok(`  live quote $100 -> ${out.toPrecision(8)} ${t.symbol}`)
      : bad(`  live quote returned zero`);
  } catch (e) {
    bad(`  live quote failed`, e.message);
  }
}

console.log(
  failures === 0
    ? "\nAll testnet facts verified."
    : `\n${failures} check(s) failed - addresses.testnet.json has drifted from the chain.`,
);
process.exit(failures === 0 ? 0 : 1);
