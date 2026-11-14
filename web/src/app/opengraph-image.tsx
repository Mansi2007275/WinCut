import { ImageResponse } from "next/og";

/**
 * The share card, drawn rather than stored.
 *
 * A PNG in `public/` would have to be re-exported by hand every time the pitch
 * changes, and would drift from the copy on the page. This is generated at the
 * edge from the same words, in the app's own colours - near-black, one amber
 * accent for the fee, green for profit - so the card cannot say something the
 * site does not.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "WinCut — every trading app gets paid when you lose. WinCut doesn't.";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0b0e11",
          color: "#e6e8eb",
          padding: "72px 80px",
          // The 1px rule grid from the dashboard, at card scale.
          backgroundImage:
            "linear-gradient(to right, #1a1f26 1px, transparent 1px), linear-gradient(to bottom, #1a1f26 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "#3b82f6",
              display: "flex",
            }}
          />
          <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }}>WinCut</span>
        </div>

        {/* Satori lays out flex boxes, not flowing text: a <br /> inside a
            span is ignored and the line runs off the card. Each line is its
            own row. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 58, fontWeight: 700, letterSpacing: -2 }}>
            Every trading app gets paid
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 58, fontWeight: 700, letterSpacing: -2 }}>
            <span>when you lose.</span>
            <span style={{ color: "#16c784" }}>WinCut doesn&apos;t.</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 26,
              color: "#8a929c",
              lineHeight: 1.35,
              maxWidth: 1000,
              marginTop: 10,
            }}
          >
            The platform, the trader you copied and your referrer are paid only out of your
            profit. A losing exit costs nothing and banks a credit against your next win.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 28, fontSize: 22 }}>
          <span style={{ color: "#f5a524", fontWeight: 600 }}>10% of profit</span>
          <span style={{ color: "#8a929c" }}>50 trader · 20 referrer · 30 protocol</span>
          <span style={{ marginLeft: "auto", color: "#8a929c" }}>on NEAR</span>
        </div>
      </div>
    ),
    size,
  );
}
