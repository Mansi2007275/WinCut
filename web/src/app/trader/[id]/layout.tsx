import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const account = decodeURIComponent(id);
  return {
    title: account,
    description: `Trades, realised P&L and earnings for ${account} on WinCut.`,
  };
}

export default function TraderLayout({ children }: { children: React.ReactNode }) {
  return children;
}
