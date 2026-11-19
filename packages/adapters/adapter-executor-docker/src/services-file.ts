import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { ServiceHealth } from "@ostra/adapter-sdk";
import { serviceNameSchema } from "@ostra/protocol";
import { z } from "zod";

// How a box's sidecar learns its services' health (F-094): the pool runner, which started them and
// can ask Docker, writes each one's outcome to a file in the box's token folder, which the sidecar
// mounts read-only at `/run/ostra`. The sidecar's executor waits for it before the setup script, and
// the task reports `service.healthy` or `service.failed`. ostra writes this file and reads it back,
// so its schema rejects unknown fields. It holds names, times and words: never a variable.

/** The file's name in the box's token folder. */
export const SERVICES_FILE = "services.json";
/** Where the sidecar reads it: the token folder's mount. */
export const SIDECAR_SERVICES_FILE = `/run/ostra/${SERVICES_FILE}`;

const serviceHealthSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ name: serviceNameSchema, outcome: z.literal("healthy"), afterMs: z.number().int().nonnegative() }),
  z.strictObject({ name: serviceNameSchema, outcome: z.literal("failed"), reason: z.string().max(2000) }),
]);

export const servicesFileSchema = z.strictObject({ services: z.array(serviceHealthSchema).max(64) });

/** The JSON the runner writes. */
export const servicesFileText = (services: readonly ServiceHealth[]): string => `${JSON.stringify(servicesFileSchema.parse({ services }))}\n`;

/** Writes the file in place at once: a reader never sees half of it. */
export const writeServicesFile = async (file: string, services: readonly ServiceHealth[], mode = 0o444): Promise<void> => {
  const staging = `${file}.next`;
  await rm(staging, { force: true });
  await writeFile(staging, servicesFileText(services), { mode, flag: "wx" });
  await rename(staging, file);
};

/**
 * Waits for the runner's file to name every service, then answers their health in the spec's
 * order. A service the file doesn't name by the deadline failed, with the reason ostra shows.
 */
export const awaitServicesFile = async (
  file: string,
  names: readonly string[],
  options: { readonly timeoutMs: number; readonly pollMs?: number; readonly signal?: AbortSignal | undefined },
): Promise<readonly ServiceHealth[]> => {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const text = await readFile(file, "utf8").catch(() => null);
    const parsed = text === null ? null : servicesFileSchema.safeParse(((): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })());
    const reported = parsed?.success === true ? parsed.data.services : [];
    const found = names.map((name) => reported.find((service) => service.name === name));
    if (found.every((service) => service !== undefined) || Date.now() >= deadline || options.signal?.aborted === true) {
      return names.map(
        (name, index) => found[index] ?? ({ name, outcome: "failed", reason: "The box's runner didn't report the service's health in time." } satisfies ServiceHealth),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
  }
};
