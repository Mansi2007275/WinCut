/**
 * The RPC layer: several endpoints, a short cache, and counters.
 *
 * Four mirror markets multiplied this project's read traffic by four overnight,
 * and a free endpoint started answering with 429. The symptom was a line in the
 * log saying a pass had failed - which is honest, but a pass that silently
 * stops happening is a market that silently stops being made.
 *
 * Three things fix it, in order of how much they help:
 *
 *   The cache. Most of the traffic was the same question asked twice. A maker
 *   pass and a sampling tick both want pool #2963's reserves, and before this
 *   they asked separately; `readPegFor` wanted the NEAR price once per market,
 *   so four markets meant four identical mainnet reads. A twelve-second window
 *   collapses all of that and changes no behaviour that matters, because the
 *   alternative was reading a number that had not moved.
 *
 *   The endpoint pool. When one endpoint rate-limits, the call goes to the next
 *   rather than failing. An endpoint that returns 429 is put in a cooldown, so
 *   we stop paying a round trip to learn the same thing every call. The pool is
 *   ordered, and the order is configuration. One endpoint is not in it at all:
 *   see `REFUSED_RPC_HOSTS` below for why FastNEAR was taken out rather than
 *   merely demoted.
 *
 *   Saying so. Every rate limit prints one line naming the endpoint. Falling
 *   back to a second endpoint is the system working, but it is also the only
 *   warning you get before the second one runs out too.
 */

/**
 * Endpoints this agent will not use, whatever it is told.
 *
 * FastNEAR's free testnet tier rate-limited a large share of this agent's
 * reads. Because a 429 fails over rather than failing, the only visible
 * symptom was passes that took longer and sometimes gave up altogether, with
 * the real cause buried in a log line most people never read. Deleting it from
 * the default list was not enough on its own: a `NEAR_RPC_URL` left over in a
 * shell or a deploy config puts it straight back. So the refusal lives here,
 * at the one place every endpoint has to pass through, and `withoutRefusedRpc`
 * is applied to configuration as well as to the defaults.
 */
const REFUSED_RPC_HOSTS = [/(^|\.)fastnear\.com$/i];

const refusedRpc = (url: string): boolean => {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL at all; let the pool fail on it loudly rather than silently
    // dropping something that might have been meant as an endpoint.
    return false;
  }
  return REFUSED_RPC_HOSTS.some((re) => re.test(host));
};

/** The endpoints from `urls` that this agent is allowed to talk to. */
export const withoutRefusedRpc = (urls: string[]): string[] =>
  urls.filter((u) => u.trim() && !refusedRpc(u.trim()));

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

type Endpoint = {
  url: string;
  /** Epoch ms before which this endpoint is skipped. */
  cooldownUntil: number;
  calls: number;
  rateLimits: number;
  failures: number;
};

export type ViewOptions = {
  /** How long an identical call may be answered from cache. 0 disables it. */
  cacheMs?: number;
  /** Bypass and overwrite the cache. For reads whose whole point is freshness. */
  fresh?: boolean;
};

/** A 429 costs a minute; anything else gets a short penalty and another go. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const FAILURE_COOLDOWN_MS = 15_000;

const short = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export class RpcPool {
  private readonly endpoints: Endpoint[];
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private cacheHits = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly label: string,
    urls: string[],
    private readonly log: (s: string) => void = console.log,
  ) {
    const unique = [...new Set(withoutRefusedRpc(urls).map((u) => u.trim()))];
    if (!unique.length) throw new RpcError(`${label}: no RPC endpoints configured`);
    this.endpoints = unique.map((url) => ({
      url, cooldownUntil: 0, calls: 0, rateLimits: 0, failures: 0,
    }));
  }

  get urls(): string[] {
    return this.endpoints.map((e) => e.url);
  }

  /**
   * The endpoints to try, in order: those out of cooldown first, then the rest
   * ordered by when their cooldown ends.
   *
   * The fallback to a cooling endpoint is deliberate. A cooldown is a guess
   * about an endpoint we are rate-limited on, and a guess is not a good enough
   * reason to fail a call outright when it is the only endpoint left.
   */
  private order(): Endpoint[] {
    const now = Date.now();
    const ready = this.endpoints.filter((e) => e.cooldownUntil <= now);
    const cooling = this.endpoints
      .filter((e) => e.cooldownUntil > now)
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return [...ready, ...cooling];
  }

  /**
   * One JSON-RPC call, failed over across the pool.
   *
   * `decode` turns the node's `result` into the value the caller wanted, and
   * it runs before anything is cached - so a response the caller cannot use is
   * never remembered as if it were an answer. A decode that throws `RpcError`
   * is a real protocol answer rather than a sick endpoint, so it is not failed
   * over: every other endpoint would say the same thing.
   */
  async call<T>(
    method: string,
    params: unknown,
    decode: (result: unknown) => T,
    opts: ViewOptions & { label?: string } = {},
  ): Promise<T> {
    const label = opts.label ?? method;
    const key = `${method}|${JSON.stringify(params)}`;
    const ttl = opts.cacheMs ?? 0;

    if (ttl > 0 && !opts.fresh) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < ttl) {
        this.cacheHits++;
        return hit.value as T;
      }
    }

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const problems: string[] = [];

    for (const endpoint of this.order()) {
      endpoint.calls++;
      try {
        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(15_000),
        });

        if (res.status === 429) {
          endpoint.rateLimits++;
          endpoint.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          this.log(
            `rpc: ${short(endpoint.url)} rate-limited this ${this.label} read ` +
            `(429, ${endpoint.rateLimits} so far) - resting it for ` +
            `${RATE_LIMIT_COOLDOWN_MS / 1000}s and trying the next endpoint`,
          );
          problems.push(`${short(endpoint.url)} 429`);
          continue;
        }
        if (res.status >= 500 || res.status === 410 || res.status === 403) {
          endpoint.failures++;
          endpoint.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
          problems.push(`${short(endpoint.url)} http ${res.status}`);
          continue;
        }

        const json = (await res.json()) as { error?: unknown; result?: unknown };

        // A -429 arrives inside a 200 on some endpoints, so the body has to be
        // checked for it as well as the status line.
        const errText = json.error === undefined ? "" : JSON.stringify(json.error);
        if (errText.includes("-429") || /rate limit/i.test(errText)) {
          endpoint.rateLimits++;
          endpoint.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          this.log(
            `rpc: ${short(endpoint.url)} rate-limited this ${this.label} read ` +
            `(in-body, ${endpoint.rateLimits} so far) - resting it for ` +
            `${RATE_LIMIT_COOLDOWN_MS / 1000}s and trying the next endpoint`,
          );
          problems.push(`${short(endpoint.url)} rate limit`);
          continue;
        }

        // Not every endpoint serves every method: dRPC answers
        // `EXPERIMENTAL_tx_status` and refuses `tx_status`, and
        // rpc.testnet.near.org is the other way round. That is a fact about
        // the endpoint, not about the request, so it fails over like any
        // other endpoint problem rather than ending the call.
        if (errText.includes("-32601") || /method is not available|method not found/i.test(errText)) {
          endpoint.failures++;
          endpoint.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
          problems.push(`${short(endpoint.url)} no ${method}`);
          continue;
        }

        if (json.error) {
          // A real protocol error - the same answer would come from any
          // endpoint, so there is nothing to fail over to.
          throw new RpcError(`rpc: ${errText.slice(0, 180)}`);
        }

        const value = decode(json.result);
        if (ttl > 0) this.cache.set(key, { at: Date.now(), value });
        return value;
      } catch (e) {
        if (e instanceof RpcError) throw e;
        endpoint.failures++;
        endpoint.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
        problems.push(`${short(endpoint.url)} ${(e as Error).message.slice(0, 60)}`);
      }
    }

    throw new RpcError(`${label}: every endpoint failed - ${problems.join("; ")}`);
  }

  async view<T>(
    accountId: string,
    method: string,
    args: unknown = {},
    opts: ViewOptions = {},
  ): Promise<T> {
    const label = `${accountId}.${method}`;
    return this.call<T>(
      "query",
      {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
      (result) => {
        const r = result as { result?: number[]; error?: string } | undefined;
        if (r?.error) throw new RpcError(`${label}: ${r.error}`);
        if (!r?.result) throw new RpcError(`${label}: empty result`);
        return JSON.parse(Buffer.from(r.result).toString()) as T;
      },
      { ...opts, label },
    );
  }

  /** Counters, for the one-line report at startup and on demand. */
  stats() {
    const minutes = Math.max((Date.now() - this.startedAt) / 60_000, 1 / 60);
    const calls = this.endpoints.reduce((s, e) => s + e.calls, 0);
    return {
      calls,
      cacheHits: this.cacheHits,
      callsPerMin: calls / minutes,
      rateLimits: this.endpoints.reduce((s, e) => s + e.rateLimits, 0),
      endpoints: this.endpoints.map((e) => ({
        host: short(e.url),
        calls: e.calls,
        rateLimits: e.rateLimits,
        failures: e.failures,
        resting: e.cooldownUntil > Date.now(),
      })),
    };
  }

  describe(): string {
    const s = this.stats();
    return (
      `${this.label} rpc: ${s.calls} call(s), ${s.cacheHits} served from cache, ` +
      `${s.rateLimits} rate limit(s) · ` +
      s.endpoints.map((e) => `${e.host} ${e.calls}${e.resting ? " (resting)" : ""}`).join(", ")
    );
  }
}
