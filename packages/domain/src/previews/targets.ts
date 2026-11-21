import { appAddressName, portRefusal, previewKeyFor } from "@ostra/protocol";
import type { ExecutorKind, PreviewKey, PreviewListItem, PreviewTarget, ReservedPorts } from "@ostra/protocol";

import { fixedReservedPorts } from "./app-processes.ts";

// A task's previews, what a preview may reach, and the in-box addresses (milestone 8, F-140, F-141,
// ADR 0068). Pure: the environment's processes and services and the ports the agent announced go
// in, and the list, a reach decision or the address variables come out.

/** An app process as the preview list reads it. */
export type PreviewProcess = {
  readonly name: string;
  readonly port: number;
  readonly label: string;
  readonly primary: boolean;
  readonly position: number;
};

/** A service as the preview list reads it: one with a port and a preview label is a preview. */
export type PreviewService = { readonly name: string; readonly port: number | null; readonly previewLabel: string | null };

/** A port the agent announced in the task (`show_preview`). */
export type AnnouncedPreview = {
  readonly port: number;
  readonly label: string;
  readonly path: string;
  readonly primary: boolean;
};

/** The environment as the preview list reads it. */
export type PreviewEnvironment = {
  readonly processes: readonly PreviewProcess[];
  readonly services: readonly PreviewService[];
  /** Whether services run on this task's executor: `host` runs none (ADR 0029). */
  readonly servicesRun: boolean;
};

/**
 * The task's previews in order (ADR 0068): the primary first, then the app processes in the
 * list's order, then the services marked as previews, then the announced ports in the order they
 * came. An announced port a declared one already serves isn't listed twice, and a second primary
 * is listed as not primary: the environment's wins, then the first announced.
 */
export const previewTargets = (environment: PreviewEnvironment, announced: readonly AnnouncedPreview[]): readonly PreviewListItem[] => {
  const processes = [...environment.processes].sort((a, b) => a.position - b.position);
  const items: PreviewListItem[] = processes.map((process) => ({
    key: previewKeyFor({ process: process.name }),
    target: { process: process.name },
    port: process.port,
    label: process.label,
    primary: process.primary,
    path: "/",
    source: "declared",
  }));
  if (environment.servicesRun) {
    for (const service of environment.services) {
      if (service.port !== null && service.previewLabel !== null && service.port >= 1024) {
        items.push({
          key: previewKeyFor({ service: service.name }),
          target: { service: service.name },
          port: service.port,
          label: service.previewLabel,
          primary: false,
          path: "/",
          source: "declared",
        });
      }
    }
  }
  const taken = new Set(items.map((item) => item.port));
  for (const port of announced) {
    if (!taken.has(port.port) && port.port >= 1024) {
      taken.add(port.port);
      items.push({
        key: previewKeyFor({ port: port.port }),
        target: { port: port.port },
        port: port.port,
        label: port.label,
        primary: port.primary,
        path: port.path,
        source: "announced",
      });
    }
  }
  let primarySeen = false;
  const onePrimary = items.map((item) => {
    if (!item.primary) {
      return item;
    }
    if (primarySeen) {
      return { ...item, primary: false };
    }
    primarySeen = true;
    return item;
  });
  return [...onePrimary.filter((item) => item.primary), ...onePrimary.filter((item) => !item.primary)];
};

/** Why a port is refused as a preview's. */
export type ReachRefusal =
  | { readonly reason: "below-min" }
  | { readonly reason: "reserved"; readonly name: string }
  | { readonly reason: "not-a-preview" };

export type Reach = { readonly ok: true; readonly target: PreviewTarget; readonly key: PreviewKey } | { readonly ok: false; readonly refusal: ReachRefusal };

/**
 * Whether a view or a tunnel may reach `port` (ADR 0068, "What a preview may reach"): only a port
 * one of the task's previews serves, never below 1024, and never one of the box's own (the
 * sidecar's proxies and control API, the agent's loopback port, the browser's), however the list
 * came to hold it.
 */
export const mayReach = (port: number, targets: readonly PreviewListItem[], reserved: ReservedPorts): Reach => {
  const refused = portRefusal(port, reserved);
  if (refused !== null) {
    return { ok: false, refusal: refused };
  }
  const fixed = fixedReservedPorts.find((entry) => entry.port === port);
  if (fixed !== undefined) {
    return { ok: false, refusal: { reason: "reserved", name: fixed.name } };
  }
  const target = targets.find((item) => item.port === port);
  return target === undefined ? { ok: false, refusal: { reason: "not-a-preview" } } : { ok: true, target: target.target, key: target.key };
};

// ---------- the in-box addresses ----------

/** A service as the addresses read it. */
export type AddressService = { readonly name: string; readonly port: number | null };

/**
 * The variables each process gets (ADR 0068): `OSTRA_APP_<NAME>_URL` for every app process, at the
 * box's `localhost`, and `OSTRA_SERVICE_<NAME>_URL` for every service with a port, by its name on
 * `docker`'s box network and at `localhost` in a `kubernetes` pod; `host` runs no services. No
 * browser-facing URL: an inlined client variable can't point at both browsers.
 */
export const appAddresses = (
  processes: readonly { readonly name: string; readonly port: number }[],
  services: readonly AddressService[],
  executor: ExecutorKind,
): Readonly<Record<string, string>> => {
  const addresses: Record<string, string> = {};
  for (const process of processes) {
    addresses[appAddressName(process.name)] = `http://localhost:${String(process.port)}`;
  }
  for (const service of services) {
    if (service.port === null) {
      continue;
    }
    switch (executor) {
      case "docker":
        addresses[appAddressName(service.name, "service")] = `http://${service.name}:${String(service.port)}`;
        break;
      case "kubernetes":
        addresses[appAddressName(service.name, "service")] = `http://localhost:${String(service.port)}`;
        break;
      case "host":
        break;
      default:
        executor satisfies never;
    }
  }
  return addresses;
};
