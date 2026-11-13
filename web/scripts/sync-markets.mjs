#!/usr/bin/env node
/**
 * Copies the verified mainnet routes out of near-contract/addresses.near.json
 * into src/config/markets.json, which the app bundles.
 *
 * It is used for exactly one thing: letting the market list and the charts
 * work before a contract has been deployed, so the app shows real Rhea prices
 * instead of an empty screen. Once NEXT_PUBLIC_CONTRACT_ID is set, the
 * contract's own `get_tokens` is the authority and this file is ignored.
 *
 *   npm run sync:markets
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "near-contract", "addresses.near.json");
const OUT = join(HERE, "..", "src", "config", "markets.json");

const a = JSON.parse(readFileSync(SRC, "utf8"));

const markets = {
  _generated: "npm run sync:markets - do not edit by hand",
  _source: "near-contract/addresses.near.json",
  verified_at_block: a.verified_at_block,
  usdc_id: a.usdc.token_id,
  ref_contract: a.dex.contract_id,
  tokens: a.tokens.map((t) => ({
    token_id: t.token_id,
    symbol: t.symbol,
    decimals: t.decimals,
    chart_pool: t.gecko_terminal_pool,
    hops: t.route_from_usdc.map((h) => ({
      pool_id: h.pool_id,
      token_in: h.token_in,
      token_out: h.token_out,
    })),
  })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(markets, null, 2) + "\n");
console.log(`wrote ${markets.tokens.length} verified markets to src/config/markets.json`);
