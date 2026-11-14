# WinCut Bots

Testnet has no traders. The pools sit untouched for days, so a price series read
from them is a flat line — and a chart of a flat line looks broken even though
it is perfectly accurate.

There were two ways to fix that. One is to generate plausible-looking candles,
which is lying. This package is the other one: WinCut mints its own token,
creates its own pool, and runs four accounts that make **real on-chain trades**
in it. Every candle is a real swap at a price that really executed.

**The honesty is in the labelling, not the data.** The site says, wherever these
accounts and this market appear, exactly what they are: a real market with a
known operator, which is a different thing from a fake one. That disclosure
lives in [`web/src/lib/bots.ts`](../web/src/lib/bots.ts) and shows up as a
`WinCut-operated market` card on the trade screen and `Bot` / `Market maker`
badges on the leaderboard.

---

## Why its own token

The obvious design is to peg a wNEAR/thUSDC pool to the real NEAR price. It does
not work, and the reason is worth writing down because it is not obvious until
you try to pay for it.

A pool at $3.49 per NEAR needs wNEAR and thUSDC in a 1:3.49 ratio. The wNEAR
side is therefore the binding constraint, and a faucet's worth of test NEAR buys
a pool a few dollars deep. Any trade big enough to see on a chart empties it.

A token we mint ourselves has no such constraint. We choose the ratio, so the
depth can sit entirely on the quote side — the side we can actually obtain —
while one MNEAR is still worth one real NEAR.

## The four accounts

| Account | What it is | How it trades |
| --- | --- | --- |
| `mm.` | Market maker | Swaps on Rhea directly |
| `momo.` | Momentum bot | Through WinCut, as a user |
| `revert.` | Mean-reversion bot | Through WinCut, as a user |
| `grid.` | Grid/DCA bot | Through WinCut, as a user |

**The maker is not a trader and is not ranked as one.** Its job is to make the
pool's price mean something: left alone, three bots pushing each other around
would walk the price to wherever their last argument ended, and the chart would
be a real record of nothing. The maker ties it to a number that exists outside
this system — what NEAR is worth on mainnet right now, read from
`v2.ref-finance.near` pool #4512 over plain RPC.

Three rules keep it from doing damage: it does nothing unless the peg was read
successfully, it only acts outside a ±0.6% band so the traders own the price
inside it, and it closes a fraction of the gap with an absolute cap, so one
strange read cannot walk the pool anywhere interesting.

**The three traders disagree on purpose.** Momentum chases a move, reversion
fades it, and the grid ignores both and buys on a clock. Three copies of one
strategy would push the price one way and hold it there; three that disagree are
a market. None is tuned to be profitable — a bot's job here is to be a
counterparty, and one that refused to take the other side would be useless.

Their limits are checked in code after the strategy has spoken, the same way the
agent works: 25% of balance per trade, a 5 tUSDC reserve kept back so a bot
always has something left to trade, and a refusal is logged as a refusal.

---

## Setup

Everything below assumes `near-cli-rs` with your key in
`~/.near-credentials/testnet/`. Run `npm install` in this folder first.

### Before you start

```bash
npm run plan
```

Prints the exact raw amounts for every command below, computed from the live
peg. **Read it again immediately before seeding the pool** — a pool seeded at a
stale ratio opens mispriced, and the maker's first act is then to correct a gap
that should never have existed.

You need roughly **7 NEAR** for setup (2.36 for the token, ~4 for four accounts,
the rest storage and gas), so claim once from
[near-faucet.io](https://near-faucet.io/) if you are short.

### 1. Mint the token

```bash
near contract call-function as-transaction tkn.primitives.testnet create_token \
  json-args '{"args":{"owner_id":"trader.wincut-mansi.testnet","total_supply":"<from npm run plan>","metadata":{"spec":"ft-1.0.0","name":"WinCut Mirror NEAR","symbol":"MNEAR","decimals":24}}}' \
  prepaid-gas '100 Tgas' attached-deposit '2.4 NEAR' \
  sign-as trader.wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```

Deploys an NEP-141 at `mnear.tkn.primitives.testnet` with the whole supply owned
by you. The factory needs ~2.357 NEAR; 2.4 covers it with room.

### 2. Create the pool

```bash
near contract call-function as-transaction ref-finance-101.testnet add_simple_pool \
  json-args '{"tokens":["thusdc.testnet","mnear.tkn.primitives.testnet"],"fee":30}' \
  prepaid-gas '50 Tgas' attached-deposit '0.1 NEAR' \
  sign-as trader.wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```

A 0.3% SIMPLE_POOL. **The return value is the pool id — keep it**, it becomes
`MIRROR_POOL_ID`.

### 3. Register and deposit both tokens into Rhea

```bash
near contract call-function as-transaction mnear.tkn.primitives.testnet storage_deposit \
  json-args '{"account_id":"ref-finance-101.testnet","registration_only":true}' \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' \
  sign-as trader.wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```
*Lets Rhea hold MNEAR at all.*

```bash
near contract call-function as-transaction ref-finance-101.testnet storage_deposit \
  json-args '{"account_id":"trader.wincut-mansi.testnet","registration_only":false}' \
  prepaid-gas '30 Tgas' attached-deposit '0.1 NEAR' \
  sign-as trader.wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```
*Storage for your own Rhea account, which holds deposits before they become liquidity.*

Then move both tokens in — `msg` is empty, which means "deposit, do not swap":

```bash
near contract call-function as-transaction thusdc.testnet ft_transfer_call \
  json-args '{"receiver_id":"ref-finance-101.testnet","amount":"<pool quote from npm run plan>","msg":""}' \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as trader.wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```

```bash
near contract call-function as-transaction mnear.tkn.primitives.testnet ft_transfer_call \
  json-args '{"receiver_id":"ref-finance-101.testnet","amount":"<pool base from npm run plan>","msg":""}' \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as trader.wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```

### 4. Seed the pool at the peg

```bash
near contract call-function as-read-only ref-finance-101.testnet get_pool \
  json-args '{"pool_id":<POOL_ID>}' network-config testnet now
```
*Check the token ordering first — `amounts` below must match `token_account_ids`.*

```bash
near contract call-function as-transaction ref-finance-101.testnet add_liquidity \
  json-args '{"pool_id":<POOL_ID>,"amounts":["<quote>","<base>"]}' \
  prepaid-gas '100 Tgas' attached-deposit '0.01 NEAR' \
  sign-as trader.wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```

This is the moment the price is set. Re-run `npm run plan` first.

### 5. List it on WinCut

Owner-only, and the owner is the contract account itself:

```bash
near contract call-function as-transaction wincut-mansi.testnet list_token \
  json-args '{"token_id":"mnear.tkn.primitives.testnet","symbol":"MNEAR","decimals":24,"hops":[{"pool_id":<POOL_ID>,"token_in":"thusdc.testnet","token_out":"mnear.tkn.primitives.testnet"}],"chart_pool":""}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```
*One hop, quote straight to the token. `chart_pool` is `""` because there is no GeckoTerminal on testnet.*

```bash
near contract call-function as-transaction wincut-mansi.testnet register_token \
  json-args '{"token_id":"mnear.tkn.primitives.testnet"}' \
  prepaid-gas '60 Tgas' attached-deposit '0.05 NEAR' \
  sign-as wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```
*Does the storage deposits the contract needs on the token and on Rhea. Without it `buy` refuses.*

### 6. Create the four bot accounts

Once per account, with `mm`, `momo`, `revert`, `grid`:

```bash
near account create-account fund-myself <name>.wincut-mansi.testnet '1 NEAR' \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```

The three traders then get a restricted key each — same shape as the agent's,
so a leak of one cannot move money:

```bash
near account add-key <name>.wincut-mansi.testnet \
  grant-function-call-access \
    --allowance '0.5 NEAR' \
    --contract-account-id wincut-mansi.testnet \
    --function-names 'buy,sell' \
  autogenerate-new-keypair print-to-terminal \
  network-config testnet sign-with-legacy-keychain send
```

**The maker does not get one.** It calls `ft_transfer_call`, which needs one
yoctoNEAR attached, and a function-call key cannot attach a deposit. So `mm.`
signs with its full-access key — and holds nothing but gas and the pool
inventory, so the worst a leak does is move the peg on a testnet pool.

### 7. Fund them

For each of the three traders, from your own account:

```bash
near contract call-function as-transaction thusdc.testnet ft_transfer_call \
  json-args '{"receiver_id":"wincut-mansi.testnet","amount":"150000000","msg":"{\"deposit_for\":\"momo.wincut-mansi.testnet\"}"}' \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as trader.wincut-mansi.testnet \
  network-config testnet sign-with-legacy-keychain send
```

The maker needs tokens in its **wallet**, not in WinCut, because it swaps
directly — `ft_transfer` (no `_call`) for both thUSDC and MNEAR, amounts from
`npm run plan`. Register it on each token first with `storage_deposit`
(`0.00125 NEAR`, `registration_only: true`).

### 8. Configure and run

```bash
cp .env.example .env    # fill in MIRROR_POOL_ID and the four keys
npm run plan            # sanity-check the numbers
npm run dry             # real data, real decisions, nothing signed
npm run bots            # the loop
```

| Variable | Needed? | What it does |
| --- | --- | --- |
| `MIRROR_POOL_ID` | **yes** | From step 2. Without it the bots refuse to start. |
| `MM_PRIVATE_KEY` | for the peg | Full-access key of `mm.`. Without it the peg drifts. |
| `BOT1_PRIVATE_KEY` … `BOT3_` | to trade | The function-call keys from step 6. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | for the chart | Same database as the web app, so prices land in the series. |
| `MIRROR_TOKEN_ID` / `_SYMBOL` / `_DECIMALS` | no | Default to MNEAR at 24 decimals. |
| `PEG_BAND_PCT` | no | Drift the maker tolerates. Default 0.6. Smaller means a flatter chart. |
| `PEG_MAX_TRADE_USDC` | no | Cap on one correction. Default 120. |
| `BOT1_SIZE` … , `BOT1_EVERY_MS` … | no | Per-bot trade size and cadence. |
| `DRY_RUN` | no | `1` to decide without signing. |

### 9. Turn the labels on in the web app

In Vercel, so the site discloses what it is running:

```
NEXT_PUBLIC_MIRROR_TOKEN_ID=mnear.tkn.primitives.testnet
NEXT_PUBLIC_MM_ACCOUNT=mm.wincut-mansi.testnet
NEXT_PUBLIC_BOT_ACCOUNTS=momo.wincut-mansi.testnet,revert.wincut-mansi.testnet,grid.wincut-mansi.testnet
NEXT_PUBLIC_TOKENS=mnear.tkn.primitives.testnet,wrap.testnet,…
```

These are `NEXT_PUBLIC_`, so they are inlined at build time — changing them
needs a redeploy. **Do this in the same deploy that first shows the market.** A
WinCut-operated market presented without its badge is the one genuinely
dishonest state this whole package can get into.

---

## The liquidity floor

The first live run produced no trades at all, and every actor had a good reason:

```
grid   : refused a BUY - size 8 is over the 25% per-trade cap of 7.50
momo   : HOLD - 0 of the last two ticks up, 0.00% over three
revert : HOLD - 0.00% from its average, inside the +/-0.5% band it acts on
maker  : drift -0.19%, inside the band - leaving the price to the traders
```

Each line is correct in isolation and the four of them together are a deadlock.
The strategies only act when the price moves; the price only moves when they
act. Nobody is wrong and nothing happens.

Two things fix it. The grid bot's refusal was a plain bug - a limit should shape
a trade, not cancel it, so a buy is now trimmed to the cap rather than refused
above it, and the grid alternates buys with sells so it cannot spend itself down
to a balance too small to trade with. And every bot now has a floor on its own
silence: if its strategy has held for three to six minutes (randomised per bot,
so they do not arrive together), it makes a small randomised trade anyway.

That trade is inside exactly the same limits as any other - the clock decides
*that* it trades, never *how much*. It is labelled `[liquidity]` in the log,
carried as a flag through the decision, and disclosed on the site, because a
timed trade is evidence about the market's liquidity and nothing whatever about
the strategy's judgement. Letting it appear as a strategy decision would be the
one dishonest thing in this package.

## Running it somewhere that stays up

Same shape as the agent: a long-running worker, no inbound port.

- **Railway** — Root Directory `bots`, start `npm run bots`, no healthcheck.
- **Render** — **Background Worker**, not a Web Service.
- **A VPS** — `pm2 start npm --name wincut-bots -- run bots`.

Put the four keys in the platform's secret store, never in the repo.

## Layout

| File | What lives there |
| --- | --- |
| `src/config.ts` | Accounts, the peg source, the band, the limits |
| `src/chain.ts` | Views, WinCut trades, direct Rhea swaps |
| `src/peg.ts` | Mainnet NEAR price, pool price, and the exact re-peg trade |
| `src/mm.ts` | The market maker |
| `src/traders.ts` | Price history and the three strategies |
| `src/store.ts` | Prices into the same series the chart reads |
| `src/plan.ts` | `npm run plan` — raw amounts from the live peg |
| `src/index.ts` | The loop |
