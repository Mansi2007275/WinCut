"use client";

import { useEffect, useRef, useState } from "react";

/**
 * True once the element has been near the viewport, and true forever after.
 *
 * Used to stop every coin row on Discover firing its own log scans at once.
 * It latches rather than toggling, because a row that scrolls away has
 * already paid for its data and tearing the query down would make scrolling
 * back up refetch it.
 *
 * Falls open: if IntersectionObserver is missing, every row is treated as
 * visible, which is the old behaviour rather than a blank screen.
 */
export function useInView<T extends HTMLElement>(rootMargin = "300px") {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, rootMargin]);

  return { ref, seen };
}
