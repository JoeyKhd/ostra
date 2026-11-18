// The box init's entry point, in the base image: `tini -- node /opt/ostra/init/main.ts`.
import { initEnvSchema, runInit } from "./init.ts";

await runInit(initEnvSchema.parse(process.env));
