import { notFound } from "next/navigation";

import { poolIdSchema } from "@ostra/protocol";

import { PoolView } from "@/components/runners/pool-view";
import { t } from "@/lib/messages";
import { fleetSettings } from "@/server/fleet-settings";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("runners.pool.metaTitle") };

/** A pool's page (ticket 30, pool.md): organization admins only; anyone else gets the not-found page. */
const PoolPage = async ({ params }: { readonly params: Promise<{ "pool-id": string }> }) => {
  const poolId = poolIdSchema.safeParse((await params)["pool-id"]);
  if (!poolId.success || !(await isAdmin())) notFound();
  return <PoolView key={poolId.data} poolId={poolId.data} settings={fleetSettings()} />;
};

export default PoolPage;
