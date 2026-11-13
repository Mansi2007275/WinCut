#!/usr/bin/env node
/**
 * Re-verifies every id, pool and decimal in near-contract/addresses.near.json
 * against NEAR mainnet by RPC view call. Exits non-zero on any mismatch.
 *
 *   node scripts/verify-mainnet.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "near-contract", "addresses.near.json");
const RPCS = [
  process.env.NEAR_RPC_URL,
  "https://free.rpc.fastnear.com",
  "https://rpc.mainnet.near.org",
].filter(Boolean);

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
      });
      const j = await r.json();
      if (j.error) { lastErr = new Error(`${url}: ${JSON.stringify(j.error).slice(0, 200)}`); continue; }
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function view(account_id, method_name, args = {}) {
  const res = await rpc("query", {
    request_type: "call_function", finality: "final", account_id, method_name,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(res.result).toString());
}

const a = JSON.parse(readFileSync(FILE, "utf8"));
let fails = 0;
const ok = (label, pass, detail = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
  if (!pass) fails++;
};

const status = await rpc("status", []);
console.log(`\nNEAR ${status.chain_id} @ block ${status.sync_info.latest_block_height} (node ${status.version.version})\n`);
ok("network is mainnet", status.chain_id === "mainnet", status.chain_id);

// DEX
const refVersion = await view(a.dex.contract_id, "version");
const refPools = await view(a.dex.contract_id, "get_number_of_pools");
ok(`${a.dex.contract_id} responds to version()`, typeof refVersion === "string", `v${refVersion}`);
ok(`${a.dex.contract_id} has pools`, refPools > 1000, `${refPools} pools`);

// USDC + wNEAR metadata
for (const key of ["usdc", "wnear"]) {
  const t = a[key];
  const m = await view(t.token_id, "ft_metadata");
  ok(`${key} id ${t.token_id}`, m.symbol === t.symbol, `symbol=${m.symbol}`);
  ok(`${key} decimals = ${t.decimals}`, m.decimals === t.decimals, `on-chain=${m.decimals}`);
}

// Listed tokens + their routes
for (const t of a.tokens) {
  const m = await view(t.token_id, "ft_metadata");
  ok(`token ${t.symbol} (${t.token_id})`, m.symbol === t.symbol, `symbol=${m.symbol}`);
  ok(`  decimals = ${t.decimals}`, m.decimals === t.decimals, `on-chain=${m.decimals}`);
  for (const hop of t.route_from_usdc) {
    const p = await view(a.dex.contract_id, "get_pool", { pool_id: hop.pool_id });
    const holds = p.token_account_ids.includes(hop.token_in) && p.token_account_ids.includes(hop.token_out);
    const liquid = p.amounts.every((x) => BigInt(x) > 0n);
    ok(`  pool #${hop.pool_id} holds ${hop.token_in.slice(0, 12)}../${hop.token_out.slice(0, 12)}..`, holds, p.token_account_ids.join(","));
    ok(`  pool #${hop.pool_id} has liquidity`, liquid, p.amounts.join(","));
  }
}

console.log(fails === 0
  ? "\nAll mainnet facts verified.\n"
  : `\n${fails} check(s) FAILED - addresses.near.json is out of date.\n`);
process.exit(fails === 0 ? 0 : 1);
