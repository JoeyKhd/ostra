import { redirect } from "next/navigation";

import { getServerApi } from "@/server/api";

type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/** The query a redirect keeps (`?connected=1`, `?error=…` from Linear's callback). */
const queryOf = (params: SearchParams): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const one of typeof value === "string" ? [value] : (value ?? [])) query.append(key, one);
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
};

/**
 * Organization › Linear's old address (F-152/c1, choice 13): Trackers replaced it in milestone 11.
 * It leads to the organization's first Linear connection's page, or to Trackers when there's none.
 */
const LinearPage = async ({ searchParams }: { readonly searchParams: Promise<SearchParams> }) => {
  const query = queryOf(await searchParams);
  const { caller, signedIn } = await getServerApi();
  const list = signedIn ? await caller.trackers.list().catch(() => null) : null;
  const first = list?.connections.find((connection) => connection.kind === "linear") ?? null;
  redirect(first === null ? `/organization/trackers${query}` : `/organization/trackers/${first.id}${query}`);
};

export default LinearPage;
