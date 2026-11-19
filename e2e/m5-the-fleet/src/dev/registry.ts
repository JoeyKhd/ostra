// `pnpm dev:registry`: ticket 06's fake OCI registry on loopback until Ctrl-C, for the registry
// settings (F-120) and the snapshot pushes and pulls of a dev stack. It prints its push and pull
// credentials once, here, and keeps them nowhere; its seeded image is `ostra/base:seed`. Bearer
// auth, as Docker Hub and GHCR answer, unless `OSTRA_DEV_REGISTRY_AUTH=basic`. Development and test only.

import { startFakeOciRegistry } from "@ostra/adapter-sdk/testing/net";

import { devToolAllowed, portFrom, refuseOutsideDev, say, serveUntilStopped } from "./common.ts";

const main = async (): Promise<number> => {
  if (!devToolAllowed(process.env)) return refuseOutsideDev("The fake registry");
  const port = portFrom(process.env, "OSTRA_DEV_REGISTRY_PORT", 15_000);
  const auth = process.env["OSTRA_DEV_REGISTRY_AUTH"] ?? "bearer";
  if (port === null || (auth !== "bearer" && auth !== "basic")) {
    process.stderr.write("OSTRA_DEV_REGISTRY_PORT is a port number, and OSTRA_DEV_REGISTRY_AUTH is bearer or basic.\n");
    return 2;
  }
  const registry = await startFakeOciRegistry({ port, auth });
  say(`Fake OCI registry on ${registry.url} (loopback only, ${auth} auth). Set it in the panel as ${registry.host}.`);
  say(`  push credential: ${registry.push.username} / ${registry.push.password}`);
  say(`  pull credential: ${registry.pull.username} / ${registry.pull.password}`);
  say(`  seeded image:    ${registry.host}/${registry.seeded.name}@${registry.seeded.digest}`);
  return serveUntilStopped({ url: registry.url }, () => registry.close());
};

process.exitCode = await main();
