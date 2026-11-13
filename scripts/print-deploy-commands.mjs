#!/usr/bin/env node
/**
 * Prints the exact commands to deploy WinCut to NEAR mainnet and list every
 * verified token. Generated from near-contract/addresses.near.json so the pool
 * ids in the commands are the ones that were checked on chain.
 *
 *   node scripts/print-deploy-commands.mjs wincut.youraccount.near youraccount.near
 *
 * Nothing here is executed and no key is ever read. Run the commands yourself.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const a = JSON.parse(readFileSync(join(HERE, "..", "near-contract", "addresses.near.json"), "utf8"));

const CONTRACT = process.argv[2];
const OWNER = process.argv[3] ?? CONTRACT?.split(".").slice(1).join(".");

if (!CONTRACT) {
  console.error("usage: node scripts/print-deploy-commands.mjs <contract-account> [owner-account]");
  console.error("   eg: node scripts/print-deploy-commands.mjs wincut.alice.near alice.near");
  process.exit(2);
}

const h1 = (s) => `\n\x1b[1m# ${s}\x1b[0m`;
const out = [];
const say = (...l) => out.push(...l);

say(h1("0. one-time tooling"));
say(`cargo install cargo-near --locked`);
say(`npm install -g near-cli-rs`);

say(h1("1. create the contract sub-account (funds it from the parent)"));
say(`near account create-account fund-myself ${CONTRACT} '6 NEAR' \\`);
say(`  autogenerate-new-keypair save-to-keychain \\`);
say(`  sign-as ${OWNER} network-config mainnet sign-with-keychain send`);

say(h1("2. build the wasm reproducibly"));
say(`cd near-contract && cargo near build reproducible-wasm`);
say(`# non-docker fallback:  cargo near build non-reproducible-wasm`);

say(h1("3. deploy and initialise in one transaction"));
say(`near contract deploy ${CONTRACT} \\`);
say(`  use-file target/near/wincut.wasm \\`);
say(`  with-init-call new json-args '${JSON.stringify({ owner_id: OWNER })}' \\`);
say(`  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \\`);
say(`  network-config mainnet sign-with-keychain send`);

say(h1("4. register the contract on USDC so it can hold and pay out USDC"));
say(`near contract call-function as-transaction ${a.usdc.token_id} storage_deposit \\`);
say(`  json-args '${JSON.stringify({ account_id: CONTRACT, registration_only: true })}' \\`);
say(`  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' \\`);
say(`  sign-as ${OWNER} network-config mainnet sign-with-keychain send`);

say(h1(`5. list the ${a.tokens.length} verified tokens and their Rhea routes`));
for (const t of a.tokens) {
  const args = {
    token_id: t.token_id,
    symbol: t.symbol,
    decimals: t.decimals,
    hops: t.route_from_usdc.map((h) => ({
      pool_id: h.pool_id,
      token_in: h.token_in,
      token_out: h.token_out,
    })),
    chart_pool: t.gecko_terminal_pool,
  };
  say(`\n# ${t.symbol} via pool${t.route_from_usdc.length > 1 ? "s" : ""} ${t.route_from_usdc.map((h) => "#" + h.pool_id).join(" then ")}`);
  say(`near contract call-function as-transaction ${CONTRACT} list_token \\`);
  say(`  json-args '${JSON.stringify(args)}' \\`);
  say(`  prepaid-gas '60 Tgas' attached-deposit '0 NEAR' \\`);
  say(`  sign-as ${OWNER} network-config mainnet sign-with-keychain send`);
}

say(h1("6. pay NEP-145 storage for each token (on the token and on Rhea), which marks it tradable"));
for (const t of a.tokens) {
  say(`\n# ${t.symbol}`);
  say(`near contract call-function as-transaction ${CONTRACT} register_token \\`);
  say(`  json-args '${JSON.stringify({ token_id: t.token_id })}' \\`);
  say(`  prepaid-gas '60 Tgas' attached-deposit '0.05 NEAR' \\`);
  say(`  sign-as ${OWNER} network-config mainnet sign-with-keychain send`);
}

say(h1("7. check it took"));
say(`near contract call-function as-read-only ${CONTRACT} get_tokens json-args {} \\`);
say(`  network-config mainnet now`);
say(`near contract call-function as-read-only ${CONTRACT} get_config json-args {} \\`);
say(`  network-config mainnet now`);
say(`# every token should come back with "registered": true`);

say(h1("8. point the frontend at it"));
say(`# web/.env.local`);
say(`NEXT_PUBLIC_NETWORK=mainnet`);
say(`NEXT_PUBLIC_CONTRACT_ID=${CONTRACT}`);
say(`NEXT_PUBLIC_RPC_URL=${a.rpc_used}`);
say(`NEXT_PUBLIC_REF_CONTRACT=${a.dex.contract_id}`);
say(`NEXT_PUBLIC_USDC_ID=${a.usdc.token_id}`);
say(`NEXT_PUBLIC_TOKENS=${a.tokens.map((t) => t.token_id).join(",")}`);

console.log(out.join("\n"));
console.log(
  `\n\x1b[2mAll ids above were verified on mainnet at block ${a.verified_at_block}. Re-check with: node scripts/verify-mainnet.mjs\x1b[0m`,
);
