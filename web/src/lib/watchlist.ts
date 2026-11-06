"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isAddress, type Address } from "viem";

const KEY = "wincut.watchlist";

/**
 * Coins the user starred, kept in localStorage.
 *
 * Purely a per-browser convenience: there is nothing on chain that says a
 * wallet is "watching" a coin, and inventing a server to store it would mean
 * this screen was no longer reading only from Arc. If storage is unavailable
 * the tab simply stays empty rather than throwing.
 *
 * Addresses are validated on read as well as write, because anything in
 * localStorage can be edited by hand and a malformed entry would be passed
 * straight into a contract read.
 */
function load(): Address[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is Address => typeof x === "string" && isAddress(x));
  } catch {
    return [];
  }
}

export function useWatchlist() {
  const [list, setList] = useState<Address[]>([]);

  // Read after mount: localStorage does not exist during SSR, and seeding
  // state from it directly would make the server and client markup disagree.
  useEffect(() => setList(load()), []);

  // Another tab starring a coin should show up here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setList(load());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback((coin: Address) => {
    setList((prev) => {
      const lower = coin.toLowerCase();
      const next = prev.some((c) => c.toLowerCase() === lower)
        ? prev.filter((c) => c.toLowerCase() !== lower)
        : [...prev, coin];
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Private browsing. The star still works for this session.
      }
      return next;
    });
  }, []);

  const has = useCallback(
    (coin?: Address) =>
      !!coin && list.some((c) => c.toLowerCase() === coin.toLowerCase()),
    [list],
  );

  // Memoised: callers put this in useMemo dependency lists, and a fresh object
  // every render made their ordering recompute on every single render, which
  // thrashed the layout animations downstream.
  return useMemo(() => ({ list, toggle, has }), [list, toggle, has]);
}
