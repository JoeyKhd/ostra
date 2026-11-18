import { z } from "zod";

// GitHub's answers, as far as ostra reads them. GitHub owns these formats, so every object
// tolerates unknown fields (AGENTS.md, Code).

const permissionLevels = z.record(z.string(), z.string());

export const appSchema = z.looseObject({
  id: z.number().int(),
  slug: z.string().min(1),
  name: z.string(),
  permissions: permissionLevels.default({}),
  events: z.array(z.string()).default([]),
});

/** `POST /app-manifests/{code}/conversions`. */
export const conversionSchema = z.looseObject({
  id: z.number().int(),
  slug: z.string().min(1),
  name: z.string(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().nullish(),
  pem: z.string().min(1),
});

export const installationSchema = z.looseObject({
  id: z.number().int(),
  account: z
    .looseObject({ login: z.string().optional(), type: z.string().optional() })
    .nullish(),
  repository_selection: z.enum(["all", "selected"]),
});

export const repoSchema = z.looseObject({
  id: z.number().int(),
  full_name: z.string().min(1),
  default_branch: z.string().min(1),
  private: z.boolean(),
  clone_url: z.string().min(1),
});

export const branchSchema = z.looseObject({ default_branch: z.string().min(1) });

export const contentFileSchema = z.looseObject({
  type: z.literal("file"),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

export const treeSchema = z.looseObject({
  tree: z.array(z.looseObject({ path: z.string(), type: z.string() })),
  truncated: z.boolean().optional(),
});

export const userSchema = z.looseObject({ id: z.number().int(), login: z.string() });

export const pullRequestSchema = z.looseObject({
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullish(),
  title: z.string(),
  head: z.looseObject({ ref: z.string() }),
  base: z.looseObject({ ref: z.string() }),
});
export const pullRequestListSchema = z.array(pullRequestSchema);
