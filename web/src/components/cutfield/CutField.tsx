"use client";

/**
 * Decides which field to draw, and never draws both.
 *
 * Three reasons to stay in two dimensions, and they are all the viewer's
 * reason rather than ours: they asked the OS for less motion, their device has
 * no WebGL, or they are on a phone where a rotating 3D scene costs battery to
 * show less than the SVG does. A fourth is failure - if the canvas cannot
 * start, or loses its context, the page falls back rather than leaving a hole.
 *
 * The 3D bundle is dynamically imported, so a viewer who gets the SVG never
 * downloads three.js at all.
 */

import { Suspense, lazy, useEffect, useMemo, useState } from "react";

import type { SettledTrade } from "@/lib/cutfield";
import { explorerAccount } from "@/lib/explorer";
import { Field2D, TradeFacts } from "./Field2D";
import { layout, type Hover } from "./Field3D.types";

const Field3D = lazy(() => import("./Field3D"));

/** Why the flat version is on screen, in the viewer's own terms. */
type Mode = { because: string };

/** The sentinel `because` for "nothing is stopping the 3D field here". */
const OFFERABLE = "flat by default";

/**
 * The flat field is the default, and the 3D one is a button.
 *
 * Not a stylistic preference. The SVG field carries every number this page is
 * making a claim about, at every width, with no GPU and no second bundle; the
 * canvas adds one thing on top of that - watching the fee leave the pillar -
 * and on this machine it has been able to wedge the renderer badly enough that
 * the tab stops answering. A centrepiece that can take the whole page down is
 * worse than no centrepiece, so it only mounts when someone asks for it, and
 * the page is complete without it.
 */

function hasWebgl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ?? canvas.getContext("webgl"),
    );
  } catch {
    return false;
  }
}

export function CutField({
  ring,
  markets,
}: {
  ring: SettledTrade[];
  markets: string[];
}) {
  // Server-rendered as the SVG: it needs no measurement and no canvas, so the
  // first paint is the real thing rather than a placeholder that swaps.
  const [mode, setMode] = useState<Mode>({ because: "still checking this device" });
  const [hover, setHover] = useState<Hover>(null);
  const [paused, setPaused] = useState(false);
  const [wants3d, setWants3d] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const small = window.matchMedia("(max-width: 1023px)");

    const decide = () => {
      if (motion.matches) return setMode({ because: "you asked for reduced motion" });
      if (small.matches) return setMode({ because: "narrow screen" });
      if (!hasWebgl()) return setMode({ because: "this browser has no WebGL" });
      setMode({ because: OFFERABLE });
    };
    decide();
    motion.addEventListener("change", decide);
    small.addEventListener("change", decide);
    return () => {
      motion.removeEventListener("change", decide);
      small.removeEventListener("change", decide);
    };
  }, []);

  // A device that cannot run it is never offered it.
  const offer3d = mode.because === OFFERABLE;
  const showing3d = wants3d && offer3d;

  const data = useMemo(() => layout(ring, markets), [ring, markets]);

  const charged = useMemo(() => ring.filter((t) => t.fee > 0).length, [ring]);

  return (
    <section className="overflow-hidden rounded-card border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2">
        <h2 className="mono text-[12px] font-semibold tracking-wide">THE CUT FIELD</h2>
        <p className="mono text-[10px] text-secondary">
          x time · z market · y realised P&amp;L · {ring.length} settled trades
        </p>
        <div className="mono ml-auto flex items-center gap-2 text-[10px]">
          {showing3d && (
            <button
              onClick={() => setPaused((p) => !p)}
              className="rounded-btn border border-border px-2 py-0.5 text-secondary hover:text-text"
            >
              {paused ? "resume orbit" : "pause orbit"}
            </button>
          )}
          {offer3d && (
            <button
              onClick={() => setWants3d((v) => !v)}
              className="rounded-btn border border-border px-2 py-0.5 text-secondary hover:text-text"
              aria-pressed={showing3d}
            >
              {showing3d ? "flat view" : "3D view"}
            </button>
          )}
        </div>
      </header>

      <div
        className="relative field-grid"
        style={{ height: showing3d ? 420 : undefined }}
      >
        {showing3d ? (
          <Suspense fallback={<Field2D ring={ring} markets={markets} />}>
            <Field3D
              data={data}
              lanes={markets.length}
              onHover={setHover}
              paused={paused}
              onError={() => {
                setWants3d(false);
                setMode({ because: "WebGL could not start here" });
              }}
            />
          </Suspense>
        ) : (
          <Field2D ring={ring} markets={markets} />
        )}

        {hover && (
          <a
            href={explorerAccount(hover.datum.trade.user)}
            target="_blank"
            rel="noreferrer"
            className="absolute z-10 max-w-[18rem] rounded-card border border-border bg-bg/95 px-2.5 py-2"
            style={{
              left: Math.min(hover.screen.x + 12, 520),
              top: Math.max(hover.screen.y - 8, 8),
            }}
          >
            <TradeFacts trade={hover.datum.trade} />
          </a>
        )}
      </div>

      <Legend
        charged={charged}
        flat={showing3d || mode.because === OFFERABLE ? undefined : mode.because}
      />
    </section>
  );
}

function Swatch({ color, label, opacity = 1 }: { color: string; label: string; opacity?: number }) {
  return (
    <span className="mono inline-flex items-center gap-1.5 text-[10px] text-secondary">
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 shrink-0"
        style={{ background: color, opacity }}
      />
      {label}
    </span>
  );
}

function Legend({ charged, flat }: { charged: number; flat?: string }) {
  return (
    <div className="space-y-1.5 border-t border-border px-3 py-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Swatch color="var(--color-profit)" label="profit exit" />
        <Swatch color="var(--color-loss)" label="loss exit (below the line)" />
        <Swatch color="var(--color-fee)" label="fee charged" />
        <Swatch color="var(--color-credit)" label="credit banked / fee covered" />
        <Swatch color="#3a424c" label="buy" />
        <Swatch color="var(--color-text)" label="AI agent" />
      </div>
      <p className="mono text-[10px] leading-relaxed text-secondary">
        {charged === 0 ? (
          <>
            No amber on this field: <span className="text-text">{charged} of the settled sells
            were charged a fee</span>. Losing exits are free by the rule, and every winning exit
            so far was smaller than that account&apos;s banked credit — so the three posts
            (trader 50 / referrer 20 / protocol 30) have had nothing to receive.
          </>
        ) : (
          <>
            {charged} charged {charged === 1 ? "fee" : "fees"}. Each amber sliver breaks into
            three pieces and flies to its post — trader left, referrer centre, protocol right.
            When the trade copied nobody there is no trader and no referrer to pay, so all
            three shares land on the protocol&apos;s post.
          </>
        )}
      </p>
      {flat && <p className="mono text-[10px] text-secondary">Flat view: {flat}.</p>}
    </div>
  );
}
