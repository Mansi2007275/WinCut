"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ToastProvider } from "@/components/Toast";
import { WalletProvider } from "@/lib/wallet";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Each hook sets its own poll interval; this is only the floor for
            // a re-render triggered by something else on screen.
            staleTime: 4_000,
            retry: 1,
            refetchOnWindowFocus: true,
            // A NEAR view call that fails is usually one endpoint refusing,
            // and the RPC client has already walked the fallbacks by the time
            // react-query sees it. Retrying hard would just hammer them.
            retryDelay: 1_200,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <ToastProvider>{children}</ToastProvider>
      </WalletProvider>
    </QueryClientProvider>
  );
}
