"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const REF_KEY = "wincut.referrer";

/**
 * NEAR account id rules, as the protocol enforces them: 2 to 64 characters,
 * lowercase letters, digits and the separators `-`, `_` and `.`, with every
 * dot-separated part starting and ending in a letter or digit. A 64-character
 * hex string is also valid - that is an implicit account.
 */
const ACCOUNT_ID = /^(([a-z\d]+[\-_])*[a-z\d]+\.)*([a-z\d]+[\-_])*[a-z\d]+$/;

export function isAccountId(value: string | null | undefined): value is string {
  if (!value) return false;
  if (value.length < 2 || value.length > 64) return false;
  return ACCOUNT_ID.test(value);
}

/**
 * Who referred this visitor, and who they are copying.
 *
 * `?ref=alice.near` is remembered across sessions, because a referrer only
 * earns when the person they invited eventually exits in profit, which may be
 * days later. `?follow=bob.near` is deliberately NOT remembered: copying is a
 * decision per trade, and a sticky one would quietly credit a trader for
 * trades the user never meant to copy.
 *
 * Both are validated before use. An id that the protocol would reject makes
 * the whole `buy` fail, and the user would see a refused transaction with no
 * explanation of why.
 */
export function useReferral() {
  const params = useSearchParams();
  const [referrer, setReferrer] = useState<string | undefined>();

  const rawFollow = params.get("follow");
  const follow = isAccountId(rawFollow) ? rawFollow : undefined;

  useEffect(() => {
    const fromUrl = params.get("ref");
    if (isAccountId(fromUrl)) {
      try {
        localStorage.setItem(REF_KEY, fromUrl);
      } catch {
        // Private browsing blocks storage. The referrer still applies to this
        // session; it just will not survive a reload.
      }
      setReferrer(fromUrl);
      return;
    }
    try {
      const saved = localStorage.getItem(REF_KEY);
      if (isAccountId(saved)) setReferrer(saved);
    } catch {
      // Nothing to recover; the trade simply has no referrer.
    }
  }, [params]);

  return { follow, referrer };
}

/** The link a user shares to earn 20% of their invitees' winning exits. */
export function inviteLink(me?: string | null): string {
  if (typeof window === "undefined" || !me) return "";
  return `${window.location.origin}/?ref=${me}`;
}

/** The link that credits a trader when someone copies them. */
export function copyLink(trader: string, tokenId?: string): string {
  if (typeof window === "undefined") return "";
  const base = tokenId
    ? `${window.location.origin}/trade/${encodeURIComponent(tokenId)}`
    : window.location.origin;
  return `${base}?follow=${trader}`;
}
