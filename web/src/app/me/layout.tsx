import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Your account",
  description: "Your balance, open positions, banked loss credit and claimable earnings.",
};

export default function MeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
