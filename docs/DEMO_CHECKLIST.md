# Demo checklist

Exact steps from a fresh terminal. Do a full dry run **before** you present, and
read the fallback plan at the bottom first so you know what you would do.

Budget: ~6 minutes for setup, 3 minutes for the demo.

---

## T-20 min — full setup from cold

### 1. Bring up the stack (one command, ~90s)

```bash
cd /c/Users/yadav/Famdroid
KEEP_ALIVE=1 ./scripts/dev.sh
```

This forks Arc mainnet, deploys the hook at a mined address, funds clean
wallets, seeds real trades, and writes `web/src/config/deployed.json`.

**What you must see before continuing:**

```
[dev]      chain id: 5042
[dev]      PoolManager OK (24009 bytes)
[dev]      permission bits    : 8260          <- 0x2044, the frozen bitmap
[dev]      funded 14 clean wallets
  launched DUKE  0x...
  launched TOLLY 0x...
  launched COOL  0x...
  coins launched : 3
  --- claimable (native USDC wei) ---
  honest   : 2232317955850376206463
  dumper   : 0                                <- THE THESIS. Must be 0.
  referrer : 892927182340150482583
  treasury : 1339390773510225723885
  --- loss credits banked ---
    trader 10 credit: ...
[dev] ready. RPC http://127.0.0.1:8545  (chain 5042)
```

If `dumper` is not `0`, or `coins launched` is not `3`, **stop and re-run**. The
dumper row is the entire point of the second leaderboard.

Leave this terminal running. `KEEP_ALIVE=1` keeps anvil up.

### 2. Start the frontend (second terminal)

```bash
cd /c/Users/yadav/Famdroid/web
npm run dev
```

Note the port it prints — it will pick another if 3000 is taken.

### 3. Verify the whole path end to end (third terminal, ~30s)

```bash
cd /c/Users/yadav/Famdroid/web
npx tsx scripts/verify-flow.ts
```

Must end with `=== ALL CHECKS PASSED ===`. This runs the real UI encoder
against the real Universal Router, so if it passes, the demo path works. If it
fails, **the UI will fail too** — fix before presenting.

### 4. Wallet setup

Add the network to MetaMask (or whatever you present with):

| | |
|---|---|
| Network name | Arc local fork |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `5042` |
| Currency symbol | `USDC` |
| Decimals | 18 |

Import the deployer key printed by `dev.sh`:

```
0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

> This is anvil's public test key. Never use it on a real network. On Arc
> mainnet it carries an EIP-7702 sweeper delegation, so anything sent to it is
> stolen instantly.

**Important:** this account can *send* fine, but do not rely on its *balance*
for the demo — the inherited delegation forwards native USDC it receives. For
balance-visible steps, use a wallet the seed script funded (they are
undelegated by construction).

### 5. Pre-stage the three positions

You need three wallets in three states. Do this now, not on stage.

```bash
# A wallet holding an underwater position  -> the LOSER beat
# A wallet holding a profitable position   -> the WINNER beat
# The dumper already exists from seeding   -> the BOARD beat
```

Easiest route: open the app, connect the deployer, buy ~$50 of DUKE, then have
another wallet sell hard into the pool so your position goes red. Then buy ~$50
of TOLLY and have someone buy a lot after you so it goes green.

Confirm in the UI that the fee preview box shows **$0.00** for the red one and a
**non-zero fee** for the green one, before you present.

### 6. Browser prep

- Open three tabs: Trade, Board, Me.
- Zoom to ~125% so judges can read the numbers.
- Phone-width window if you can — the UI is mobile-first and looks best narrow.
- Close every other tab. Disable notifications.

---

## T-0 — the 3-minute run

Full wording is in [PITCH.md](PITCH.md). The beats:

| Time | Beat | Screen | The thing to point at |
|---|---|---|---|
| 0:00 | The claim | Trade | — |
| 0:20 | The loser | Trade → Result | fee preview **$0.00**, then **"WinCut took $0"** + loss credit |
| 1:00 | The winner | Trade → Result | 10% fee, then the split animating to 3 recipients |
| 1:50 | The dumper | Board → Followers' profit | red **DUMPER** stamp, honesty bar |
| 2:40 | Close | — | "sell elsewhere free, we don't trap you" |

**Say the fee number out loud before you confirm each trade.** The preview box is
the proof that it is computed before the trade, from the contract.

---

## Fallback plan

Decide these now, not under pressure.

### If anvil dies or the fork RPC is unreachable

Arc's public RPC can rate-limit. The fork needs it on startup.

- **Fallback:** keep a terminal with a *working* `dev.sh` session running from
  the start of the event and never kill it. That is why `KEEP_ALIVE=1` exists.
- If it is already dead: `./scripts/dev.sh` again takes ~90s. If the RPC itself
  is down, go to the recorded video.

### If a transaction reverts on stage

Most likely cause is slippage on a fast-moving pool.

- Say the line out loud: *"that is the slippage check doing its job — the fee
  comes out of the output, so our minOut is derived from the net figure."* It
  turns a failure into a point about the design.
- Then retry with a smaller amount.

### If the wallet will not connect

- **Fallback:** the Board screen needs no wallet at all. It reads events
  directly. Lead with the dumper beat instead and narrate the other two from the
  recorded video.

### If the frontend breaks entirely

- **Fallback:** run the test suite live. It is genuinely convincing:

```bash
cd contracts
ARC_RPC=https://rpc.mainnet.arc.io forge test --match-contract WinCutRouter -vv
```

It prints real numbers from real Arc contracts: the attributed position, the
10% fee, the split, and the slippage comparison. Judges who read code find this
more persuasive than a UI anyway.

### Always have ready

- **The recorded video**, under 3 minutes, made from a working run. Record it
  the moment you have a clean full dry run — do not leave it until the end.
- A screenshot of the `dev.sh` output showing `dumper : 0`.
- The repo open at [`WinCutHook.sol`](../contracts/src/WinCutHook.sol) with
  `_handleSell` on screen.

---

## Teardown

```bash
# in the dev.sh terminal
Ctrl-C
# or if KEEP_ALIVE left it running
taskkill //F //IM anvil.exe
```

Nothing touches a real network, and no real funds are ever at risk — everything
runs against a local fork.
