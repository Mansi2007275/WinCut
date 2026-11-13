/**
 * Historical swap prices for a testnet pool, read from NearBlocks.
 *
 * GeckoTerminal does not index testnet, so the only way to learn what a pool
 * traded at before WinCut started watching it is to read the chain's own
 * history. NearBlocks indexes testnet and exposes fungible-token transfer
 * events, which is what a swap actually is: the exchange receives one token
 * and sends another in the same transaction. The ratio of those two amounts,
 * adjusted for decimals, is the price that swap executed at.
 *
 * Deriving the price from the token movements rather than from the
 * "Swapped X for Y" log line is deliberate. The log is a human-readable string
 * whose wording is not part of any interface and has changed between exchange
 * versions; the transfer events are typed, carry their own decimals, and are
 * what the tokens themselves emitted.
 *
 * Two endpoints are involved, for an awkward reason. NearBlocks retired its v1
 * API on 2026-11-05, and v3 is what serves the per-token event stream - but no
 * v3 endpoint returns every token event for a single transaction, which is
 * what pairing the two sides of a swap needs. So the search runs on v3 and
 * only the per-transaction join falls back to v1. If v1 disappears the search
 * still works and the join degrades to "could not pair", which is reported
 * rather than guessed at.
 */

const BASE_TESTNET = "https://api-testnet.nearblocks.io";

/** The free tier allows roughly six requests a minute, so this is deliberate. */
const THROTTLE_MS = 11_000;
const RETRY_429_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SwapPrice = {
  /** Milliseconds. */
  t: number;
  /** Quote units per whole base token. */
  p: number;
  txHash: string;
};

export type BackfillReport = {
  pool: string;
  base: string;
  quote: string;
  /** Token events scanned on the base token's stream. */
  eventsScanned: number;
  /** Of those, the ones where the exchange was the counterparty. */
  exchangeEvents: number;
  /** Distinct transactions that looked like a swap. */
  candidateTxs: number;
  /** Swaps we could price, because both sides were readable. */
  priced: number;
  /** Candidate transactions whose second side could not be read. */
  unpaired: number;
  oldest: string | null;
  newest: string | null;
  prices: SwapPrice[];
  notes: string[];
};

type FtEvent = {
  affected_account_id: string;
  involved_account_id: string | null;
  block_timestamp: string;
  delta_amount: string;
  transaction_hash: string;
  contract_account_id?: string;
  meta?: { contract?: string; decimals?: number };
};

async function get(url: string, tries = 3): Promise<unknown | null> {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
    if (res.ok) return res.json();
    if (res.status === 429) {
      await sleep(RETRY_429_MS * (i + 1));
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Walks the base token's event stream for transactions where the exchange was
 * the counterparty, then reads each one to find the matching quote-token
 * movement and turns the pair into a price.
 */
export async function backfillPool(opts: {
  poolKey: string;
  baseToken: string;
  baseDecimals: number;
  quoteToken: string;
  quoteDecimals: number;
  exchange: string;
  maxPages?: number;
  network?: "testnet" | "mainnet";
}): Promise<BackfillReport> {
  const {
    poolKey, baseToken, baseDecimals, quoteToken, quoteDecimals, exchange,
    maxPages = 6, network = "testnet",
  } = opts;

  const api = network === "testnet" ? BASE_TESTNET : "https://api.nearblocks.io";
  const report: BackfillReport = {
    pool: poolKey, base: baseToken, quote: quoteToken,
    eventsScanned: 0, exchangeEvents: 0, candidateTxs: 0,
    priced: 0, unpaired: 0, oldest: null, newest: null, prices: [], notes: [],
  };

  // 1. find candidate swap transactions.
  //
  // Either side of the pair identifies the same swaps, so the search runs on
  // whichever one NearBlocks actually indexes. It does not index wrap.testnet
  // at all - that stream comes back empty - while the token paired against it
  // is indexed fine, so falling through to the other side is not a nicety but
  // the only way a wNEAR pool yields anything.
  const candidates = new Set<string>();
  const searchable = [baseToken, quoteToken].filter((t, i, a) => a.indexOf(t) === i);
  let searchToken = searchable[0];
  let cursor: string | null = null;
  let pages = 0;
  let switched = false;

  while (pages < maxPages) {
    const url =
      `${api}/v3/fts/${encodeURIComponent(searchToken)}/txns?per_page=50` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const page = (await get(url)) as { data?: FtEvent[]; meta?: { next_page?: string } } | null;
    if (!page) {
      report.notes.push(
        `the event stream for ${searchToken} stopped responding after ${pages} page(s)`,
      );
      break;
    }
    const rows = page.data ?? [];
    if (!rows.length) {
      // Nothing on this side. Try the other one once before giving up.
      if (!switched && searchable[1] && searchToken !== searchable[1]) {
        report.notes.push(`${searchToken} has no indexed events; searching ${searchable[1]} instead`);
        searchToken = searchable[1];
        switched = true;
        cursor = null;
        continue;
      }
      break;
    }
    pages++;
    report.eventsScanned += rows.length;

    for (const ev of rows) {
      if (ev.affected_account_id !== exchange && ev.involved_account_id !== exchange) continue;
      report.exchangeEvents++;
      if (ev.transaction_hash) candidates.add(ev.transaction_hash);
    }

    cursor = page.meta?.next_page ?? null;
    if (!cursor) break;
    await sleep(THROTTLE_MS);
  }
  report.candidateTxs = candidates.size;

  if (!candidates.size) {
    report.notes.push(
      `no swaps between ${searchToken} and the exchange are indexed - this pool has no trading history to recover`,
    );
    return report;
  }

  // 2. price each candidate from the two token movements in that transaction
  for (const hash of candidates) {
    await sleep(THROTTLE_MS);
    const detail = (await get(`${api}/v1/txns/${hash}`)) as
      | { txns?: { receipts?: { fts?: FtEvent[] }[]; block_timestamp?: string }[] }
      | null;
    const tx = detail?.txns?.[0];
    if (!tx) {
      report.unpaired++;
      continue;
    }

    const events: FtEvent[] = [];
    for (const rc of tx.receipts ?? []) events.push(...(rc.fts ?? []));

    // how much of each token the exchange took in and paid out
    const net = (token: string) =>
      events
        .filter(
          (e) =>
            (e.meta?.contract ?? e.contract_account_id) === token &&
            e.affected_account_id === exchange,
        )
        .reduce((sum, e) => sum + Number(e.delta_amount ?? 0), 0);

    const baseDelta = net(baseToken);
    const quoteDelta = net(quoteToken);

    // a swap moves the two sides in opposite directions
    if (!baseDelta || !quoteDelta || Math.sign(baseDelta) === Math.sign(quoteDelta)) {
      report.unpaired++;
      continue;
    }

    const baseAmt = Math.abs(baseDelta) / 10 ** baseDecimals;
    const quoteAmt = Math.abs(quoteDelta) / 10 ** quoteDecimals;
    if (!(baseAmt > 0) || !(quoteAmt > 0)) {
      report.unpaired++;
      continue;
    }

    const price = quoteAmt / baseAmt;
    const tsNs = tx.block_timestamp ?? events[0]?.block_timestamp;
    const t = tsNs ? Number(BigInt(tsNs) / 1_000_000n) : NaN;
    if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) {
      report.unpaired++;
      continue;
    }

    report.prices.push({ t, p: price, txHash: hash });
    report.priced++;
  }

  report.prices.sort((a, b) => a.t - b.t);
  if (report.prices.length) {
    report.oldest = new Date(report.prices[0].t).toISOString();
    report.newest = new Date(report.prices[report.prices.length - 1].t).toISOString();
  }

  // Pricing a swap needs both sides of it. NearBlocks does not index
  // wrap.testnet's token events at all, so for a wNEAR-paired pool the second
  // side is invisible and every candidate comes back unpaired. That is a limit
  // of the indexer, not a failure here, and the report should say which.
  if (report.candidateTxs > 0 && report.priced === 0) {
    report.notes.push(
      `found ${report.candidateTxs} swap transaction(s) but could not price any of them: ` +
        `the ${switched ? baseToken : quoteToken} side of each swap has no indexed token events, ` +
        `so only one half of the trade is visible. Historical prices cannot be recovered for this ` +
        `pair; the live sampler is the only source for its chart.`,
    );
  }
  return report;
}
