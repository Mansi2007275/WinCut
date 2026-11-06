"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { isAddress, type Address } from "viem";

const REF_KEY = "wincut.referrer";

/**
 * Who referred this visitor, and who they are copying.
 *
 * `?ref=0x…` is remembered across sessions, because a referrer only earns when
 * the person they invited eventually exits in profit, which may be days later.
 * `?follow=0x…` is deliberately NOT remembered: copying is a decision per
 * trade, and a sticky one would silently credit a trader for trades the user
 * never meant to copy.
 *
 * Both are validated with isAddress before use. An unchecked query parameter
 * would be encoded straight into hookData, and a malformed one would revert the
 * swap with nothing on screen explaining why.
 */
export function useReferral() {
  const params = useSearchParams();
  const [referrer, setReferrer] = useState<Address | undefined>();

  const rawFollow = params.get("follow");
  const follow = rawFollow && isAddress(rawFollow) ? (rawFollow as Address) : undefined;

  useEffect(() => {
    const fromUrl = params.get("ref");
    if (fromUrl && isAddress(fromUrl)) {
      try {
        localStorage.setItem(REF_KEY, fromUrl);
      } catch {
        // Private browsing blocks storage. The referrer still applies to this
        // session, it just will not survive a reload.
      }
      setReferrer(fromUrl as Address);
      return;
    }
    try {
      const saved = localStorage.getItem(REF_KEY);
      if (saved && isAddress(saved)) setReferrer(saved as Address);
    } catch {
      // Nothing to recover; the trade simply has no referrer.
    }
  }, [params]);

  return { follow, referrer };
}

/// The link a user shares to earn 20% of their invitees' winning exits.
export function inviteLink(me?: Address): string {
  if (typeof window === "undefined" || !me) return "";
  return `${window.location.origin}/?ref=${me}`;
}

/// The link that credits a trader when someone copies them.
export function copyLink(trader: Address, coin?: Address): string {
  if (typeof window === "undefined") return "";
  const base = coin ? `${window.location.origin}/coin/${coin}` : window.location.origin;
  return `${base}?follow=${trader}`;
}
