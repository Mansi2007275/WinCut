# test-only tooling

Nothing in here runs against Arc testnet or mainnet, and nothing in here is part
of the product. These scripts exist to exercise the contracts against a **local
Anvil fork**, where balances can be forged with `anvil_setBalance` and keys are
throwaway.

| file | what it is |
|---|---|
| `dev.sh` | forks Arc, deploys, funds throwaway wallets, seeds pools, writes `deployed.json` |
| `../../contracts/script/test-only/SeedTrades.s.sol` | opens and closes positions on the fork so the board has history |
| `../../web/scripts/test-only/activity-bot.ts` | drives continuous fake trading on the fork |

Each file stays under the directory its own toolchain can resolve — `forge`
needs the Solidity script inside `contracts/`, and `tsx` needs the bot inside
`web/` for module resolution — so the three live in sibling `test-only/`
directories rather than one folder.

**The deployed app reads real Arc testnet state only.** If you run `dev.sh` it
will overwrite `web/src/config/deployed.json` and point the app at your local
fork; re-run the testnet deploy to put it back.
