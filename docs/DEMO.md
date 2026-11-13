# WinCut — two-minute demo

The whole pitch is one asymmetry: **you only pay when you win.** Everything below exists to get
to the moment a judge sees a sell settle for a $0.00 fee.

Run it end on that moment. Do not explain the fee first and demo it after — show the number.

---

## Before you start

- [ ] Contract deployed and all six tokens registered (`get_tokens` shows `registered: true`)
- [ ] `NEXT_PUBLIC_CONTRACT_ID` set in `web/.env.local`, and **rebuilt** — Next inlines
      `NEXT_PUBLIC_*` at build time, so changing it without rebuilding silently breaks hydration
- [ ] ~$40 of USDC deposited into WinCut, and ~2 NEAR for gas
- [ ] **A position already open at a loss.** This is the one piece of setup that matters: buy
      ~$20 of BRRR or LONK a few minutes before. Their pools are thin enough that the price
      impact alone puts you down, so you do not need the market to move for you.
- [ ] A second browser profile signed in as a different account, if you want to show copying
- [ ] Nothing else running on port 4000

Have `https://nearblocks.io/address/<your contract>` open in a second tab. Every claim below is
checkable there live, and offering that unprompted is worth more than any slide.

---

## The script

### 0:00 — the claim (15s)

Land on `/`.

> "Copy trading, on NEAR. The difference is the fee: the app, the trader you copied and your
> referrer earn **only when you profit**. Not when you trade. When you profit."

Drag the exit slider on the calculator down past zero.

> "Put in $1,000, come out at −20%, and the fee is zero. That number is not hardcoded — the page
> is asking the deployed contract what it would charge."

Scroll to the run of five trades.

> "Five trades: three losers, one flat, one good winner. A normal 1%-in-1%-out app charges
> **$99** on a run that ended $100 down. WinCut charges **nothing**, because the losses paid for
> the winner's fee."

### 0:20 — it is a real market (25s)

Go to `/trade/token.rhealab.near`.

> "This is RHEA against USDC on Rhea Finance, NEAR mainnet."

Point at the block height ticking in the header, then the stats bar.

> "Live block. Price from the pool reserves, $778K of usable liquidity, 0.599% pool fee — that
> is two hops compounded, because USDC only has one deep pool on NEAR and everything else routes
> through wNEAR."

Point at the depth panel.

> "No order book, because an AMM has no resting orders. Inventing one would be the easiest lie
> on a screen like this. Instead: what $100 fills at, what $50,000 fills at, from the reserves."

Switch the chart to 1m, then 1h.

> "Real OHLCV. And when I have a position, my entry and break-even get drawn on it."

### 0:45 — the buy is free (20s)

Open the order panel, type `10`.

> "Ten dollars of RHEA. Pool fee, network fee, minimum received — and **WinCut fee: $0.00**.
> Buying costs us nothing to allow, so we charge nothing for it."

Pick a trader in the copy selector.

> "I'll copy this account. They get 50% of any fee I eventually pay — and only if I exit in
> profit. If I lose, they earn nothing."

Sign it. While it settles:

> "The contract sends the USDC to Rhea, measures what comes back, and credits the position. A
> few blocks."

### 1:10 — **the moment** (35s)

Switch to the **losing** position you opened earlier (BRRR or LONK). Open the Sell tab, hit
`max`.

Stop talking and let the panel sit on screen for a beat. It reads:

```
Realised loss      −$3.12
WinCut fee          $0.00
You receive        $16.88
```

> "I'm down three dollars. The fee is **zero**. And look —"

Point at the line underneath:

> "— that $3.12 is **banked as credit**. Next time I win, the first $3.12 of profit is not
> charged at all."

Sign it. When the toast confirms, open the loss-credit badge in the header.

> "There it is, on chain. Global across every token, no expiry."

> "That is the whole product. Every other copy-trading app would have taken a cut of that losing
> trade. This one hands me a discount on my next win instead."

### 1:45 — close (15s)

Go to `/board`.

> "Traders ranked by realised profit — closed positions, not paper gains. Each one earns only
> from the followers who actually made money."

Switch to the NearBlocks tab, point at the `EVENT_JSON` logs.

> "Every balance, position and fee is a NEP-297 event. None of this is a database."

> "WinCut. The fee comes out of the win, or it does not come out at all."

---

## If something goes wrong

**"Another settlement is in flight."** Expected, and worth owning rather than hiding:

> "That is the global lock — one settlement at a time, because the contract measures token
> balances to attribute a swap. It clears in a few seconds. The fix is Rhea's non-instant swap,
> which returns the exact output; it is in the README under limitations."

Wait five seconds and press it again.

**The chart is empty.** The price, depth and your position are unaffected — they come from Rhea,
not GeckoTerminal. Say so and carry on:

> "GeckoTerminal has not indexed candles for this pool. Everything that matters is still live —
> the price in the header is from the pool reserves."

**A trade reverts on slippage.** Thin pools move. Raise slippage to 3% or halve the size. The
depth ladder already showed what that size would do, so point at it.

**Nothing loads at all.** Check the block height badge in the header. Grey means no RPC —
`NEXT_PUBLIC_RPC_URL` is wrong or rate limited, and the app walks its fallbacks automatically.

---

## Questions you will get

**"What stops me referring myself?"** The contract drops a referrer or copied trader equal to
the caller, and that share falls to the protocol. There is a test called
`copying_yourself_or_referring_yourself_is_ignored`.

**"Can the loss credit be farmed?"** Manufacturing a loss costs you the loss. You can only
shelter $100 of future profit by actually losing $100, plus Rhea's fee and gas on both legs.
There is no way to come out ahead.

**"Why trust the fee you show before I sign?"** The panel reads `quote_sell_fee`, a view that
runs the exact function the settlement callback runs. Same code, not a reimplementation.

**"Where does the money sit?"** In the contract: your USDC balance, and the tokens behind your
position. Withdraw is one signature and always available. Earnings are pull-based, so one
account that cannot receive USDC never blocks anybody else's settlement.

**"Is it audited?"** No. Sixty unit tests, every failure path covered, and it is hackathon code
on mainnet. Trade small — and that is in the README, not just in this answer.
