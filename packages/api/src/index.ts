// @ostra/api: the tRPC routers, the auth configuration and the live stream. `apps/web` serves them;
// `apps/core` imports `@ostra/api/auth` to check a device session with the same configuration.
export { appRouter } from "./routers/app-router.ts";
export type { AppRouter } from "./routers/app-router.ts";
export { createContext } from "./trpc/context.ts";
export type { ApiDeps, ApiSettings, Context, CreateContextInput } from "./trpc/context.ts";
export { createCallerFactory } from "./trpc/init.ts";
export { createCatalogSource } from "./catalog/catalog-source.ts";
export type { CatalogSource, CreateCatalogSourceInput } from "./catalog/catalog-source.ts";
export { createStreamHub } from "./stream/hub.ts";
export type { StreamHub, CreateStreamHubInput } from "./stream/hub.ts";
export { createApiRuntime } from "./runtime.ts";
export type { ApiRuntime, ApiRuntimeInput } from "./runtime.ts";
export { createModelsDevCatalogSource, MODELS_DEV_URL } from "./catalog/models-dev.ts";
export type { ModelsDevCatalogInput } from "./catalog/models-dev.ts";
