import type { Metadata } from "next";

/**
 * The symbol is taken from the account id rather than read from the contract.
 *
 * A title is not worth an RPC call on every crawl, and the id's first label is
 * the symbol for every market this app lists - `mshitzu.tkn.primitives.testnet`
 * is MSHITZU. If that ever stops being true the page itself still shows the
 * contract's own symbol, which is the authority; this only names the tab.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const id = decodeURIComponent(token);
  const symbol = (id.split(".")[0] ?? id).toUpperCase();
  return {
    title: `${symbol} / USDC`,
    description: `Trade ${symbol} on WinCut: no fee on a losing exit, and a loss credit banked against your next win.`,
  };
}

export default function TokenLayout({ children }: { children: React.ReactNode }) {
  return children;
}
