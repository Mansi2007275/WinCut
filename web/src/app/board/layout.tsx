import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Traders",
  description:
    "Realised P&L, volume and win rate for every account that has traded, read from the " +
    "contract's own leaderboard. Bots and the AI agent are badged as what they are.",
};

export default function BoardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
