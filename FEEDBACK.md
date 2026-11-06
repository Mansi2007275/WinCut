# Uniswap v4 developer feedback — from building WinCut

Built at ETHGlobal Mumbai 2026. WinCut is a v4 hook that charges a success fee
only on realised profit. This is honest feedback from going from zero to a
working hook on a chain whose v4 deployment we had never touched.

Everything below is something we actually hit, with the time it cost.

---

## What worked well

**The singleton plus flash accounting is genuinely pleasant.** Taking a fee from
swap output turned out to be three lines: `poolManager.take()` inside
`afterSwap`, then return the delta. The fact that `take()` debits the hook's
delta and the returned `+fee` credits it back to zero in the same unlock is
elegant once you see it. We did not have to think about settlement ordering.

**`IMsgSender` existing at all saved the project.** Our whole design depends on
the hook knowing who the real trader is. Finding
`v4-periphery/src/interfaces/IMsgSender.sol` plus the "Access msg.sender Inside
a Hook" guide meant we did not have to write our own router. This is the single
most important thing v4-periphery gave us.

**`HookMiner` and the address-bit permission scheme.** Weird on first contact,
obvious after ten minutes, and `HookMiner.find` just works.

**OpenZeppelin's `uniswap-hooks` `BaseHook`.** The `_beforeInitialize` /
`_afterSwap` internal-override pattern is cleaner than overriding the external
functions directly. Good library.

---

## Friction, in the order it cost us time

### 1. `afterSwapReturnDelta` sign convention is undocumented where it matters

**Cost: ~40 minutes of reading v4-core source.**

The docs say `afterSwap` can return a delta. They do not clearly state **which
direction a positive number means**, or that the delta applies to the
*unspecified* currency, or what that resolves to for exact-input versus
exact-output.

We only became confident after reading `Hooks.afterSwap` and finding:

```solidity
// the caller has to pay for (or receive) the hook's delta
swapDelta = swapDelta - hookDelta;
```

That one line is the whole answer. **Please put it in the custom-accounting
docs.** Suggested wording: "A positive `hookDeltaUnspecified` takes from the
swapper; for `exactInput` the unspecified currency is the output."

Related: the fact that exact-input makes the *output* the unspecified currency
is what forces fee-on-output hooks to be exact-input only. We worked that out
ourselves and it is a real design constraint worth stating outright.

### 2. The `quoteFee` / `amountOutMinimum` trap deserves a documentation warning

**Cost: would have been a failed live demo.**

If a hook takes from the swap output, Universal Router validates
`amountOutMinimum` against the **post-hook** amount. Any frontend that derives
`minOut` from the quoter's gross figure therefore reverts on exactly the trades
the hook is designed for — the profitable ones.

Our measured numbers on Arc:

```
gross out                      $38,485.13
hook fee                        $3,648.51
minOut from net   (correct)    $34,662.43  -> succeeds
minOut from gross (naive)      $38,292.71  -> exceeds achievable net, reverts
```

Nothing in the docs warns about this, and it is a silent trap for every
fee-taking hook. We solved it by exposing a `quoteFee()` view on the hook as the
single source of truth and never recomputing the fee off-chain.

**Request:** a "Quoting a pool with a fee-taking hook" section, and ideally a
flag or helper on V4Quoter that returns the post-hook amount.

### 3. V4Quoter cannot quote pools on a chain whose PoolManager predates it

**Cost: ~1 hour, and we ended up writing our own quoter.**

`V4Quoter` establishes whether a pool exists by reading PoolManager storage via
`extsload`/`StateLibrary`. Compiled against `v4-core` HEAD and pointed at Arc
mainnet (PoolManager deployed September 2026), it returned
`PoolNotInitialized()` for pools that **demonstrably trade** — we had just
swapped on them through the real Universal Router in the same session.

This is a storage-layout coupling between the lens and the deployed core. It
makes V4Quoter version-fragile in exactly the situation where a builder is least
equipped to debug it: a new chain, unfamiliar deployment, everything else
working.

Our workaround was a quoter that reads **no** storage: simulate the swap inside
an unlock, revert with the `BalanceDelta`, decode it. Same revert-to-return trick
V4Quoter already uses, minus the precondition check. ~100 lines, immune to layout
drift.

**Request:** either drop the storage-read precondition from V4Quoter and let the
swap revert naturally, or publish a compatibility matrix of
`v4-periphery` version against `v4-core` deployment. The failure mode right now
is a confusing error that points at the wrong thing.

### 4. `ExactInputSingleParams` changed shape without an obvious changelog

**Cost: ~20 minutes of uncertainty.**

The struct in current `v4-periphery` has a `minHopPriceX36` field. We had no way
to know whether the router deployed on Arc two months earlier expected it, and a
mis-encoded struct fails as an opaque revert. We resolved it empirically by
doing a real swap in a fork test.

**Request:** version the periphery action encodings, or document which router
releases accept which params layout. A builder encoding Universal Router calls
by hand cannot tell from the outside.

### 5. `PoolNotInitialized()` is thrown without saying which pool

A bare selector, no `PoolId`. On a chain with thousands of pools and a PoolKey
you constructed yourself, "not initialized" plus no argument means you cannot
tell whether your key is wrong or the pool is genuinely missing. We spent real
time probing storage slots to find out. Including the `PoolId` would have made
this instant.

### 6. Stack-too-deep in ordinary hook code

Both our hook and our launcher hit `Stack too deep` with what feels like modest
code — an `afterSwap` with a dozen locals, and an event with nine arguments. The
suggested fix (`--via-ir`) multiplies compile time, which is painful in a
hackathon loop. We refactored into small helper functions instead. Worth a note
in a hooks best-practices page: expect to split `afterSwap` up.

---

## Things that are not Uniswap's fault but cost us anyway

Recording these because they will bite other v4 builders on new chains.

**Deploying a hook through the CREATE2 factory makes the factory your owner.**
`Ownable(msg.sender)` in a hook constructor looks right and is wrong, because
hook address mining forces CREATE2, so `msg.sender` is the deployer factory. Our
local tests could not catch it — they use `new Hook{salt:}` from the test
contract, where `msg.sender` is the test. Only the real factory path failed, with
`OwnableUnauthorizedAccount`. **A line in the hook-deployment guide saying "pass
the owner explicitly" would save people this.**

**EIP-7702 sweepers on well-known test keys.** On Arc mainnet, every anvil
default account carries a delegation (`0xef0100…`) to a contract that instantly
forwards any native value received. Forking mainnet inherits it, so demo wallets
using anvil's accounts silently lose their sell proceeds. We lost a debugging
cycle to a test reporting the trader receiving `-$0.0002` while the fee split
landed perfectly; `cast run` showed `take(native, trader, 22763.57)` working
exactly right, followed by the trader's own fallback forwarding it away. Not a
v4 issue, but "fork a mainnet, use anvil accounts" is the default workflow the
docs recommend, so it is worth a warning.

---

## Top improvement, if we could pick one

**Document the fee-taking hook lifecycle end to end, in one page.**

Fee-taking is probably the most common non-trivial hook people want to build,
and it currently requires assembling knowledge from: `Hooks.afterSwap` source
for the sign convention, the custom-accounting guide for the permission flags,
the `IMsgSender` guide for attribution, and nothing at all for the
quoting/`minOut` interaction.

One page covering: which permissions, which direction the delta goes, why
exact-input only, how to settle with `take`/`mint`, how to quote the post-hook
amount, and how to identify the trader. That page would have saved us the better
part of a day, and it is the day that decides whether a hackathon hook ships.

---

## Our numbers, for context

31 tests passing, including fork tests against the real Arc deployment:
PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, Universal Router
`0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1`, native USDC as the quote currency.

Repo: https://github.com/Mansi2007275/WinCut
