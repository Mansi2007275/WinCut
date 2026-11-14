import type { Metadata } from "next";

/** The page is a client component, so its title lives here. */
export const metadata: Metadata = {
  title: "How the fee works",
  description:
    "WinCut charges 10% of realised profit, after any banked loss credit, and nothing at all on " +
    "a losing exit. Run the rule on your own numbers, and read the live solvency and agent-key " +
    "checks behind it.",
};

export default function HowItWorksLayout({ children }: { children: React.ReactNode }) {
  return children;
}
