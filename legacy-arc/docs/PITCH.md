# WinCut — pitch and demo script

## The 30-second pitch

> Every trading app charges you per trade, so they earn the same whether you win
> or lose. The trader you copied earns from your volume even when they dumped on
> you.
>
> WinCut is a Uniswap v4 hook that charges **10% of your profit, and nothing
> otherwise**. Lose money and the fee is zero, and you bank a credit against
> your next win. The trader you copied and your referrer are paid out of that
> same profit, so **nobody earns unless you made money**.
>
> It runs on Arc, where USDC is the native gas token, so profit is already
> denominated in dollars and we need no price oracle.
>
> And because the fee comes out of realised profit, we can rank traders by
> *their followers'* profit, not their own. The dumper with +$50,000 and
> −$30,000 of follower losses earns nothing from them, and the leaderboard says
> so.

**One line:** every trading app gets paid when you lose; we don't.

---

## The 3-minute demo script

Pre-flight is in [DEMO_CHECKLIST.md](DEMO_CHECKLIST.md). Run it before you
start.

### 0:00 — The claim (20s)

> "Every trading app gets paid when you lose. We don't. Let me show you three
> transactions on Arc, all real, all on-chain."

Have the Trade screen open with DUKE selected.

### 0:20 — The loser (40s)

Hand the device over, or drive it yourself.

1. Sell a position that is underwater.
2. Point at the **fee preview box** *before* confirming:
   - Your profit: negative
   - **WinCut fee: $0.00**
   - "A 0.5%-of-volume app would charge: $X"
3. Confirm. The Result screen shows a large **"WinCut took $0"** and
   **"+$X loss credit"**.

> "She lost money. We charged nothing. And she now has a credit — her next $X of
> profit is free. That number came from the contract, not from our frontend."

### 1:00 — The winner (50s)

1. Switch wallets to one holding a profitable position.
2. Show the fee preview: profit, 10% fee, and the comparison line.
3. Confirm. The Result screen counts up the profit, then animates the split into
   three rows: copied trader 50%, referrer 20%, WinCut 30%.
4. Tap through to **Me** on the copied trader's wallet and show **claimable**
   went up, read straight from the hook.

> "10% of the profit, split three ways. The trader she copied just earned,
> because she won. If she had lost, he'd have earned nothing."

### 1:50 — The dumper (50s)

Open **Board** and switch to the **Followers' profit** tab.

> "This is the board that matters. On a normal leaderboard this trader ranks
> first — look at his own profit. But his followers are down. He made his money
> *from* them."

Point at the red **DUMPER** stamp and the honesty score bar.

> "Under WinCut he earned nothing from the followers who lost. The incentive and
> the scoreboard point the same way for the first time."

### 2:40 — Close (20s)

> "One v4 hook, 31 tests, deployed against the real Uniswap v4 on Arc with
> native USDC. The fee lives in the hook's cost-basis ledger — it never trusts
> the frontend.
>
> And you can always sell somewhere else for free. We don't trap you. You pay us
> only when you use the app, and only when you win."

---

## Judge questions, with honest answers

### "What stops me selling in a different pool and paying nothing?"

**Nothing, and that is deliberate.** A `PoolKey` includes the hook address, so
anyone can create a hookless pool for the same coin, and v2 and v3 are live on
Arc too.

We considered taxing unattributed sells and rejected it: that would deter
arbitrage, let our pool's price drift above other venues (so *our own users* buy
high), and get every launched coin flagged as a sell-tax token by sniffers and
aggregators. Our hook charges **zero** when it cannot identify the trader.

So the fee is opt-in. What we sell is the signal and the honest leaderboard, not
a toll. If you want to route around it, the trade you give up is the one you
came for.

### "Most memecoin traders lose money. How do you make anything?"

Better than it sounds, for a reason that is easy to miss: we charge on **each
profitable exit against its own basis**, not on net portfolio PnL. Gross winning
exits are a large share of volume even when aggregate PnL is deeply negative,
and memecoin gains are fat-tailed.

Our seeded run on a mainnet fork produced ~$4,460 of fees across three coins and
a few dozen trades, where a 0.5%-of-volume app would have taken a comparable
amount. We do not claim that generalises — it is a fork with synthetic
scenarios. The honest answer is that the replay against real Arc swap history is
the experiment that settles it, and we have not run it yet.

### "I win $1,000 then lose $1,000. Net zero. Did I pay?"

**Yes, $100, and that is the real weakness of the design.** Loss credits fix
lose-then-win, not win-then-lose. A high-water mark is mathematically identical
and does not help either.

The actual fix is escrow: hold fees pending for N days so a later loss refunds
out of pending before it banks credit. It is on the roadmap with a
constructor-settable window, deliberately short for a demo and 7 days in
production. We did not ship it because it would delay the three-way split that
the demo shows landing instantly, and we would rather state the gap than hide
it.

### "Can someone airdrop me coins to inflate my tax bill?"

No, and this was a deliberate design decision. The hook never reads
`balanceOf` — it tracks only coins bought through WinCut. Coins that arrive by
transfer or airdrop carry no recorded basis and are **never charged**.

Treating them as 100% profit would have let anyone inflate a rival's fee for the
price of a dust transfer, and memecoin wallets get dusted constantly. Test:
`test_Airdrop_CannotInflateFeeOnRealPosition`.

### "Can I dodge by moving to a fresh wallet?"

It makes things worse, not better. A fresh wallet has no recorded position, so
the hook charges nothing — but it also records nothing, so you gain no credit and
no attribution. There is no arbitrage in moving.

### "Does this stop a KOL buying early and dumping?"

No, and we do not claim it does. It removes their **follower revenue** and
exposes the pattern on the leaderboard. Their own side-wallet profits are
untouched. We think making the dumping visible and unpaid is worth doing even
though it is not prevention.

### "How does the hook know who I am? The router calls it, not me."

`IMsgSender`. The hook reads the `sender` argument, checks it against routers it
trusts, then calls `msgSender()` on it. This is the officially documented
Uniswap pattern, and we verified the selector `0xd737d0c7` is present in Arc's
deployed Universal Router bytecode and that a live call returns without
reverting. Proven end to end in `test_Fork_RealRouter_AttributesTheTrader`.

### "Why Arc?"

Three reasons that are specific, not marketing. USDC is the **native** currency,
so profit is already in dollars and we need no oracle. The quote currency is
`address(0)`, so our "is this really USDC" check is `isAddressZero()`, which
cannot be spoofed. And Arc's day-one volume was 82% memecoin launchpads, so the
users exist.

### "Is the leaderboard gameable with sock puppets?"

The money is not. A puppet crediting its owner as the copied trader returns 25%
of a fee the puppet itself had to pay — recycling your own money at a 75% loss.
The *display* is gameable, which is what World ID gating is for, and it is
verified off-chain by our server. We would rather say that plainly than imply
on-chain Sybil resistance we do not have.

### "What is actually left to build?"

A real indexer (the leaderboard currently reads events via `getLogs`), World ID,
the escrow window, and a wrapper so existing Arc pools can opt in. The hook,
launcher, quoter and the four screens are done and tested.
