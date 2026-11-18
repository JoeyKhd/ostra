"use client";

import type { AppRouter } from "@ostra/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import type { TRPCClientErrorLike } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import type { ReactNode } from "react";

// tRPC 11 with TanStack Query 5 (ADR 0007). Queries and mutations go over batched HTTP;
// subscriptions over SSE (ADR 0035). Types come from `AppRouter`, never written again here.

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type ApiError = TRPCClientErrorLike<AppRouter>;

const endpoint = "/api/trpc";

const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 },
      mutations: { retry: false },
    },
  });

export const ApiProvider = ({ children }: { readonly children: ReactNode }) => {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === "subscription",
          true: httpSubscriptionLink({ url: endpoint }),
          false: httpBatchLink({ url: endpoint }),
        }),
      ],
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
};
