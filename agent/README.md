# WinCut Agent

An autonomous trader that holds a key which can do exactly two things: call
`buy` and call `sell` on the WinCut contract. It cannot withdraw. It cannot
claim. It cannot transfer NEAR. That is not a promise about the code — it is a
property of the access key, enforced by the NEAR runtime, and you can verify it
yourself in one command (see [Verifying the key](#verifying-the-key)).

Every five minutes it reads the chain, decides, and writes down what it decided
and why — including the times it decided to do nothing, which is most of them.

---

## How a decision gets made

```
read chain  ──▶  hard exits  ──▶  the brain  ──▶  the risk layer  ──▶  execute
balance          stop loss        NEAR AI Cloud    re-checks every      buy / sell
positions        take profit      or the momentum  limit against        at a quoted
pool reserves    (not optional)   fallback         live chain numbers   min_out
candles                                                   │
                                                          ▼
                                            every outcome, HOLD included,
                                                  into the log
```

Four things are worth knowing about that pipeline.

**The limits are in code, not in the prompt.** `src/config.ts` holds them and
`src/risk.ts` applies them, after the model has answered. A limit written into a
prompt is a request: a model can misread it, round it, or reason its way past
it. A limit in code is arithmetic the model never touches. The prompt *mentions*
the limits — so the model has a chance of proposing something acceptable — while
telling it plainly that applying them is not its job.

**A proposal that breaks a limit is refused, not shrunk.** It becomes a HOLD
whose reason names the limit that stopped it, and the overruled proposal is kept
alongside it in the log. "It traded, just smaller than it asked" is much harder
to audit afterwards than "it refused, and here is why".

**Stop loss and take profit run before the model is asked at all.** A position
past −8% or +12% is closed. There is no prompt in which the model talks the
agent out of its own stop loss.

**There is a decider that is not a model.** `fallbackDecision` in
`src/brain.ts` is momentum against the window mean, with an exit rule. It runs
when there is no API key, when the request fails, when it times out, and when
the model returns something that will not parse. It is deliberately dull — its
job is to be defensible without a vendor, not to win.

## What counts as real data

The agent reads prices by walking the Rhea pool reserves hop by hop, the same
route a trade will cross. `min_out` comes from `get_return` on those pools, not
from the mid price, because the mid ignores the price impact of the agent's own
size — a slippage guard derived from it would be measuring the wrong thing.

Candles come from whichever indexer exists for the network: GeckoTerminal on
mainnet, and on testnet the series WinCut builds itself from on-chain samples
(see `docs/DEPLOY.md`). When a source is unavailable the field is `undefined`
and the note says so. Nothing is filled in with a guess, and a missing input is
a reason to hold rather than a gap to paper over.

---

## Setup

### 1. Create the agent's account

A sub-account of the contract's account, so the relationship is legible on
chain:

```bash
near account create-account fund-myself agent.wincut-mansi.testnet '2 NEAR' \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as wincut-mansi.testnet \
  network-config testnet \
  sign-with-legacy-keychain send
```

The 2 NEAR covers storage and gas; the agent never spends NEAR on trades
themselves, because neither `buy` nor `sell` is payable.

Then register it with the WinCut contract and give it something to trade — a
`storage_deposit` and a tUSDC deposit, exactly as a human account does. The
agent trades the balance it holds *inside* WinCut, not tokens in its wallet.

### 2. Create the function-call key

This is the command that makes the security claim true:

```bash
near account add-key agent.wincut-mansi.testnet \
  grant-function-call-access \
    --allowance '0.25 NEAR' \
    --contract-account-id wincut-mansi.testnet \
    --function-names 'buy,sell' \
  autogenerate-new-keypair print-to-terminal \
  network-config testnet \
  sign-with-legacy-keychain send
```

Three parts of it matter:

- `--contract-account-id wincut-mansi.testnet` — the key is usable against that
  one contract and no other. It cannot call a token contract, so it cannot
  transfer tokens.
- `--function-names 'buy,sell'` — within that contract, only those two methods.
  `withdraw` and `claim` are rejected by the runtime before any WinCut code
  runs.
- `--allowance '0.25 NEAR'` — a gas budget. A function-call key can never
  attach a deposit, so this is the entire extent of what the key can spend.

`print-to-terminal` prints the secret key once. Put it in `agent/.env` as
`AGENT_PRIVATE_KEY` and do not paste it anywhere else — `.env` is gitignored.

> If you would rather not create the key by hand, run the agent with `DRY_RUN=1`
> first. It reads the chain over plain JSON-RPC and needs no key at all, so a
> dry run is a genuine rehearsal rather than a simulation.

### 3. Configure

```bash
cd agent
npm install
cp .env.example .env     # then fill it in
npm test                 # 20 checks that each hard limit actually rejects
npm run dry              # one real decision from live data, nothing signed
```

| Variable | Needed? | What it does |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | to trade | The function-call key from step 2. Omit it and the agent decides and logs but never signs. |
| `AGENT_ACCOUNT_ID` | no | Defaults to `agent.<contract>`. |
| `WINCUT_CONTRACT_ID` | no | Defaults to `wincut-mansi.testnet`. |
| `NEAR_NETWORK` | no | `testnet` (default) or `mainnet`. |
| `NEAR_RPC_URL` | no | Defaults to FastNEAR for the network. |
| `NEAR_AI_API_KEY` | no | NEAR AI Cloud. Without it the momentum fallback decides, and the log says which decided. |
| `NEAR_AI_MODEL` | no | Defaults to `deepseek-v3`. |
| `NEAR_AI_BASE_URL` | no | Any OpenAI-compatible endpoint. Defaults to `https://api.near.ai/v1`. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | for the web page | The decision log. Use the same database as the web app so `/trader/...` reads what the agent writes. |
| `WINCUT_WEB_URL` | no | Where testnet candles are read from. Defaults to the deployed app. |
| `AGENT_LOOP_MS` | no | Defaults to 300000 (5 minutes). |
| `DRY_RUN` | no | `1` to decide and log without signing. |

### 4. Run

```bash
npm start          # the loop
npm run once       # a single pass, then exit
npm run dry        # a single pass, nothing signed
```

---

## Verifying the key

Do not take the claim on faith — ask the chain what the key is allowed to do:

```bash
near account list-keys agent.wincut-mansi.testnet \
  network-config testnet now
```

The agent's key shows a `FunctionCall` permission naming `wincut-mansi.testnet`
and the two method names. A key that could withdraw would show `FullAccess`
instead. If you see `FullAccess` on the key the agent is using, the security
property does not hold, and you should delete that key.

Both calls attach a zero deposit, which is what lets a function-call key make
them at all. Neither `buy` nor `sell` is `#[payable]` in the contract, and
`withdraw`/`claim` live in a different module the key cannot reach.

---

## Deploying it somewhere that stays up

The agent is a long-running process, not a web service. It needs no inbound
port and no public URL.

### GitHub Codespaces — for a demo you are watching

```bash
cd agent && npm install && npm start
```

Fine for a demo, but a Codespace stops when you close it. Not for anything you
want running tomorrow.

### Railway

New Project → Deploy from GitHub repo → set **Root Directory** to `agent`.
Railway detects Node, runs `npm install`, and needs the start command set to
`npm start`. Add the environment variables from the table above under
**Variables**. No port, so set no healthcheck — a worker that never listens will
otherwise be restarted forever.

### Render

New → **Background Worker** (not a Web Service — a Web Service is killed for not
binding a port). Root Directory `agent`, build `npm install`, start `npm start`.
Add the same variables.

### A plain VPS

```bash
npm install -g pm2
cd agent && npm install
pm2 start npm --name wincut-agent -- start
pm2 logs wincut-agent
pm2 save && pm2 startup
```

Wherever it runs: the process holds the function-call key, so put the key in the
platform's secret store, never in the repo. The worst case if that host is
compromised is bounded by the key itself — someone could make the agent trade,
and could burn its 0.25 NEAR allowance on gas. They could not move the money
out.

---

## Reading what it did

`/trader/agent.wincut-mansi.testnet` in the web app shows the decision log, the
PnL, the followers, and the earnings, with an **AI Agent** badge and the key's
limits stated on the page.

If it has not traded yet, the page shows the HOLD log, which is the honest
answer. A page that showed nothing until the first trade would be hiding the
part of the record that says how often the agent correctly did nothing.

## Layout

| File | What lives there |
| --- | --- |
| `src/config.ts` | Environment, and the hard limits |
| `src/chain.ts` | Views over JSON-RPC; the only place that signs; `get_return` quotes |
| `src/market.ts` | Mid price along a route, pool depth, candles, momentum |
| `src/brain.ts` | The NEAR AI Cloud call, and the momentum fallback |
| `src/risk.ts` | Forced exits, and the veto that every proposal passes through |
| `src/store.ts` | The Upstash decision log |
| `src/index.ts` | The loop |
| `test/risk.test.ts` | 20 checks that each limit rejects what it claims to |
