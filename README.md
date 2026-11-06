# WinCut

**A Uniswap v4 hook that charges a success fee only on realised profit.**

> Every trading app gets paid when you lose. We don't.

Built for ETHGlobal Mumbai 2026 · targeting **Uniswap Foundation**, **Arc (Circle)** and **World** partner prizes.

---

## What it does

WinCut is a memecoin launchpad and social trading app on [Arc](https://docs.arc.io), Circle's L1 where USDC is the native gas token. The app, the trader you copied, and your referrer all earn **only when you make a profit**.

A profitable exit pays 10% of the gain, split **50% to the copied trader / 20% to the referrer / 30% to the protocol**. A losing exit pays **nothing** and banks a loss credit that offsets your next gain.

| | Sells for $150 | Sells for $60 |
|---|---|---|
| Result | $50 profit | $40 loss |
| WinCut's cut | **$5** | **$0** |
| Copied trader | $2.50 | $0 |
| Referrer | $1.00 | $0 |
| You keep | $145 | $60 |
| Plus | — | **$40 loss credit — your next $40 of profit is free** |

Pool fees and gas still apply on every trade: those go to Uniswap LPs and to the network, not to WinCut.

---

## Architecture

```
                    ┌──────────────────────┐
   trader ─────────▶│  Universal Router    │  exactInput swap + hookData
                    └──────────┬───────────┘    (followedTrader, referrer)
                               │
                               ▼
                    ┌──────────────────────┐
                    │   v4 PoolManager     │
                    └──────────┬───────────┘
                               │ afterSwap
                               ▼
         ┌─────────────────────────────────────────────┐
         │              WinCutHook                     │
         │                                             │
         │  resolve trader  ─ IMsgSender.msgSender()   │
         │  buy   ─ record (amount, cost) per pool     │
         │  sell  ─ proceeds vs proportional basis     │
         │          loss   → bank credit, fee = 0      │
         │          profit → consume credit, fee = 10% │
         │  take() the fee, split it, pull-based claim │
         └─────────────────────────────────────────────┘
                               ▲
                               │ beforeInitialize (launcher only)
                    ┌──────────┴───────────┐
                    │   WinCutLauncher     │  deploys coin, opens pool,
                    └──────────────────────┘  locks seed liquidity forever
```

### Contracts

| Contract | Role |
|---|---|
| [`WinCutHook.sol`](contracts/src/WinCutHook.sol) | Cost-basis ledger, profit-only fee, loss credits, fee split, pull-based claims |
| [`WinCutLauncher.sol`](contracts/src/WinCutLauncher.sol) | One-tx coin launch: deploy ERC-20, open the v4 pool, seed **permanently locked** liquidity |
| [`WinCutCoin.sol`](contracts/src/WinCutCoin.sol) | Fixed supply, no mint, no owner, no transfer tax, nothing that can rug |

---

## The design decisions that matter

Each of these is a deliberate choice with a reason, not an accident.

### 1. Unidentified routers pay **zero**, not 10% of everything

[`WinCutHook.sol` — `_resolveTrader`](contracts/src/WinCutHook.sol#L205)

The naive design taxes any sell it cannot attribute. That would deter arbitrage, let the pool price drift above other venues (so *our own users* buy high), and get every launched coin flagged as a sell-tax token by sniffers and aggregators.

So an unknown router is charged nothing and recorded nothing. **The fee is opt-in.** You can always sell elsewhere, free. You pay us only when you use the app, and only when you win. That is a feature, not a leak.

### 2. Untracked coins are fee-free

[`WinCutHook.sol` — `_handleSell`](contracts/src/WinCutHook.sol#L254)

The hook sees swaps, never ERC-20 transfers, and **never reads `balanceOf`**. Coins that arrive by airdrop or transfer carry no recorded basis and are never taxed.

Treating them as 100% profit would mean **anyone could inflate your tax bill by dusting you** — and memecoin wallets get dusted constantly. Test: `test_Airdrop_CannotInflateFeeOnRealPosition`.

### 3. Loss credits are global, with no expiry

[`WinCutHook.sol` — `_applyCredit`](contracts/src/WinCutHook.sol#L299)

Per-coin credits would still tax a DUKE win while a PEPE loss sat unused. Global credits make the headline claim true at the portfolio level.

Farming credits is strictly unprofitable: banking $X of credit requires genuinely losing $X, which saves only $0.1X in future fees.

### 4. `quoteFee()` is the single source of truth

[`WinCutHook.sol` — `quoteFee`](contracts/src/WinCutHook.sol#L348)

The hook takes its fee from the swap **output**, and Universal Router checks `amountOutMinimum` on the post-hook amount. A frontend that derives `minOut` from the gross quote will make **every profitable sell revert**.

So the fee formula lives in the contract and the frontend calls it:

```
grossOut = V4Quoter.quoteExactInputSingle(...)
(fee, netOut) = hook.quoteFee(trader, poolId, sellAmount, grossOut)
minOut = netOut * (10000 - slippageBps) / 10000
```

**Never reimplement this formula in TypeScript.** Two copies drift, and the drift surfaces as a revert on stage.

### 5. Permissions are frozen at `0x2044`

`beforeInitialize | afterSwap | afterSwapReturnDelta`

`PoolKey` contains the hook address, so adding a flag later changes the address, which changes every PoolKey, which invalidates every pool ever created. The bitmap is fixed and asserted in `test_HookAddress_CarriesFrozenPermissionBits`.

`beforeSwap` is deliberately **not** used: `afterSwap` sees both directions, so buys are recorded there too.

### 6. Claims are pull-based

[`WinCutHook.sol` — `claim`](contracts/src/WinCutHook.sol#L334)

USDC can blocklist addresses. If fees were pushed on every sell, one blocklisted recipient would make **other people's** trades revert. Earnings accrue and are pulled, CEI-ordered.

### 7. One pinned QUOTE currency

On Arc, USDC is the **native** asset (18 decimals) *and* an ERC-20 interface at `0x3600…0000` (6 decimals). Same money, `1e12` apart. Mixing them silently corrupts every cost basis.

`beforeInitialize` rejects any pool that does not contain the pinned QUOTE, and only the launcher may open pools — so nobody can point a fake-token pool at a hook that custodies funds.

---

## Tests

```bash
cd contracts && forge test
```

**19 passing, including 512 fuzz runs**, against a real `PoolManager` with a mined hook address and a router that implements `IMsgSender` exactly as Universal Router does.

```
WinCutMoneyRules
  ✓ test_Profit_ChargesTenPercent_AndSplits          10% of gain, split 50/20/30
  ✓ test_Loss_ChargesNothing_AndBanksCredit          fee 0, loss banked exactly
  ✓ test_LossCredit_OffsetsFutureGain                credit consumed before any fee
  ✓ test_MultipleBuys_WeightedAverageBasis           proportional basis on partial exits
  ✓ test_UnknownRouter_NoFeeNoRecord                 untrusted router charged nothing
  ✓ test_AirdroppedCoins_AreFeeFree                  untracked coins never taxed
  ✓ test_Airdrop_CannotInflateFeeOnRealPosition       dusting cannot raise a fee

WinCutMechanics
  ✓ test_SelfReferral_AndSelfFollow_Ignored          hookData self-dealing guarded
  ✓ test_Referrer_LockedOnFirstBuy                   referrer cannot be reassigned
  ✓ test_NoCopiedTrader_ShareGoesToCreator           unclaimed share → coin creator
  ✓ test_Claim_PaysOut_AndCannotDoubleClaim          pull payout, no double spend
  ✓ test_Pause_BlocksSwaps                           emergency stop
  ✓ test_MaxTradeSize_Enforced                       per-trade cap
  ✓ test_OnlyLauncher_CanInitializePools             no rogue pools on this hook
  ✓ test_OnlyLauncher_CanRegisterCoins               access control
  ✓ test_HookAddress_CarriesFrozenPermissionBits     bitmap is 0x2044
  ✓ test_SeedLiquidity_IsLocked                      launcher has no removal path

WinCutFuzz
  ✓ testFuzz_FeeNeverExceedsTenPercentOfGain   (256 runs)  principal never touched
  ✓ testFuzz_NeverChargesOnALoss               (256 runs)  sale ≤ basis is always free
```

The delta sign convention is verified against `v4-core`'s `Hooks.afterSwap`, which applies `swapDelta = swapDelta - hookDelta` — so a positive returned `int128` takes from the user's output, and `take()` inside `afterSwap` nets the hook's own delta to zero within the same unlock.

---

## Running it

### Phase 0 — verify the environment before building anything

```bash
cd contracts
UNIVERSAL_ROUTER=0x... forge script script/Phase0.s.sol --fork-url $ARC_RPC -vv
```

Answers the two questions the architecture rests on:
1. Does the deployed Universal Router expose `msgSender()`? If not, attribution needs a different design.
2. Is the PoolManager where you think, and is USDC native or ERC-20? This decides `QUOTE` and your decimals.

**Expected output on success:** `>>> OK: v4 PoolManager is live on this chain.` and `>>> OK: the function EXISTS and is publicly callable.`

### Deploy

```bash
anvil --fork-url $ARC_RPC          # develop against a mainnet fork, not testnet
forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast
```

### Seed real trading history

```bash
HOOK=0x... LAUNCHER=0x... ROUTER=0x... \
  forge script script/SeedTrades.s.sol --rpc-url http://localhost:8545 --broadcast
```

Produces genuine on-chain trades across three coins, including one deliberate **dumper** whose own PnL is positive while his followers lose — the row that turns red on the second leaderboard.

This exists because "no seeded data" plus a fresh deployment means an empty leaderboard, which is the one thing that makes a working demo look broken. Every row here is a real swap through the hook.

---

## Known limitations

Stated plainly, because they are real.

- **The fee is avoidable.** Anyone can create a hookless pool for the same coin, or route around the trusted router, and pay nothing. This is by design (see decision 1), but it means revenue depends on people choosing to stay in the app. What WinCut sells is the signal and the honest leaderboard, not a tax.
- **Win-then-lose is asymmetric.** Loss credits fix `−$1000 then +$1000` (fee $0) but not `+$1000 then −$1000` (fee $100 on net-zero PnL). A high-water mark is mathematically identical and does not help. The real fix is escrowing fees for N days so a later loss refunds from pending — see roadmap.
- **Adverse selection.** A 10% profit fee is free for losing traders and expensive for winning ones, so the model systematically sheds the cohort that generates its revenue.
- **World ID is verified off-chain**, so the leaderboard's Sybil resistance rests on our verifier. Money is unaffected: attribution gaming is self-defeating, since a sock puppet crediting its owner returns 25% of a fee the puppet itself had to pay.
- **Native-QUOTE paths are coded but the suite exercises the ERC-20 path.** Pin `QUOTE` from Phase 0 before deploying.

## Roadmap

1. **Escrow window** — fees pending for N days, refunded from pending on a later loss, which closes the win-then-lose gap. Constructor parameter so it can be 60s for a demo and 7 days in production.
2. **Wrapper contract** — apply the same rule to existing Arc pools, inside the app only, bypassable by design.
3. **Charge for the signal, not the swap** — restrict the success fee to copy-trades, where it is payment for a service rather than a toll on a swap. Winners then cannot route around it without giving up what they are paying for.

---

## Status

| Component | State |
|---|---|
| `WinCutHook` | ✅ complete, 19 tests passing |
| `WinCutLauncher` + `WinCutCoin` | ✅ complete, liquidity locked |
| Phase 0 / Deploy / Seed scripts | ✅ complete |
| Indexer (Envio) | ⬜ not started |
| Frontend (Next.js) | ⬜ not started |
| World ID | ⬜ not started |

Licence: MIT.
