/**
 * The endpoint pool.
 *
 * These tests replace `fetch`, because the behaviour worth checking is entirely
 * about what happens when an endpoint misbehaves - and an endpoint that
 * misbehaves on demand is not something a live network provides. Each case
 * states what the fake endpoints do and asserts which one ended up answering.
 */

import { RpcPool, RpcError } from "../src/rpc.js";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";

/** A JSON-RPC success carrying `value`, encoded the way a node encodes it. */
const ok = (value: unknown) =>
  new Response(
    JSON.stringify({
      result: { result: [...Buffer.from(JSON.stringify(value))] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const inBodyRateLimit = () =>
  new Response(JSON.stringify({ error: { code: -429, message: "Rate limits exceeded" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

type Handler = (url: string) => Response | Promise<Response>;

const real = globalThis.fetch;
let hits: string[] = [];

function install(handler: Handler) {
  hits = [];
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    hits.push(url);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
}

const quiet = () => {};
const silent = (urls: string[]) => new RpcPool("test", urls, quiet);

const run = async (label: string, body: () => Promise<boolean>) => {
  try {
    check(label, await body());
  } catch (e) {
    check(label, false, (e as Error).message);
  }
};

console.log("the endpoint pool");

await run("the first endpoint answers when it is healthy", async () => {
  install(() => ok(7));
  const v = await silent([A, B]).view<number>("c", "m");
  return v === 7 && hits.length === 1 && hits[0] === A;
});

await run("a 429 fails over to the next endpoint", async () => {
  install((url) => (url === A ? new Response("", { status: 429 }) : ok(7)));
  const v = await silent([A, B]).view<number>("c", "m");
  return v === 7 && hits.length === 2 && hits[1] === B;
});

await run("a rate limit inside a 200 also fails over", async () => {
  install((url) => (url === A ? inBodyRateLimit() : ok(7)));
  const v = await silent([A, B]).view<number>("c", "m");
  return v === 7 && hits[1] === B;
});

await run("a 500 fails over", async () => {
  install((url) => (url === A ? new Response("", { status: 500 }) : ok(7)));
  return (await silent([A, B]).view<number>("c", "m")) === 7;
});

await run("a network error fails over", async () => {
  hits = [];
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    hits.push(url);
    return url === A ? Promise.reject(new Error("socket hang up")) : Promise.resolve(ok(7));
  }) as typeof fetch;
  return (await silent([A, B]).view<number>("c", "m")) === 7;
});

await run("a rate-limited endpoint is rested, not retried every call", async () => {
  install((url) => (url === A ? new Response("", { status: 429 }) : ok(7)));
  const pool = silent([A, B]);
  await pool.view("c", "m", { n: 1 });
  await pool.view("c", "m", { n: 2 });
  await pool.view("c", "m", { n: 3 });
  // A is tried once, then skipped: three calls, one to A and three to B.
  return hits.filter((h) => h === A).length === 1 && hits.filter((h) => h === B).length === 3;
});

await run("a cooling endpoint is still used when it is all there is", async () => {
  install(() => new Response("", { status: 429 }));
  const pool = silent([A]);
  let threw = false;
  try { await pool.view("c", "m", { n: 1 }); } catch { threw = true; }
  if (!threw) return false;
  // Rested, but tried again rather than refused outright.
  install(() => ok(7));
  return (await pool.view<number>("c", "m", { n: 2 })) === 7;
});

await run("when every endpoint fails the error names them all", async () => {
  install(() => new Response("", { status: 429 }));
  try {
    await silent([A, B, C]).view("c", "m");
    return false;
  } catch (e) {
    const msg = (e as Error).message;
    return e instanceof RpcError && /a\.example/.test(msg) && /b\.example/.test(msg) && /c\.example/.test(msg);
  }
});

await run("a protocol error does not fail over", async () => {
  // A malformed-args error would come back identically from every endpoint, so
  // asking the next one is just another wasted call.
  install(() => new Response(JSON.stringify({ error: { name: "HANDLER_ERROR" } }), { status: 200 }));
  try {
    await silent([A, B]).view("c", "m");
    return false;
  } catch {
    return hits.length === 1;
  }
});

console.log("the cache");

await run("an identical call inside the window is served from cache", async () => {
  install(() => ok(7));
  const pool = silent([A]);
  await pool.view("c", "m", { x: 1 }, { cacheMs: 10_000 });
  await pool.view("c", "m", { x: 1 }, { cacheMs: 10_000 });
  return hits.length === 1 && pool.stats().cacheHits === 1;
});

await run("different args are different cache entries", async () => {
  install(() => ok(7));
  const pool = silent([A]);
  await pool.view("c", "m", { x: 1 }, { cacheMs: 10_000 });
  await pool.view("c", "m", { x: 2 }, { cacheMs: 10_000 });
  return hits.length === 2;
});

await run("an uncached call is never served from cache", async () => {
  install(() => ok(7));
  const pool = silent([A]);
  await pool.view("c", "m", { x: 1 });
  await pool.view("c", "m", { x: 1 });
  return hits.length === 2 && pool.stats().cacheHits === 0;
});

await run("fresh bypasses the cache and refreshes it", async () => {
  let n = 0;
  install(() => ok(++n));
  const pool = silent([A]);
  const a = await pool.view<number>("c", "m", {}, { cacheMs: 10_000 });
  const b = await pool.view<number>("c", "m", {}, { cacheMs: 10_000, fresh: true });
  const c = await pool.view<number>("c", "m", {}, { cacheMs: 10_000 });
  // First read 1, forced read 2, then the cache holds 2 rather than 1.
  return a === 1 && b === 2 && c === 2;
});

await run("an expired entry is re-read", async () => {
  let n = 0;
  install(() => ok(++n));
  const pool = silent([A]);
  const a = await pool.view<number>("c", "m", {}, { cacheMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const b = await pool.view<number>("c", "m", {}, { cacheMs: 1 });
  return a === 1 && b === 2;
});

console.log("counters");

await run("calls, cache hits and rate limits are all counted", async () => {
  install((url) => (url === A ? new Response("", { status: 429 }) : ok(7)));
  const pool = silent([A, B]);
  await pool.view("c", "m", {}, { cacheMs: 10_000 });
  await pool.view("c", "m", {}, { cacheMs: 10_000 });
  const s = pool.stats();
  return s.rateLimits === 1 && s.cacheHits === 1 && s.calls === 2;
});

await run("a rate limit is reported with the endpoint that caused it", async () => {
  const lines: string[] = [];
  install((url) => (url === A ? new Response("", { status: 429 }) : ok(7)));
  const pool = new RpcPool("test", [A, B], (s) => lines.push(s));
  await pool.view("c", "m");
  return lines.length === 1 && /a\.example/.test(lines[0]!) && /429/.test(lines[0]!);
});

await run("duplicate endpoints are collapsed", async () => {
  install(() => ok(7));
  return silent([A, A, B]).urls.length === 2;
});

await run("an empty endpoint list is refused at construction", async () => {
  try {
    silent([]);
    return false;
  } catch (e) {
    return e instanceof RpcError;
  }
});

globalThis.fetch = real;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
