import type { HealthReport } from "@ostra/adapter-sdk";

// What the storage page needs of the blob store (F-114): its name and its health. The panel holds
// no blob bytes (core's blob service does, ADR 0043), so it holds this view and not the adapter.
export type BlobStoreView = {
  readonly name: "postgres" | "s3";
  readonly health: () => Promise<HealthReport>;
};
