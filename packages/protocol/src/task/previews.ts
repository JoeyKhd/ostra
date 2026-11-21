import { appAddressName } from "../agent/prompts.ts";
import type { ExecutorKind } from "../common.ts";
import type { PreviewListItem } from "../events/agent-events.ts";
import { portRefusal } from "../runner/limits.ts";
import type { ReservedPortName, ReservedPorts } from "../runner/limits.ts";
import { previewKeyFor } from "./app.ts";
import type { PreviewKey, PreviewTarget } from "./app.ts";

// A task's previews, what a preview may reach, and the in-box addresses (milestone 8, F-140,
// F-141, ADR 0068). Pure: the environment's processes and services and the ports the agent
// announced go in, and the list, a reach decision or the address variables come out. Here, beside
// the wire's words, so the runner (which sends `preview.list` and sets the addresses) and core
// (which checks a view against `mayReach`) apply the one rule: the runner may not import the
// domain (the license line, ADR 0045), and the domain re-exports these.

/**
 * Ports a box keeps for itself at a fixed number, refused for an app process when it's saved: the
 * sidecar's control API (the bridge) on `docker` and `kubernetes`. The box's other ports (the key,
 * git and MCP proxies, the agent's loopback and the browser's) are picked when the box starts, so
 * `mayReach` and the app tools refuse them by name then (`ReservedPorts`).
 */
export const fixedReservedPorts = [{ port: 7101, name: "sidecar-control" }] as const satisfies readonly {
  readonly port: number;
  readonly name: ReservedPortName;
}[];

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
 * Whether a port is one of the box's own (ADR 0068): below 1024, a reserved port by its name, or
 * one the box keeps at a fixed number, however `reserved` names it. `null`: it may be an app's.
 */
export const boxPortRefusal = (port: number, reserved: ReservedPorts): Exclude<ReachRefusal, { readonly reason: "not-a-preview" }> | null => {
  const refused = portRefusal(port, reserved);
  if (refused !== null) {
    return refused;
  }
  const fixed = fixedReservedPorts.find((entry) => entry.port === port);
  return fixed === undefined ? null : { reason: "reserved", name: fixed.name };
};

/**
 * Whether a view or a tunnel may reach `port` (ADR 0068, "What a preview may reach"): only a port
 * one of the task's previews serves, never below 1024, and never one of the box's own (the
 * sidecar's proxies and control API, the agent's loopback port, the browser's), however the list
 * came to hold it.
 */
export const mayReach = (port: number, targets: readonly PreviewListItem[], reserved: ReservedPorts): Reach => {
  const refused = boxPortRefusal(port, reserved);
  if (refused !== null) {
    return { ok: false, refusal: refused };
  }
  const target = targets.find((item) => item.port === port);
  return target === undefined ? { ok: false, refusal: { reason: "not-a-preview" } } : { ok: true, target: target.target, key: target.key };
};

// ---------- the in-box addresses ----------

/** A service as the addresses read it. */
export type AddressService = { readonly name: string; readonly port: number | null };

/**
 * A service's address in the box, by the executor (ADR 0068): by its name on `docker`'s box
 * network, at `localhost` in a `kubernetes` pod, whose containers share it. `host` runs no
 * services (ADR 0029, difference 1), so it has none; nor does a service with no port.
 */
export const inBoxServiceAddress = (service: AddressService, executor: ExecutorKind): string | null => {
  if (service.port === null) {
    return null;
  }
  switch (executor) {
    case "docker":
      return `http://${service.name}:${String(service.port)}`;
    case "kubernetes":
      return `http://localhost:${String(service.port)}`;
    case "host":
      return null;
    default:
      return executor satisfies never;
  }
};

/** An app process's address in the box: its port at the box's `localhost`, on every executor. */
export const inBoxAppAddress = (port: number): string => `http://localhost:${String(port)}`;

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
    addresses[appAddressName(process.name)] = inBoxAppAddress(process.port);
  }
  for (const service of services) {
    const address = inBoxServiceAddress(service, executor);
    if (address !== null) {
      addresses[appAddressName(service.name, "service")] = address;
    }
  }
  return addresses;
};
