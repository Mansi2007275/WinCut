# Deploying WinCut

Two things deploy independently: the contract, to NEAR, and the web app, to Vercel.
The app reads the contract, so deploy the contract first.

Live today: **<https://wincut.vercel.app>**, pointed at `wincut-mansi.testnet` on NEAR testnet.

---

## 1. The contract

### Testnet

Free, and what the live demo runs on. The contract takes `usdc_id` and `ref_id` as
optional init arguments, so the same wasm runs on either network with no rebuild.

```bash
# the wasm, built in WSL because Windows here has no MSVC linker
wsl -d Ubuntu -- bash near-contract/build.sh all

near contract deploy wincut-mansi.testnet \
  use-file near-contract/out/wincut.wasm \
  with-init-call new json-args \
    '{"owner_id":"wincut-mansi.testnet","usdc_id":"thusdc.testnet","ref_id":"ref-finance-101.testnet"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send
```

Then `storage_deposit` the contract on the quote token, `list_token` each market, and
`register_token` each one. Every id is in [`near-contract/addresses.testnet.json`](../near-contract/addresses.testnet.json);
`node scripts/verify-testnet.mjs` re-checks them all against the chain and exits non-zero on drift.

A testnet account with a faucet-funded balance and a key on disk is one command:

```bash
near account create-account sponsor-by-faucet-service <name>.testnet \
  autogenerate-new-keypair save-to-legacy-keychain \
  network-config testnet create
```

### Mainnet

`node scripts/print-deploy-commands.mjs wincut.youraccount.near youraccount.near` prints every
command from the verified addresses file. Budget about **6.4 NEAR**: ~3.8 of it is storage stake
for the 380 KB of code, the rest is state headroom, the six `register_token` deposits and gas.
There is no faucet for mainnet.

---

## 2. The web app on Vercel

### Project settings

| setting | value |
|---|---|
| Root directory | `web` |
| Framework | Next.js (auto-detected) |
| Build command | `next build` (default) |
| Node version | 20 or newer |

The repo root is not the app root — set **Root directory to `web`** or the build will not find
`package.json`.

### Environment variables

Set these under Settings → Environment Variables, for Production and Preview.
None of the `NEXT_PUBLIC_` ones are secret; the last three are.

| variable | testnet value | notes |
|---|---|---|
| `NEXT_PUBLIC_NETWORK` | `testnet` | `mainnet` switches every data path back to GeckoTerminal |
| `NEXT_PUBLIC_CONTRACT_ID` | `wincut-mansi.testnet` | empty means "not deployed", and the app says so |
| `NEXT_PUBLIC_RPC_URL` | `https://test.rpc.fastnear.com` | falls back to two more endpoints on its own |
| `NEXT_PUBLIC_REF_CONTRACT` | `ref-finance-101.testnet` | |
| `NEXT_PUBLIC_USDC_ID` | `thusdc.testnet` | must be a 6-decimal token: the contract pins `USDC_DECIMALS = 6` |
| `NEXT_PUBLIC_TOKENS` | see below | display order; **no default**, so an empty value shows no markets |
| `UPSTASH_REDIS_REST_URL` | from Upstash | secret |
| `UPSTASH_REDIS_REST_TOKEN` | from Upstash | secret |
| `CRON_SECRET` | any long random string | secret; guards the two writing routes |
| `ONECLICK_API_KEY` | optional | mainnet only, raises the 1Click rate limit |

```
NEXT_PUBLIC_TOKENS=wrap.testnet,lnc.factory.tokenhub.testnet,token.pembrock.testnet,phoenix-bonds.testnet,mev-33.factory.v9.meme-cooking.testnet,shit1.gf-bignumbers.testnet
```

`NEXT_PUBLIC_*` values are inlined at build time, so changing one needs a redeploy, not just a restart.

### Deploying

```bash
cd web
vercel deploy --prod --yes
```

The production alias is public; the per-deployment `*-<hash>-<team>.vercel.app` URLs sit behind
Vercel Authentication and will 302 an unauthenticated request. Test against the alias.

---

## 3. The price series (testnet only)

GeckoTerminal indexes NEAR mainnet only, so on testnet WinCut is its own indexer.
Three things write price points, all of them real on-chain prices:

| source | written by | what it is |
|---|---|---|
| `sample` | `/api/sample`, on a cron | the pool mid, computed from the reserves right now |
| `backfill` | `/api/backfill`, once | the price a historical swap actually executed at |
| `trade` | a settled WinCut buy or sell | the price that trade filled at |

`/api/candles?pool=<id>&tf=<1m\|5m\|15m\|1h\|4h\|1d>` folds them into OHLC server-side, carrying
the last close forward across empty buckets so the line has no gaps.

### Upstash

Create a Redis database at [console.upstash.com](https://console.upstash.com), then copy
**UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** from its REST API panel. One sorted
set per pool, scored by timestamp in ms. The free tier is far more than this needs.

Without these the app still builds and runs — the chart says it is not collecting yet rather
than drawing an invented line.

### The cron, on cron-job.org

1. Create a job at [cron-job.org](https://cron-job.org).
2. URL: `https://wincut.vercel.app/api/sample`
3. Schedule: **every minute** (every 5 minutes is fine too — it only changes how fine the
   candles get).
4. Under *Advanced* → *Headers*, add:

   ```
   x-cron-secret: <the same value as CRON_SECRET>
   ```

5. Save and run it once by hand. A healthy response is `200` with `"ok": true` and one entry
   per market in `sampled`.

Vercel Cron works equally well if you would rather keep it in-platform; it needs the same header.

### Backfilling

A one-off, and slow by design — NearBlocks' free tier allows roughly six requests a minute and
the route throttles to stay inside it.

```bash
curl -H "x-cron-secret: $CRON_SECRET" \
  "https://wincut.vercel.app/api/backfill?token=wrap.testnet&pages=6"
```

Add `&dry=1` to see what it would find without writing anything.

**What to expect on these pools: nothing.** Pool #2082 has three swaps in its entire history,
the newest from March 2025, and NearBlocks does not index `wrap.testnet` token events at all —
so the second side of a wNEAR swap is invisible and none of the three can be priced. The route
reports this rather than failing quietly. On testnet the chart is built by the sampler and by
WinCut's own trades, which is what the "collecting on-chain data since …" note above the chart
is telling you.

---

## 4. Switching to mainnet later

One environment change, then redeploy:

```
NEXT_PUBLIC_NETWORK=mainnet
NEXT_PUBLIC_CONTRACT_ID=wincut.youraccount.near
NEXT_PUBLIC_RPC_URL=https://free.rpc.fastnear.com
NEXT_PUBLIC_REF_CONTRACT=v2.ref-finance.near
NEXT_PUBLIC_USDC_ID=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
NEXT_PUBLIC_TOKENS=wrap.near,token.rhealab.near,token.burrow.near,blackdragon.tkn.near,token.0xshitzu.near,token.lonkingnearbackto2024.near
```

Candles, 24h volume and swap pressure go back to GeckoTerminal, prices render as `$` instead of
`tUSDC`, the testnet badge disappears, and the sampler and backfill routes start refusing calls
as testnet-only. Upstash and `CRON_SECRET` can stay set; nothing reads them on mainnet.

## The autonomous agent (optional)

The agent is a separate long-running process that lives in `agent/`, not part
of this deployment. It needs no inbound port, so it does not belong on Vercel;
`agent/README.md` covers Railway, Render, a VPS and a Codespace.

Two things connect it to this app:

| Where | Variable | Why |
| --- | --- | --- |
| Vercel | `NEXT_PUBLIC_AGENT_ACCOUNT_ID` | The agent's account id. Set it and the app marks that trader as an AI agent and shows its decision log. Leave it empty and nothing about the agent appears. |
| The agent's host | `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Point the agent at the **same** Upstash database as this app, so `/trader/<agent>` reads what the agent writes. |

`NEXT_PUBLIC_AGENT_ACCOUNT_ID` is inlined at build time like every other
`NEXT_PUBLIC_` value, so changing it needs a redeploy, not just a restart.

Nothing else is required here: the agent trades through the contract, so its
balances, positions, trades, followers and earnings are already readable by the
app the way any other trader's are. The only thing Upstash adds is the
reasoning.
