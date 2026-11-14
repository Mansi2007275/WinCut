# The three-minute video

A silent screen recording. No voice-over, no slides, no still images — every number on screen
is read live from NEAR testnet while the recording runs, and one real buy and one real sell are
signed on camera. Captions carry the words.

Numbers in the captions below were read from chain on 2026-11-14. **Re-read them before you
record** (`node scripts/audit.mjs`, or the `get_recent_trades` call in the README's audit
table) and correct the caption file if they have moved — the bots keep trading, so they will.

---

## Setup before you hit record

- [ ] Close every other Chrome and Edge window. The recording needs the memory, and a 3D
      canvas on a machine with 500 MB free will stutter on camera.
- [ ] Browser at **1920×1080**, zoom **100%**, bookmarks bar hidden, one tab only.
- [ ] Signed into Meteor as a funded testnet account with **≥ 20 tUSDC deposited** in WinCut
      and ~2 NEAR for gas.
- [ ] **A position already open and slightly down.** Buy ~8 tUSDC of MLONK five minutes
      before you record. The pool is thin enough that price impact alone puts you under, so
      you are not waiting on the market to do you a favour.
- [ ] Bots running (`cd bots && npm run bots`) so the activity badge and charts are moving.
- [ ] Second tab pre-opened on `https://testnet.nearblocks.io/address/wincut-mansi.testnet`
      so the explorer shot is one Ctrl+Tab away, not a page load.
- [ ] Recorder: **Xbox Game Bar** (`Win`+`G`) or OBS. Capture the browser window, **microphone
      off**, 1080p, 30 fps.

---

## Shot list

Timings are targets, not a metronome. If a signature takes four seconds longer, let it — a
real wallet prompt resolving on camera is the point of the whole exercise.

| time | on screen | what you do |
|---|---|---|
| **0:00–0:12** | `wincut.vercel.app` hero | Nothing. Let the headline sit, then scroll once, slowly. |
| **0:12–0:32** | `/how-it-works`, the calculator | Drag the exit slider down to about **−20%**. Hold. The fee line stays `0.00` and the credit bar fills. |
| **0:32–0:48** | same calculator | Drag up through break-even to about **+40%**. The amber fee appears and the 50 / 20 / 30 bars fill. |
| **0:48–1:05** | `/trade` | Let the four markets load with live prices, then point at the `Live · N trades in last hour` badge. Click **MNEAR**. |
| **1:05–1:20** | `/trade/mnear…`, 5m chart | Nothing. Let the candles and the order panel render. |
| **1:20–1:50** | the buy | Type **5** in the amount box, press Buy, **sign in Meteor on camera**, wait for the confirmation and the position row. |
| **1:50–2:20** | the sell | Switch to your MLONK position, press Sell, sign. Land on the settled row: **fee 0.00**, credit up by the loss. Hold on that number for a full three seconds. |
| **2:20–2:38** | `testnet.nearblocks.io` | Ctrl+Tab, open the top receipt, show the method and the zero fee in the args. |
| **2:38–2:52** | `/dashboard` | Scroll the KPI strip, then the solvency panel. Click **3D view** only if it renders smoothly on the first try. |
| **2:52–3:00** | the agent tape | Scroll to the reasoning tape, then to `the key it holds →` and let the two-row key table sit. Cut. |

---

## Captions

Short lines, bottom centre, white on a 60% black bar, same monospace the app uses. One line at
a time — never two. `docs/wincut-captions.srt` is the same text as a subtitle file: drop it
straight into DaVinci Resolve, Premiere, CapCut or Clipchamp and nudge the timings to match
your take.

```
0:00  Every trading app gets paid when you lose.
0:05  WinCut doesn't.
0:12  Drag the exit price below the entry.
0:19  The fee stays at zero — and the loss is banked as a credit.
0:32  Only a profit is charged: 10% of it.
0:39  Split trader 50 / referrer 20 / protocol 30.
0:48  Four markets on NEAR testnet.
0:54  Prices are live Ref Finance pool reserves, not a mock feed.
1:05  5-minute candles, built from the pool's own swaps.
1:20  A real buy, signed on testnet.
1:30  The contract holds the position. The wallet never does.
1:50  Now a losing exit.
2:00  Fee charged: 0.00
2:08  The loss became credit against the next win.
2:20  The same trade on the NEAR explorer. Nothing was taken.
2:38  343 settled trades. 97 losing exits. Zero fees on every one.
2:46  One fee ever charged: 0.076611 tUSDC — a tenth of a 0.77 profit.
2:52  The AI agent holds a key that can only buy and sell.
2:56  It cannot withdraw. Not by permission — by the key itself.
```

---

## What not to do

- **No stills.** Every shot above is live. A screenshot held for four seconds reads as
  something that could not be made to work.
- **No speeding up the wallet prompt.** The four seconds Meteor takes is evidence.
- **Do not fake a charged fee.** On this market almost every exit is free, and that is the
  claim — the one fee the contract has charged is trade `#274` and the dashboard shows it
  honestly. A staged amber animation would be the only lie in the project.
- **Do not open the 3D field if it stutters.** The flat field carries every number. A frozen
  canvas on camera costs more than the orbit is worth.
