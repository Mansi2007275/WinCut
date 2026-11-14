import type { Metadata } from "next";

/**
 * The page itself is a client component, so its title lives here.
 */
export const metadata: Metadata = {
  title: "The Cut Field",
  description:
    "Every settled WinCut trade as a pillar: the fee it paid, where that fee went, and the " +
    "loss credit each losing exit banked. Read live from the NEAR contract.",
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
