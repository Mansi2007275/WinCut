import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Markets",
  description:
    "Live prices, pool depth and price impact for every market WinCut routes to, read from the " +
    "exchange reserves a trade would actually cross.",
};

export default function TradeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
