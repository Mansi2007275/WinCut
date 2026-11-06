# WinCut UI inventory

Taken from the code at commit `3246469`, before the redesign begins.

**This file is the contract for the redesign.** Every row below exists today and
must still exist, working against real chain data, when the redesign is done.
Nothing here may be dropped, stubbed, mocked, or replaced with a constant. The
Step 5 regression check walks this file line by line.

Line numbers are from the pre-redesign tree and will drift; the file column is
the durable part.

---

## a. Routes

| # | Route | File | Notes |
|---|---|---|---|
| R1 | `/` | `web/src/app/page.tsx` | Discover: head stats, coin list, activity feed, quick buy |
| R2 | `/coin/[address]` | `web/src/app/coin/[address]/page.tsx` | Chart, stats, trade panel, recent trades |
| R3 | `/launch` | `web/src/app/launch/page.tsx` | Launch form + success state |
| R4 | `/board` | `web/src/app/board/page.tsx` | Leaderboard, two tabs |
| R5 | `/trader/[address]` | `web/src/app/trader/[address]/page.tsx` | Trader profile, honesty, history |
| R6 | `/me` | `web/src/app/me/page.tsx` | Portfolio, claim, invite link |

Layout and shell: `app/layout.tsx`, `app/providers.tsx`, `components/Shell.tsx`
(`TopBar`, `Page`, bottom tab bar, footer).

There is **no** `/how-it-works` route and **no** onboarding screen today. Both
are new in Step 3, so they are additions, not replacements.

## b. Contract reads

| # | Call | Contract | Where |
|---|---|---|---|
| RD1 | `coinCount()` | Launcher | `lib/data.ts:31` |
| RD2 | `allCoins(uint256)` | Launcher | `lib/data.ts:40` |
| RD3 | `symbol()` | Coin ERC-20 | `lib/data.ts:49` |
| RD4 | `name()` | Coin ERC-20 | `lib/data.ts:50` |
| RD5 | `poolKeyFor(address)` | Launcher | `lib/data.ts:54` |
| RD6 | `poolIdFor(address)` | Launcher | `lib/data.ts:60` |
| RD7 | `launches(bytes32)` | Launcher | `lib/data.ts:67` |
| RD8 | `maxTradeSize()` | Hook | `lib/data.ts:101` |
| RD9 | `positionOf(address,bytes32)` | Hook | `lib/data.ts:116`, `app/me/page.tsx:283` |
| RD10 | `claimable(address)` | Hook | `lib/data.ts:136` |
| RD11 | `lossCredit(address)` | Hook | `lib/data.ts:142` |
| RD12 | `balanceOf(address)` | Coin ERC-20 | `lib/data.ts:158` |
| RD13 | `quoteSell(...)` | Quoter | `lib/quote.ts:41` |
| RD14 | `quoteBuy(...)` | Quoter | `lib/quote.ts:61` |
| RD15 | `allowance(address,address)` | Coin ERC-20 | `components/TradePanel.tsx:177` |
| RD16 | native balance via `useBalance` | — | `app/launch/page.tsx`, `app/me/page.tsx` |
| RD17 | `getBlockNumber()` chain head | — | `lib/data.ts:338` (`useHead`) |

Declared in `config/abis.ts` and reachable, but not currently called from a
screen: `quoteFee`, `followedOf`, `referrerOf`, `treasury`, `owner`, `paused`,
`trustedRouter`, `decimals`, `totalSupply`. `quoteFee` is the hook function the
Quoter calls inside `quoteSell`, so the fee shown in the UI is still derived
from it. Keep all of these in the ABI.

## c. Contract writes

| # | Call | Target | Where |
|---|---|---|---|
| WR1 | `launchCoin(string,string,string,uint256,uint256)` payable | Launcher | `app/launch/page.tsx:77` |
| WR2 | `execute(bytes,bytes[],uint256)` BUY | Universal Router | `components/TradePanel.tsx:214`, `lib/trade.ts:40` |
| WR3 | `execute(bytes,bytes[],uint256)` SELL | Universal Router | `components/TradePanel.tsx:214` |
| WR4 | `approve(address,uint256)` | Coin ERC-20 to Permit2 | `components/TradePanel.tsx:182` |
| WR5 | `approve(address,address,uint160,uint48)` | Permit2 to Router | `components/TradePanel.tsx:191` |
| WR6 | `claim()` | Hook | `app/me/page.tsx:67` |

## d. Events decoded

| # | Event | Source | Where |
|---|---|---|---|
| EV1 | `Bought(trader,id,coins,cost,followed,referrer)` | Hook | `lib/data.ts:189`, `lib/receipt.ts:125` |
| EV2 | `Sold(trader,id,coins,proceeds,pnl,fee)` | Hook | `lib/data.ts:192`, `lib/receipt.ts:91` |
| EV3 | `FeeSplit(...)` | Hook | `lib/receipt.ts:94` |
| EV4 | `LossCredited(trader,loss,newCredit)` | Hook | `lib/receipt.ts:95` |
| EV5 | `CreditConsumed(trader,used,remaining)` | Hook | `lib/receipt.ts:96` |
| EV6 | `Claimed(account,amount)` | Hook | `config/abis.ts:147` |
| EV7 | `CoinLaunched(...)` | Launcher | `lib/receipt.ts:142` |
| EV8 | `Swap(id,sender,amount0,amount1,sqrtPriceX96,liquidity,tick,fee)` | PoolManager | `lib/data.ts:350`, price series |
| EV9 | `Transfer(from,to,value)` | Coin ERC-20 | `lib/data.ts:407`, holder count |

## e. User features

| # | Feature | Where |
|---|---|---|
| F1 | Connect wallet | `NetworkGate.tsx:182` `ConnectCta` |
| F2 | Compact connect in the top bar | `Shell.tsx` `CompactConnect` |
| F3 | Pending-request message "Open MetaMask to approve the connection" | `NetworkGate.tsx:155` |
| F4 | `-32002` already-pending maps to that message, plus a Retry button | `NetworkGate.tsx` `isAlreadyPendingError` |
| F5 | Both connect buttons disable together via `useAccount().status` | `NetworkGate.tsx` |
| F6 | No-wallet message and Install MetaMask link | `NetworkGate.tsx:51` |
| F7 | Wrong-network banner, switch, `wallet_addEthereumChain` fallback | `NetworkGate.tsx:82` |
| F8 | Not-deployed banner | `NetworkGate.tsx:26` |
| F9 | Faucet link | `NetworkGate.tsx` `FaucetLink` |
| F10 | `?ref=` referral, persisted in localStorage | `lib/referral.ts:22` |
| F11 | `?follow=` copy-trade, deliberately not persisted | `lib/referral.ts:25` |
| F12 | Invite link and copy button | `app/me/page.tsx:91`, `lib/referral.ts:53` |
| F13 | Copy-trader link | `app/trader/[address]/page.tsx:90`, `lib/referral.ts:59` |
| F14 | Quick buy chips 10/50/100 on Discover | `app/page.tsx:257` |
| F15 | Buy amount chips | `components/TradePanel.tsx` |
| F16 | Sell percent chips 25/50/100 | `components/TradePanel.tsx` |
| F17 | Fee preview from the contract: gross, profit, loss credit, fee, 0.5 percent comparison, you receive | `components/TradePanel.tsx` |
| F18 | `minOut` derived from netOut, never gross | `components/TradePanel.tsx:171`, `applySlippage` |
| F19 | Trade-limit message from `maxTradeSize()`, plus `TradeTooLarge` mapping | `components/TradePanel.tsx:146,405,436` |
| F20 | Two-step approve, ERC-20 then Permit2, before a sell | `components/TradePanel.tsx:177-201` |
| F21 | Result screen decoded from receipt events | `components/Result.tsx`, `lib/receipt.ts` |
| F22 | Split bar 50/20/30 with the real recipients | `components/Result.tsx:129` |
| F23 | Loss-credit result, "WinCut took $0" | `components/Result.tsx` |
| F24 | Unattributed-swap result | `components/Result.tsx:19` |
| F25 | Launch success with explorer link | `app/launch/page.tsx:114` |
| F26 | Launch checklist, so an untouched form is not all red errors | `app/launch/page.tsx` `checks` |
| F27 | Claim | `app/me/page.tsx:67` |
| F28 | Explorer links for tx, address and block | `lib/chain.ts:57-59`, `ui.tsx` |
| F29 | Toasts: pending, confirmed, failed, with a tx link | `components/Toast.tsx` |
| F30 | Skeleton loaders | `ui.tsx` `Skeleton`, `SkeletonRows` |
| F31 | Honest empty states | `ui.tsx` `Empty` |
| F32 | Error boxes | `ui.tsx` `ErrorBox` |
| F33 | Loading state instead of a false "$0.00 / no trades yet" | `app/page.tsx`, `trades.isPending` |
| F34 | Leaderboard tabs: own profit and followers' profit | `app/board/page.tsx` |
| F35 | HONEST and DUMPER tags, honesty score | `ui.tsx` `Badge`, `DumperStamp`, `HonestyBar` |
| F36 | Trader profile: own vs followers' PnL, win rate, fees paid, history | `app/trader/[address]/page.tsx` |
| F37 | Me: realised P&L, fees paid, saved by WinCut, loss credit, claimable, positions | `app/me/page.tsx` |
| F38 | Price chart from PoolManager Swap events | `components/PriceChart.tsx`, `lib/data.ts:364` |
| F39 | Holder count from Transfer events | `lib/data.ts:419` |
| F40 | Bottom tab bar: Discover, Launch, Board, Me | `components/Shell.tsx` |

## f. Helpers that must survive

| # | Helper | Why it must not be touched |
|---|---|---|
| H1 | `lib/logs.ts` `getLogsChunked` and `getWindowWithRetry` | 5,000-block chunking plus retry and backoff. Arc's RPC rejects wider ranges (-32012) and rate-limits (-32005). The bare catch-and-continue it replaced silently lost money data. |
| H2 | `lib/quote.ts` `quoteSell`, `quoteBuy` | The fee shown must come from the contract, never from JS. |
| H3 | `lib/swap.ts` `buildSwap`, `encodeAttribution` | The V4_SWAP encoder, mirroring `UniversalRouterLib.sol`. |
| H4 | `lib/receipt.ts` | Result numbers decoded from events, not recomputed. |
| H5 | `lib/format.ts` `price()` | Subscript-zero tiny prices, no scientific notation. |
| H6 | `lib/format.ts` `applySlippage` | minOut from netOut. |
| H7 | `lib/chain.ts` `arcTransport` | Batching and retry that keep the app under Arc's rate limit. |
| H8 | `lib/data.ts` poll intervals, 30s/30s/60s with staleTime | Tuned to stay under the rate limit. |
| H9 | `lib/referral.ts` | `isAddress` validation before anything reaches hookData. |

## Rules that outrank any visual change

1. Real data only. No mocks, no seeded rows, no invented names or handles.
2. No client-side fee or split math. The fee comes from `quoteFee` through the
   Quoter; the split comes from the `FeeSplit` event.
3. `minOut` is derived from netOut. Deriving it from gross makes every
   profitable sell revert.
4. No contract, hook or ABI changes. The hook permission bits stay `0x2044`.
