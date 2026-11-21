import { networkInterfaces } from "node:os";

// This core process's address as the other core processes reach it (ADR 0068, Q305):
// `OSTRA_CORE_REPLICA_URL`, else the first non-loopback address and the port core listens on, over
// `http`. The Helm chart sets the pod's IP. On one machine with one core it's never used: a replica
// forwards only to another replica's address.

type Interfaces = ReturnType<typeof networkInterfaces>;

/** The default address: the first non-internal IPv4 address, else IPv6, else loopback. */
export const defaultReplicaUrl = (port: number, interfaces: Interfaces = networkInterfaces()): string => {
  const addresses = Object.values(interfaces).flatMap((list) => list ?? []);
  const external = addresses.filter((address) => !address.internal);
  const v4 = external.find((address) => address.family === "IPv4");
  if (v4 !== undefined) {
    return `http://${v4.address}:${String(port)}`;
  }
  const v6 = external.find((address) => address.family === "IPv6" && !address.address.startsWith("fe80"));
  return v6 === undefined ? `http://127.0.0.1:${String(port)}` : `http://[${v6.address}]:${String(port)}`;
};

/** The configured address without a trailing slash, or the default for `port`. */
export const replicaUrlFor = (configured: string | null, port: number): string => (configured === null ? defaultReplicaUrl(port) : configured.replace(/\/+$/, ""));
