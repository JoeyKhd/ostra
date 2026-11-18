import type { Tx } from "@ostra/db";
import { connectionIdSchema, repoFullNameSchema } from "@ostra/protocol";
import type { EnvironmentId, ProjectId, RepoId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-086: an admin creates a project with one repo linked through the organization's App, and its one
// environment as a draft (F-112 fills it from the repo's files). Its default code agent profile is
// the organization's built-in OpenCode profile. Written by ticket 32.

export const createProjectInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and inner hyphens"),
  access: z.enum(["open", "restricted"]).default("open"),
  repo: z.strictObject({
    connectionId: connectionIdSchema,
    installationId: z.string().min(1).max(64),
    fullName: repoFullNameSchema,
  }),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export type CreateProjectResult = UseCaseResult<
  { readonly projectId: ProjectId; readonly repoId: RepoId; readonly environmentId: EnvironmentId },
  "forbidden" | "slug-taken" | "repo-not-installed" | "no-agent-profile"
>;

export type CreateProjectDeps = Pick<Ports, "notices" | "audit" | "clock" | "adapters"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

export type CreateProject = (deps: CreateProjectDeps, input: CreateProjectInput) => Promise<CreateProjectResult>;

export const createProject: CreateProject = () => notImplemented("32");
