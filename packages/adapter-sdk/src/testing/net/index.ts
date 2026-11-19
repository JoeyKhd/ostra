// @ostra/adapter-sdk/testing/net: the fleet's network seams (milestone 5, ticket 06), with no test
// runner in them, so the dev tools (ticket 36) start them as well as the tests: per-run
// certificates, the network proxies of spike 6, a fake OCI registry and a fake npm registry.
// Test and dev only.
export * from "./certs.ts";
export * from "./tar.ts";
export * from "./net-proxies.ts";
export * from "./fake-oci-registry.ts";
export * from "./oci-client.ts";
export * from "./fake-npm-registry.ts";
